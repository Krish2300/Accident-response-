import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { AppError, ErrorCode, findSabarimalaPlace, nearestSabarimalaPlace, noopLogger, type Emergency, type Logger, type SpeechProvider, type TextToSpeechProvider } from '@resus/core';
import type { AutonomousOrchestrator, ClassificationResult } from '../orchestrator/autonomousOrchestrator.js';

/**
 * Web Call — Module 1 over the browser (WebRTC-style microphone call).
 *
 * Replaces the Asterisk + SIP-softphone leg for machines that cannot run a PBX
 * (e.g. Windows without WSL/Ubuntu). The browser captures the caller's voice
 * and either recognises it locally (Web Speech API) or uploads a WAV for the
 * configured Module 2 recogniser (whisper.cpp). Everything after the words are
 * known is the same pipeline the PBX path uses: Module 1 opens the call and the
 * emergency, Module 11 stores every transcript line, Module 5 decides each
 * instruction, and Module 10 drives dispatch.
 *
 * Calls are addressed by an unguessable id plus a bearer token issued on start,
 * so one caller cannot read or speak into another caller's call.
 */

export interface WebCallDeps {
  calls: {
    open(input: {
      incidentType?: string; severity?: string; latitude?: number; longitude?: number; description?: string | null;
      channel?: string; language?: string; isSimulation?: boolean; callerId?: string | null; actor?: { actorType?: string; actorId?: string | null };
    }): Promise<{ emergency: Emergency; session: { id: string } }>;
    close(callSessionId: string, reason?: string): Promise<unknown>;
  };
  transcripts: {
    appendTranscript(input: { callSessionId: string; emergencyId: string; speaker: string; text: string; isFinal?: boolean; confidence?: number | null }): Promise<unknown>;
  };
  sessions: {
    start(input: { emergencyId: string; incidentType?: string; startedBy?: string }): Promise<TurnLike>;
    handleUtterance(input: { sessionId: string; utterance: string }): Promise<TurnLike>;
  };
  emergencies: {
    findById(id: string): Promise<Emergency | null>;
    update(id: string, patch: { address?: string | null }): Promise<Emergency>;
  };
  ambulances: { findById(id: string): Promise<{ id: string; vehicleNumber: string; status: string; latitude: number | null; longitude: number | null } | null> };
  hospitals: { findById(id: string): Promise<{ id: string; name: string; latitude: number; longitude: number } | null> };
  routes: { routesForEmergency(emergencyId: string): Promise<Array<{ destinationName: string; estimatedMinutes: number | null; distanceKm: number; provider: string; polyline: Array<[number, number]> }>> };
  corridors?: { activeFor?(emergencyId: string): Promise<unknown> };
  orchestrator: Pick<AutonomousOrchestrator, 'classify' | 'recordClassification' | 'enabled'>;
  recognition: SpeechProvider;
  synthesis: TextToSpeechProvider;
  minConfidence: number;
  captureCallerLocation?: (emergencyId: string, locationText: string) => Promise<void>;
  defaultLocation: { latitude: number; longitude: number };
  logger?: Logger;
}

interface TurnLike {
  session: { id: string; emergencyId?: string; collectedFacts?: Record<string, unknown> };
  status: string;
  speech: string;
  tone: 'CALM' | 'URGENT' | 'REASSURING';
  paraphrased?: boolean;
}

interface WebCall {
  id: string;
  token: Buffer;
  language: string;
  latitude: number;
  longitude: number;
  locationSource: 'BROWSER_GPS' | 'CALLER_LANDMARK' | 'DEFAULT_SERVICE_AREA';
  landmark?: string;
  /** Telephone leg (Exotel helpline): the caller's number and the provider call id. */
  callerNumber?: string;
  channel: 'WEB' | 'PHONE';
  emergencyId?: string;
  callSessionId?: string;
  protocolSessionId?: string;
  classification?: ClassificationResult;
  terminal: boolean;
  ended: boolean;
  lastActivity: number;
  busy: Promise<unknown>;
}

export interface WebCallTurn {
  speech: string;
  tone: 'CALM' | 'URGENT' | 'REASSURING';
  terminal: boolean;
  heard?: string;
  emergencyId?: string;
  caseNumber?: string | null;
  classification?: ClassificationResult;
}

const GREETING = 'Emergency line. Tell me what happened, and where you are.';
const TERMINAL = new Set(['ESCALATED', 'COMPLETED', 'CANCELLED']);
const IDLE_EXPIRY_MS = 2 * 60 * 60_000;

export class WebCallService {
  private readonly calls = new Map<string, WebCall>();
  private readonly logger: Logger;

  constructor(private readonly deps: WebCallDeps) {
    this.logger = deps.logger ?? noopLogger;
  }

  start(input: { latitude?: number; longitude?: number; language?: string }): { callId: string; token: string; greeting: string; locationSource: string } {
    this.sweep();
    const hasGps = typeof input.latitude === 'number' && typeof input.longitude === 'number';
    const token = randomBytes(24);
    const call: WebCall = {
      id: randomUUID(),
      token,
      language: (input.language ?? 'en').slice(0, 8),
      latitude: hasGps ? input.latitude! : this.deps.defaultLocation.latitude,
      longitude: hasGps ? input.longitude! : this.deps.defaultLocation.longitude,
      locationSource: hasGps ? 'BROWSER_GPS' : 'DEFAULT_SERVICE_AREA',
      terminal: false,
      ended: false,
      lastActivity: Date.now(),
      busy: Promise.resolve(),
      channel: 'WEB',
    };
    this.calls.set(call.id, call);
    return { callId: call.id, token: token.toString('base64url'), greeting: GREETING, locationSource: call.locationSource };
  }

  /**
   * A call arriving on the dedicated helpline number (Exotel). There is no GPS
   * on a phone leg, so the caller is located from the landmark they name.
   */
  startPhone(input: { callerNumber: string | null; language?: string }): { callId: string; token: string; greeting: string } {
    const started = this.start({ language: input.language });
    const call = this.calls.get(started.callId)!;
    call.channel = 'PHONE';
    if (input.callerNumber) call.callerNumber = input.callerNumber.slice(0, 32);
    return { callId: started.callId, token: started.token, greeting: started.greeting };
  }

  /** True when the emergency was opened by a browser call handled here. */
  owns(emergencyId: string): boolean {
    for (const call of this.calls.values()) if (call.emergencyId === emergencyId) return true;
    return false;
  }

  /** One caller turn as text (browser speech recognition or typed). Turns are serialised per call. */
  async utterance(callId: string, token: string, text: string): Promise<WebCallTurn> {
    const call = this.authorise(callId, token);
    const run = call.busy.then(() => this.turn(call, text.trim()));
    call.busy = run.catch(() => undefined);
    return run;
  }

  /** One caller turn as audio (WAV), recognised by the configured Module 2 provider. */
  async audio(callId: string, token: string, audio: Uint8Array): Promise<WebCallTurn> {
    const call = this.authorise(callId, token);
    if (!this.deps.recognition.isLive) {
      throw new AppError(ErrorCode.PROVIDER_NOT_CONFIGURED,
        'Server speech recognition is not configured (SPEECH_PROVIDER=loopback). Use browser recognition or set SPEECH_PROVIDER=whisper.', 503);
    }
    const result = await this.deps.recognition.transcribe({
      callSessionId: call.callSessionId ?? call.id,
      emergencyId: call.emergencyId ?? 'pending',
      language: call.language,
      audio,
      isFinal: true,
    });
    const text = result.text.trim();
    if (text === '' || result.confidence < this.deps.minConfidence) {
      return { speech: 'Sorry, I did not catch that. Please say it again.', tone: 'CALM', terminal: false, heard: text };
    }
    const turn = await this.utterance(callId, token, text);
    return { ...turn, heard: text };
  }

  /** Server-side speech for the reply, when a real synthesiser (eSpeak NG) is configured. */
  async synthesize(callId: string, token: string, text: string): Promise<{ audio: Uint8Array; mimeType: string } | null> {
    this.authorise(callId, token);
    if (!this.deps.synthesis.isLive) return null;
    const result = await this.deps.synthesis.synthesize({ text: text.slice(0, 1200), language: 'en', tone: 'CALM', verbatimProtocolText: false });
    return { audio: result.audio, mimeType: result.mimeType };
  }

  async status(callId: string, token: string): Promise<Record<string, unknown>> {
    const call = this.authorise(callId, token);
    if (!call.emergencyId) return { stage: 'LISTENING', ended: call.ended };
    const emergency = await this.deps.emergencies.findById(call.emergencyId);
    if (!emergency) return { stage: 'UNKNOWN', ended: call.ended };
    const ambulance = emergency.assignedAmbulanceId ? await this.deps.ambulances.findById(emergency.assignedAmbulanceId) : null;
    const hospital = emergency.selectedHospitalId ? await this.deps.hospitals.findById(emergency.selectedHospitalId) : null;
    const routes = await this.deps.routes.routesForEmergency(emergency.id);
    const response = [...routes].reverse().find((route) => route.destinationName === 'SCENE');
    const transport = [...routes].reverse().find((route) => route.destinationName === 'HOSPITAL');
    return {
      stage: emergency.status,
      ended: call.ended || emergency.status === 'COMPLETED',
      emergencyId: emergency.id,
      caseNumber: emergency.caseNumber ?? null,
      incidentType: emergency.incidentType,
      severity: emergency.severity,
      location: { latitude: emergency.latitude, longitude: emergency.longitude, source: call.locationSource, landmark: call.landmark ?? null },
      classification: call.classification ?? null,
      ambulance: ambulance
        ? { vehicleNumber: ambulance.vehicleNumber, status: ambulance.status, latitude: ambulance.latitude, longitude: ambulance.longitude }
        : null,
      hospital: hospital ? { name: hospital.name, latitude: hospital.latitude, longitude: hospital.longitude } : null,
      responseRoute: response ? { etaMin: response.estimatedMinutes, distanceKm: response.distanceKm, provider: response.provider, polyline: response.polyline } : null,
      transportRoute: transport ? { etaMin: transport.estimatedMinutes, distanceKm: transport.distanceKm, provider: transport.provider, polyline: transport.polyline } : null,
    };
  }

  async hangup(callId: string, token: string): Promise<{ ended: true }> {
    const call = this.authorise(callId, token);
    if (!call.ended && call.callSessionId) {
      call.ended = true;
      try {
        await this.deps.calls.close(call.callSessionId, 'Caller hung up (web call).');
      } catch (error) {
        this.logger.debug({ callId, error: (error as Error).message }, 'web call already closed');
      }
    }
    call.ended = true;
    return { ended: true };
  }

  // ---------------------------------------------------------------------------

  private async turn(call: WebCall, text: string): Promise<WebCallTurn> {
    if (text === '') throw AppError.validation('Say or type what is happening.');
    if (call.ended) throw new AppError(ErrorCode.CONFLICT, 'This call has ended.', 409);
    call.lastActivity = Date.now();

    if (!call.emergencyId) return this.firstTurn(call, text);

    await this.persist(call, 'CALLER', text);
    if (call.terminal || !call.protocolSessionId) {
      const speech = 'Stay on the line. Help is on the way and a dispatcher can see this call.';
      await this.persist(call, 'SYSTEM', speech);
      return { speech, tone: 'REASSURING', terminal: call.terminal, emergencyId: call.emergencyId };
    }
    const turn = await this.advance(call, text);
    return { ...turn, emergencyId: call.emergencyId };
  }

  private async firstTurn(call: WebCall, text: string): Promise<WebCallTurn> {
    // Module 3 role: understand the description before the emergency is opened,
    // so Module 6/7 see the right incident type from the first event.
    const classification = await this.deps.orchestrator.classify(text);
    call.classification = classification;

    // No GPS (phone call, or location permission refused): place the caller at
    // the landmark they named, e.g. "near Appachimedu" or "അഴുത". A GPS fix is
    // labelled with the nearest landmark so officers can read it at a glance.
    if (call.locationSource !== 'BROWSER_GPS') {
      const match = findSabarimalaPlace(text);
      if (match) {
        call.latitude = match.place.latitude;
        call.longitude = match.place.longitude;
        call.locationSource = 'CALLER_LANDMARK';
        call.landmark = `${match.place.name} (${match.place.route.replace(/_/g, ' ').toLowerCase()})`;
      }
    } else {
      const nearest = nearestSabarimalaPlace(call.latitude, call.longitude);
      if (nearest.distanceKm <= 3) call.landmark = `near ${nearest.place.name} (${nearest.distanceKm.toFixed(1)} km)`;
    }

    const opened = await this.deps.calls.open({
      incidentType: classification.incidentType,
      severity: classification.severity,
      latitude: call.latitude,
      longitude: call.longitude,
      description: text.slice(0, 4000),
      channel: call.channel,
      callerId: call.callerNumber ?? null,
      language: call.language,
      isSimulation: false,
      actor: { actorType: 'CALLER', actorId: null },
    });
    call.emergencyId = opened.emergency.id;
    call.callSessionId = opened.session.id;
    const address = [call.landmark, call.locationSource === 'DEFAULT_SERVICE_AREA' ? 'LOCATION NOT YET KNOWN - default service-area point' : null]
      .filter(Boolean).join(' · ');
    if (address) await this.deps.emergencies.update(call.emergencyId, { address }).catch(() => undefined);
    await this.deps.transcripts.appendTranscript({ callSessionId: call.callSessionId, emergencyId: call.emergencyId, speaker: 'SYSTEM', text: GREETING, isFinal: true });
    await this.persist(call, 'CALLER', text);

    if (this.deps.orchestrator.enabled) {
      await this.deps.orchestrator.recordClassification(call.emergencyId, classification, text);
    }

    let started: TurnLike;
    try {
      started = await this.deps.sessions.start({ emergencyId: call.emergencyId, incidentType: classification.incidentType, startedBy: 'SYSTEM' });
    } catch (error) {
      this.logger.warn({ emergencyId: call.emergencyId, error: (error as Error).message }, 'no protocol for incident; using general triage');
      started = await this.deps.sessions.start({ emergencyId: call.emergencyId, incidentType: 'OTHER', startedBy: 'SYSTEM' });
    }
    call.protocolSessionId = started.session.id;
    call.terminal = TERMINAL.has(started.status);

    // The description is also the first answer: it often already says whether
    // the person is awake or breathing, which the protocol asks first.
    let turn: WebCallTurn;
    if (call.terminal) {
      turn = { speech: started.speech, tone: started.tone, terminal: true };
      await this.persist(call, 'SYSTEM', started.speech);
    } else {
      turn = await this.advance(call, text, started);
    }
    const lead = 'I am sending an ambulance now. ';
    return { ...turn, speech: lead + turn.speech, emergencyId: call.emergencyId, caseNumber: opened.emergency.caseNumber ?? null, classification };
  }

  private async advance(call: WebCall, text: string, fallback?: TurnLike): Promise<WebCallTurn> {
    let turn: TurnLike;
    try {
      turn = await this.deps.sessions.handleUtterance({ sessionId: call.protocolSessionId!, utterance: text });
    } catch (error) {
      this.logger.warn({ callId: call.id, error: (error as Error).message }, 'protocol turn failed');
      if (!fallback) {
        call.terminal = true;
        const speech = 'Stay on the line. A dispatcher is taking over this call.';
        await this.persist(call, 'SYSTEM', speech);
        return { speech, tone: 'REASSURING', terminal: true };
      }
      turn = fallback;
    }
    const location = turn.session.collectedFacts?.caller_location;
    if (typeof location === 'string' && call.emergencyId) {
      await this.deps.captureCallerLocation?.(call.emergencyId, location).catch(() => undefined);
    }
    call.terminal = TERMINAL.has(turn.status);
    await this.persist(call, 'SYSTEM', turn.speech);
    return { speech: turn.speech, tone: turn.tone, terminal: call.terminal };
  }

  private async persist(call: WebCall, speaker: 'CALLER' | 'SYSTEM', text: string): Promise<void> {
    if (!call.callSessionId || !call.emergencyId || text.trim() === '') return;
    try {
      await this.deps.transcripts.appendTranscript({ callSessionId: call.callSessionId, emergencyId: call.emergencyId, speaker, text, isFinal: true });
    } catch (error) {
      this.logger.error({ callId: call.id, speaker, error: (error as Error).message }, 'could not persist web call transcript');
    }
  }

  private authorise(callId: string, token: string): WebCall {
    const call = this.calls.get(callId);
    const supplied = Buffer.from(token ?? '', 'base64url');
    if (!call || supplied.length !== call.token.length || !timingSafeEqual(supplied, call.token)) {
      throw new AppError(ErrorCode.NOT_FOUND, 'Web call not found.', 404);
    }
    return call;
  }

  private sweep(): void {
    const cutoff = Date.now() - IDLE_EXPIRY_MS;
    for (const [id, call] of this.calls) if (call.lastActivity < cutoff) this.calls.delete(id);
  }
}
