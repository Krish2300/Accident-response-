import {
  AppError,
  ErrorCode,
  defineEvent,
  type CallSession,
  type Emergency,
  type EventPublisherPort,
  type Logger,
  type TelephonyProvider,
  type Transcript,
  noopLogger,
} from '@resus/core';
import type { Module1Config } from './config.js';

/**
 * Module 1 — emergency call intake and session lifecycle.
 *
 * Responsibilities
 * ----------------
 *   - open a call, creating the transport session and the `CallSession` row
 *   - attach it to an existing emergency, or create the emergency itself
 *   - close it exactly once, recording the duration
 *   - append caller and system utterances to the transcript
 *
 * What this module deliberately does not do
 * -----------------------------------------
 * It does not interpret speech (Module 2), extract facts (Module 3), decide
 * questions (Module 4), give guidance (Module 5) or drive the emergency
 * lifecycle (Module 10). It is the transport and bookkeeping layer, and it
 * reports what happened as events rather than calling anyone directly.
 *
 * Event ownership
 * ---------------
 * `CALL_STARTED` and `TRANSCRIPT_UPDATED` are emitted by the persistence layer
 * inside the same transaction as the row they describe, so that an incident
 * timeline can never show a session that was rolled back. This service
 * therefore emits only `CALL_CONNECTED`, `CALL_DISCONNECTED` and `CALL_FAILED` —
 * the facts the database layer cannot know — and deliberately does not re-emit
 * the other two, which would duplicate every call and every utterance in the log.
 *
 * Idempotency
 * -----------
 * `open` and `close` both tolerate being called twice for the same emergency: a
 * repeated open returns the session already in progress, and closing a session
 * that is already closed reports `closed: false` instead of ending it again. A
 * retried HTTP request or a replayed event therefore cannot produce two sessions
 * or two durations.
 */

// Module-local persistence shapes.
//
// These are declared structurally rather than imported from Module 11 so that
// Module 1 has no build-time dependency on the database module. Module 11's
// `CallSessionRecord` and `TranscriptRecord` satisfy these interfaces, so the
// composition root passes them straight through with no adapter.

export interface CallSessionStore {
  startSession(input: {
    emergencyId: string;
    channel?: string;
    callerId?: string | null;
    language?: string;
    isSimulation?: boolean;
  }): Promise<CallSession>;
  sessionById(id: string): Promise<CallSession | null>;
  /** Newest session for an emergency regardless of status. */
  requireSessionFor(emergencyId: string): Promise<CallSession>;
  /**
   * Every session still marked ACTIVE, across all emergencies.
   * Required by `enforceMaxDuration`, which has no emergency id to scope by.
   */
  activeSessions(): Promise<CallSession[]>;
  endSession(id: string): Promise<CallSession | null>;
  appendTranscript(input: {
    callSessionId: string;
    emergencyId: string;
    speaker: string;
    text: string;
    isFinal?: boolean;
    intent?: string | null;
    confidence?: number | null;
    isSimulation?: boolean;
  }): Promise<Transcript>;
  transcriptsFor(emergencyId: string): Promise<Transcript[]>;
}

export interface EmergencyStore {
  create(input: {
    incidentType: string;
    severity: string;
    latitude: number;
    longitude: number;
    description?: string | null;
    callerId?: string | null;
    isSimulation?: boolean;
    actor?: { actorType?: string; actorId?: string | null };
  }): Promise<Emergency>;
  requireById(id: string): Promise<Emergency>;
}

export interface OpenCallInput {
  /** Attach to an existing emergency instead of creating one. */
  emergencyId?: string;
  incidentType?: string;
  severity?: string;
  latitude?: number;
  longitude?: number;
  description?: string | null;
  callerId?: string | null;
  channel?: string;
  language?: string;
  isSimulation?: boolean;
  actor?: { actorType?: string; actorId?: string | null };
}

export interface OpenCallResult {
  emergency: Emergency;
  session: CallSession;
  /** False when the transport is a development adapter. */
  isLiveTransport: boolean;
  provider: string;
  transport: string;
  /** True when an already-open session was returned instead of a new one. */
  reused: boolean;
}

export interface CloseCallResult {
  session: CallSession;
  durationMs: number;
  /** True when this call performed the close rather than observing it done. */
  closed: boolean;
}

export interface CallServiceDeps {
  config: Module1Config;
  telephony: TelephonyProvider;
  emergencies: EmergencyStore;
  calls: CallSessionStore;
  events: EventPublisherPort;
  logger?: Logger;
}

export class CallService {
  private readonly logger: Logger;

  constructor(private readonly deps: CallServiceDeps) {
    this.logger = deps.logger ?? noopLogger;
  }

  /**
   * Opens a call.
   *
   * The emergency is created first (when not supplied) because a call session
   * must belong to one: `CallSession.emergencyId` is mandatory, and a session
   * without an emergency would be a transcript nothing can be attached to during
   * an incident review.
   */
  async open(input: OpenCallInput): Promise<OpenCallResult> {
    const language = normaliseLanguage(input.language ?? this.deps.config.telephony.defaultLanguage);

    if (input.emergencyId) {
      const emergency = await this.deps.emergencies.requireById(input.emergencyId);
      const active = await this.activeSession(emergency.id);
      if (active) {
        this.logger.debug(
          { emergencyId: emergency.id, callSessionId: active.id },
          'reusing already-active call session',
        );
        return {
          emergency,
          session: active,
          isLiveTransport: this.deps.telephony.isLive,
          provider: this.deps.telephony.providerName,
          transport: active.channel,
          reused: true,
        };
      }
      return this.startFor(emergency, input, language);
    }

    if (input.latitude === undefined || input.longitude === undefined) {
      throw AppError.validation(
        'A new emergency needs a latitude and longitude. Pass `emergencyId` to attach the call to an emergency that already has a location.',
      );
    }

    const emergency = await this.deps.emergencies.create({
      incidentType: input.incidentType ?? 'OTHER',
      severity: input.severity ?? 'MEDIUM',
      latitude: input.latitude,
      longitude: input.longitude,
      description: input.description ?? null,
      callerId: input.callerId ?? null,
      isSimulation: input.isSimulation ?? false,
      actor: input.actor,
    });

    return this.startFor(emergency, input, language);
  }

  private async startFor(
    emergency: Emergency,
    input: OpenCallInput,
    language: string,
  ): Promise<OpenCallResult> {
    // The transport session is opened first: if the carrier rejects the call we
    // must not leave a `CallSession` row claiming a call is in progress.
    const handle = await this.originate(input);

    // `startSession` emits CALL_STARTED inside its own transaction.
    const session = await this.deps.calls.startSession({
      emergencyId: emergency.id,
      channel: input.channel ?? handle.transport,
      callerId: input.callerId ?? null,
      language,
      isSimulation: input.isSimulation ?? emergency.isSimulation,
    });

    await this.deps.events.record(
      defineEvent('CALL_CONNECTED', {
        emergencyId: emergency.id,
        entityType: 'call_session',
        entityId: session.id,
        actorType: input.actor?.actorType ?? 'CALLER',
        payload: {
          callSessionId: session.id,
          emergencyId: emergency.id,
          channel: session.channel,
          provider: handle.providerName,
          transport: handle.transport,
          callerId: session.callerId,
          isLiveTransport: handle.isLive,
        },
      }),
      { emergencyId: emergency.id },
    );

    this.logger.info(
      {
        emergencyId: emergency.id,
        callSessionId: session.id,
        transport: handle.transport,
        provider: handle.providerName,
        isLiveTransport: handle.isLive,
        language,
      },
      'emergency call opened',
    );

    return {
      emergency,
      session,
      isLiveTransport: handle.isLive,
      provider: handle.providerName,
      transport: handle.transport,
      reused: false,
    };
  }

  /**
   * Closes a call.
   *
   * Provider hangup is attempted first and its failure is logged but not
   * propagated: the local session must be closed even if the carrier is already
   * gone, because leaving `CallSession.status = ACTIVE` forever would make every
   * later "is this call still live?" check wrong.
   */
  async close(callSessionId: string, reason = 'Call ended.'): Promise<CloseCallResult> {
    const session = await this.deps.calls.sessionById(callSessionId);
    if (!session) {
      throw new AppError(ErrorCode.CALL_NOT_FOUND, `Call session '${callSessionId}' was not found.`, 404, {
        callSessionId,
      });
    }

    if (session.status !== 'ACTIVE') {
      return { session, durationMs: durationMsOf(session), closed: false };
    }

    try {
      await this.deps.telephony.hangup(callSessionId, reason);
    } catch (error) {
      this.logger.warn(
        { callSessionId, reason: (error as Error).message },
        'transport hangup failed; closing the local session anyway',
      );
    }

    const ended = await this.deps.calls.endSession(callSessionId);
    const finalSession = ended ?? session;
    const durationMs = durationMsOf(finalSession);

    await this.deps.events.record(
      defineEvent('CALL_DISCONNECTED', {
        emergencyId: finalSession.emergencyId,
        entityType: 'call_session',
        entityId: callSessionId,
        payload: { callSessionId, emergencyId: finalSession.emergencyId, durationMs, reason },
      }),
      { emergencyId: finalSession.emergencyId },
    );

    this.logger.info(
      { callSessionId, emergencyId: finalSession.emergencyId, durationMs },
      'emergency call closed',
    );

    return { session: finalSession, durationMs, closed: true };
  }

  /** Records what was said. Wording interpretation belongs to Module 3. */
  async recordUtterance(input: {
    callSessionId: string;
    speaker: string;
    text: string;
    isFinal?: boolean;
    intent?: string | null;
    confidence?: number | null;
  }): Promise<Transcript> {
    const session = await this.deps.calls.sessionById(input.callSessionId);
    if (!session) {
      throw new AppError(ErrorCode.CALL_NOT_FOUND, `Call session '${input.callSessionId}' was not found.`, 404);
    }
    if (session.status !== 'ACTIVE') {
      throw new AppError(
        ErrorCode.CONVERSATION_CLOSED,
        `Call session '${input.callSessionId}' has ended and cannot accept more speech.`,
        409,
        { callSessionId: input.callSessionId, status: session.status },
      );
    }

    // `appendTranscript` emits TRANSCRIPT_UPDATED and assigns `sequence`
    // atomically; this service must not emit a second copy of that event.
    return this.deps.calls.appendTranscript({
      callSessionId: input.callSessionId,
      emergencyId: session.emergencyId,
      speaker: input.speaker,
      text: input.text,
      isFinal: input.isFinal ?? true,
      intent: input.intent ?? null,
      confidence: input.confidence ?? null,
      isSimulation: session.isSimulation,
    });
  }

  /**
   * Ends any call still open on an emergency.
   *
   * Called when the emergency reaches a terminal state, so a caller is never left
   * connected to a line nobody is listening to. Safe to call more than once.
   */
  async closeForEmergency(emergencyId: string, reason: string): Promise<CloseCallResult | null> {
    const session = await this.activeSession(emergencyId);
    if (!session) return null;
    return this.close(session.id, reason);
  }

  /**
   * Ends any call that has exceeded the configured maximum duration.
   *
   * A deployment runs this on a timer. It is a method rather than a timer here
   * so Module 10 can schedule it and tests can drive it without waiting on a
   * clock. Only sessions that are still ACTIVE and genuinely over the limit are
   * closed, so the call is never dropped early because of clock skew.
   */
  async enforceMaxDuration(now: Date = new Date()): Promise<CloseCallResult[]> {
    const limitMs = this.deps.config.telephony.maxCallDurationMinutes * 60_000;
    const closed: CloseCallResult[] = [];

    for (const session of await this.deps.calls.activeSessions()) {
      const elapsed = now.getTime() - new Date(session.startedAt).getTime();
      if (elapsed < limitMs) continue;
      const result = await this.close(session.id, 'Maximum call duration reached.');
      if (result.closed) closed.push(result);
    }

    if (closed.length > 0) {
      this.logger.warn(
        { count: closed.length, maxCallDurationMinutes: this.deps.config.telephony.maxCallDurationMinutes },
        'closed call(s) that exceeded the maximum duration',
      );
    }
    return closed;
  }

  async transcript(emergencyId: string): Promise<Transcript[]> {
    return this.deps.calls.transcriptsFor(emergencyId);
  }

  async currentSession(emergencyId: string): Promise<CallSession> {
    const session = await this.activeSession(emergencyId);
    if (session) return session;
    return this.deps.calls.requireSessionFor(emergencyId);
  }

  /** Reports the transport for the health endpoint. */
  async transportStatus(): Promise<{
    provider: string;
    isLive: boolean;
    reachable: boolean;
    detail: string;
  }> {
    try {
      const probe = await this.deps.telephony.probe();
      return {
        provider: this.deps.telephony.providerName,
        isLive: this.deps.telephony.isLive,
        reachable: probe.reachable,
        detail: probe.detail,
      };
    } catch (error) {
      return {
        provider: this.deps.telephony.providerName,
        isLive: this.deps.telephony.isLive,
        reachable: false,
        detail: (error as Error).message,
      };
    }
  }

  /** True when the configured transport is real. Used by the health endpoint. */
  get isLiveTransport(): boolean {
    return this.deps.telephony.isLive;
  }

  // -- internals --------------------------------------------------------------

  private async originate(input: OpenCallInput) {
    try {
      return await this.deps.telephony.originate({
        callerId: input.callerId ?? null,
        channel: input.channel,
        language: input.language,
      });
    } catch (error) {
      // Recorded before being rethrown so a failed attempt appears in the
      // timeline, not only in the server log.
      if (input.emergencyId) {
        await this.deps.events
          .record(
            defineEvent('CALL_FAILED', {
              emergencyId: input.emergencyId,
              payload: {
                emergencyId: input.emergencyId,
                provider: this.deps.telephony.providerName,
                reason: (error as Error).message,
                fallback: null,
              },
            }),
            { emergencyId: input.emergencyId },
          )
          .catch((recordError: unknown) => {
            this.logger.error({ reason: (recordError as Error).message }, 'could not record CALL_FAILED');
          });
      }
      throw new AppError(
        ErrorCode.PROVIDER_UNAVAILABLE,
        `The call transport '${this.deps.telephony.providerName}' could not establish the call: ${(error as Error).message}`,
        503,
        { provider: this.deps.telephony.providerName },
      );
    }
  }

  /**
   * The newest session for an emergency when that session is still open, else
   * null. `requireSessionFor` returns the newest row regardless of status, so the
   * status check has to happen here rather than being assumed.
   */
  private async activeSession(emergencyId: string): Promise<CallSession | null> {
    try {
      const session = await this.deps.calls.requireSessionFor(emergencyId);
      return session.status === 'ACTIVE' ? session : null;
    } catch {
      return null;
    }
  }
}

/** `en-IN`/`en_US`/`EN` all normalise to `en`, matching how transcripts are stored. */
function normaliseLanguage(language: string): string {
  const base = language.trim().toLowerCase().split(/[-_]/)[0] ?? '';
  return base === '' ? 'en' : base;
}

/** Milliseconds from start to end, computed directly to keep sub-minute precision. */
function durationMsOf(session: CallSession): number {
  if (!session.endedAt) return 0;
  return Math.max(0, new Date(session.endedAt).getTime() - new Date(session.startedAt).getTime());
}