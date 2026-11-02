import {
  noopLogger,
  type AudioSegmentDiagnostics,
  type CallSession,
  type Logger,
  type TranscriptSpeaker,
} from '@resus/core';
import { performance } from 'node:perf_hooks';
import type { AsteriskCallRegistry } from '../asteriskProvider.js';
import { AudioSocketServer, type AudioFrame, type AudioSocketSession } from './audioSocket.js';

/**
 * Media bridge: Asterisk's AudioSocket <-> Module 2's speech pipeline.
 *
 * What it does
 * ------------
 *   - caller PCM -> voice activity detection -> `transcribe()` as a final
 *     utterance, so what the caller actually said reaches the transcript record;
 *   - the configured intake greeting -> `speak()` -> the caller's ear, which is
 *     the system-to-caller half of the call.
 *
 * What it deliberately does not do
 * --------------------------------
 * It never invents text, never answers a clinical question and never decides
 * what the system should say next: the spoken greeting is a configured line, not
 * a protocol step, and it is recorded as non-verbatim for that reason. Question
 * selection belongs to the protocol engine, not to a transport bridge.
 *
 * Format
 * ------
 * AudioSocket carries signed-linear mono PCM. The dialplan in
 * `docs/asterisk-setup.md` keeps the channel at 8 kHz (PCMU/PCMA), so that is the
 * format assumed end to end. A frame at another rate is logged rather than
 * silently misread, because mistaking 16 kHz samples for 8 kHz makes speech
 * transcribe as chipmunk noise — a failure that would otherwise look like a bad
 * recogniser rather than a mislabelled format.
 *
 * Dependencies are structural
 * ---------------------------
 * Speech and persistence are declared as local interfaces rather than imported
 * from their modules, so the telephony transport does not acquire a build
 * dependency on Module 2. The composition root passes real instances, which
 * satisfy both shapes.
 */

const BYTES_PER_MS_AT_8K = 16; // 8000 samples/s * 2 bytes/sample / 1000
const EXPECTED_SAMPLE_RATE = 8000;
const MAX_SYNTHETIC_DIAGNOSTIC_SEGMENTS_PER_CALL = 64;
const MAX_SYNTHETIC_TIMING_MARKERS_PER_CALL = 64;

export type SyntheticSpeechTimingMarker = 'speech-start' | 'speech-end';
export interface SyntheticTimingMarkerReceipt {
  accepted: boolean;
  reason?: 'no-active-audio-stream' | 'invalid-order' | 'duplicate' | 'limit-reached';
  callRelativeMs?: number;
}

export interface AudioBridgeCallStore {
  sessionById(id: string): Promise<CallSession | null>;
}

export interface AudioBridgeSpeechPort {
  transcribe(input: {
    callSessionId: string;
    emergencyId: string;
    audio: Uint8Array;
    language?: string;
    speaker?: TranscriptSpeaker;
    isFinal?: boolean;
    diagnosticScope?: 'synthetic-test';
    segmentDiagnostics?: AudioSegmentDiagnostics;
  }): Promise<{
    text: string;
    confidence: number;
    accepted: boolean;
    band: string;
    persisted: unknown | null;
  }>;
  speak(input: {
    text: string;
    language: string;
    tone: 'CALM' | 'URGENT' | 'REASSURING';
    verbatimProtocolText: boolean;
    emergencyId?: string | null;
    callSessionId?: string | null;
  }): Promise<{
    audio: Uint8Array;
    mimeType: string;
    provider: string;
    isAudible: boolean;
    voice: string;
    durationMs: number | null;
  }>;
}

/**
 * What the conversation wants said next.
 *
 * The bridge does not interpret this: it speaks `speech` with `tone` and stops
 * asking for more turns once `terminal` is set. `verbatimProtocolText` travels
 * straight to Module 2 so the transcript records whether the caller heard the
 * protocol's own wording or a paraphrase of it.
 */
export interface ConversationTurn {
  speech: string;
  tone: 'CALM' | 'URGENT' | 'REASSURING';
  verbatimProtocolText: boolean;
  terminal: boolean;
  /**
   * Stable identifier of the protocol question this turn asked, when it asked one.
   *
   * Optional and opaque to the bridge: it is carried so a caller-silence event can
   * name the question that went unanswered without the bridge interpreting any
   * clinical content.
   */
  questionId?: string | null;
}

/**
 * Optional conversation collaborator.
 *
 * The bridge stays transport-only: it asks this port what to say when a call
 * connects and after every final caller utterance, then speaks whatever comes
 * back over the same socket. The implementation (in the composition root, over
 * Module 5) owns the protocol session and the SYSTEM side of the transcript; it
 * never touches the socket or the audio format.
 *
 * Returning `null` means "say nothing" — on connect that falls back to the
 * configured greeting; on an utterance it leaves the caller in silence, which is
 * the honest outcome when there is no protocol step to give them.
 */
export interface AudioBridgeConversationPort {
  onCallConnected(input: {
    callSessionId: string;
    emergencyId: string;
    language: string;
  }): Promise<ConversationTurn | null>;
  onCallerUtterance(input: {
    callSessionId: string;
    emergencyId: string;
    language: string;
    text: string;
  }): Promise<ConversationTurn | null>;
  /**
   * Optional: the caller has been silent since the last prompt.
   *
   * Called only when the bridge is configured with a positive `silenceTimeoutMs`
   * and only while a non-terminal turn is outstanding. Returning a turn makes the
   * bridge speak it (normally the protocol's current instruction, repeated);
   * returning `null` means "stop prompting" and the bridge arms no further timer.
   *
   * The bridge owns the timing; the conversation owns the words. A re-prompt is
   * therefore never composed here — it is replayed by the conversation.
   */
  onCallerSilence?(input: {
    callSessionId: string;
    emergencyId: string;
    language: string;
  }): Promise<ConversationTurn | null>;
  /**
   * Optional: releases any per-call bookkeeping the conversation holds.
   *
   * Called once the stream has ended, so an implementation that caches the
   * protocol session per call does not leak it. Optional because a stateless
   * implementation has nothing to release.
   */
  forget?(callSessionId: string): void;
}

export interface AudioBridgeConfig {
  /**
   * Spoken when the call connects, when no conversation port is configured or
   * when it has no protocol step to offer. Empty text means no greeting is played.
   */
  greeting: string;
  greetingTone: 'CALM' | 'URGENT' | 'REASSURING';
  bindHost: string;
  bindPort: number;
  /** Root-mean-square level at or above which samples count as speech. */
  speechRmsThreshold: number;
  /** Silence duration that closes an utterance. */
  hangoverMs: number;
  /** Utterances shorter than this are treated as noise and dropped. */
  minUtteranceMs: number;
  /** Hard cap; a long stretch of speech is force-finalised rather than buffered forever. */
  maxUtteranceMs: number;
  /**
   * How long to wait for this stream's UUID to resolve to a live `CallSession`
   * before giving up.
   *
   * Two races are covered by the one deadline. The dialplan sets the UUID and
   * then opens AudioSocket, so the TCP connection can win the race against the
   * manager event; and `CallService.open()` registers the channel with the
   * provider before it has written the `CallSession` row, so the binding can be
   * known while the row still is not. Audio received while either is pending is
   * queued, not thrown away, for exactly this reason.
   */
  resolveTimeoutMs: number;
  /**
   * How long the caller may stay silent after a prompt before the bridge asks the
   * conversation to repeat it.
   *
   * `0` or absent disables silence handling entirely, leaving the previous
   * behaviour unchanged. Only consulted when the conversation port implements
   * `onCallerSilence`.
   */
  silenceTimeoutMs?: number;
}

export interface AudioBridgeDeps {
  provider: AsteriskCallRegistry;
  /** Module 2's speech service, typed through the bridge's structural port. */
  speech: AudioBridgeSpeechPort;
  /**
   * Optional Module 5 conversation, typed through a structural port.
   *
   * When present, the live call runs a stateful protocol: the first instruction
   * replaces the greeting, and each caller utterance produces the next one. When
   * absent the bridge behaves exactly as before — greeting only.
   */
  conversation?: AudioBridgeConversationPort;
  calls: AudioBridgeCallStore;
  config: AudioBridgeConfig;
  logger?: Logger;
  /** Injectable monotonic clock for deterministic diagnostic tests. */
  monotonicNow?: () => number;
}

interface ConnectionState {
  uuid: string;
  remote: string;
  callSessionId: string | null;
  emergencyId: string | null;
  /** Frames held while the call session is still being resolved. */
  queue: Buffer[];
  state: 'resolving' | 'active' | 'closed';
  utterance: Buffer[];
  utteranceMs: number;
  utteranceFrameCount: number;
  utteranceFrameBytes: number[];
  utteranceSampleRates: Set<number>;
  segmentSequence: number;
  diagnosticSegmentCount: number;
  isSimulation: boolean;
  activeSegment: ActiveSegment | null;
  trailingSilenceMs: number;
  trailingSilenceFrameCount: number;
  inSpeech: boolean;
  warnedRate: boolean;
  /** Pending caller-silence timer, or null when none is armed. */
  silenceTimer: ReturnType<typeof setTimeout> | null;
  /** True while a non-terminal prompt is the last thing the caller heard. */
  promptOutstanding: boolean;
  monotonicOriginMs: number | null;
  timingMarkerCount: number;
  completedPromptCount: number;
  promptOpen: boolean;
  speechStarted: boolean;
  speechEnded: boolean;
  timingSequence: number;
}

interface ActiveSegment {
  segmentId: string;
  startedAtMs: number;
  startedAtMonotonicMs: number;
  diagnosticEnabled: boolean;
  frameCount: number;
  frameRmsMin: number;
  frameRmsMax: number;
  frameRmsSum: number;
  frameRmsAboveThreshold: number;
  framePeakMin: number;
  framePeakMax: number;
  framePeakSum: number;
}

export class AudioBridge {
  private readonly logger: Logger;
  private readonly server: AudioSocketServer;
  private readonly connections = new Map<string, ConnectionState>();
  private readonly monotonicNow: () => number;

  constructor(private readonly deps: AudioBridgeDeps) {
    this.logger = deps.logger ?? noopLogger;
    this.monotonicNow = deps.monotonicNow ?? (() => performance.now());
    const { bindHost, bindPort } = deps.config;
    this.server = new AudioSocketServer({
      host: bindHost,
      port: bindPort,
      logger: this.logger,
      onConnect: (session) => this.onConnect(session),
      onAudio: (session, frame) => this.onAudio(session, frame),
      onDtmf: (session, digit) => this.onDtmf(session, digit),
      onError: (session, code) => {
        this.logger.warn({ uuid: session.uuid, code }, 'Asterisk reported an AudioSocket error');
      },
      onClose: (session) => this.onClose(session),
    });
  }

  async start(): Promise<{ host: string; port: number }> {
    const address = await this.server.listen();
    this.logger.info(
      { greeting: this.deps.config.greeting !== '' },
      'audio bridge listening for Asterisk media',
    );
    return address;
  }

  async stop(): Promise<void> {
    // Mark every stream closed before dropping them, so any transcription or
    // synthesis still in flight sees a closed connection and stops rather than
    // writing to the socket or advancing a protocol during shutdown. A pending
    // silence timer is cleared for the same reason: a re-prompt must never fire
    // into a bridge that is shutting down.
    for (const connection of this.connections.values()) {
      connection.state = 'closed';
      this.clearSilenceTimer(connection);
    }
    this.connections.clear();
    await this.server.close();
  }

  /** Number of Asterisk channels currently streaming media. */
  get activeConnections(): number {
    return this.connections.size;
  }

  /** Records operator input on the server clock shared by all call diagnostics. */
  recordSyntheticSpeechMarker(callSessionId: string, marker: SyntheticSpeechTimingMarker): SyntheticTimingMarkerReceipt {
    const connection = [...this.connections.values()].find((item) => item.callSessionId === callSessionId);
    if (!connection || connection.state !== 'active' || !connection.isSimulation || connection.monotonicOriginMs === null) {
      return { accepted: false, reason: 'no-active-audio-stream' };
    }
    if (connection.timingMarkerCount >= MAX_SYNTHETIC_TIMING_MARKERS_PER_CALL) {
      return { accepted: false, reason: 'limit-reached' };
    }
    if (marker === 'speech-start') {
      if (connection.speechStarted || connection.speechEnded) {
        return { accepted: false, reason: 'duplicate' };
      }
      if (connection.completedPromptCount < 1 || connection.promptOpen) {
        return { accepted: false, reason: 'invalid-order' };
      }
      connection.speechStarted = true;
    } else {
      if (connection.speechEnded) return { accepted: false, reason: 'duplicate' };
      if (!connection.speechStarted) return { accepted: false, reason: 'invalid-order' };
      connection.speechEnded = true;
    }
    return this.recordTimingMarker(connection, marker);
  }

  // -- lifecycle --------------------------------------------------------------

  private onConnect(session: AudioSocketSession): void {
    const connection: ConnectionState = {
      uuid: session.uuid,
      remote: session.remote,
      callSessionId: null,
      emergencyId: null,
      queue: [],
      state: 'resolving',
      utterance: [],
      utteranceMs: 0,
      utteranceFrameCount: 0,
      utteranceFrameBytes: [],
      utteranceSampleRates: new Set(),
      segmentSequence: 0,
      diagnosticSegmentCount: 0,
      isSimulation: false,
      activeSegment: null,
      trailingSilenceMs: 0,
      trailingSilenceFrameCount: 0,
      inSpeech: false,
      warnedRate: false,
      silenceTimer: null,
      promptOutstanding: false,
      monotonicOriginMs: null,
      timingMarkerCount: 0,
      completedPromptCount: 0,
      promptOpen: false,
      speechStarted: false,
      speechEnded: false,
      timingSequence: 0,
    };
    this.connections.set(session.uuid, connection);

    void this.attach(connection, session);
  }

  private async attach(connection: ConnectionState, session: AudioSocketSession): Promise<void> {
    const deadline = Date.now() + this.deps.config.resolveTimeoutMs;

    const callSessionId = await this.resolveCallSession(connection.uuid, deadline);
    if (!callSessionId) {
      this.logger.warn(
        { uuid: connection.uuid },
        'an Asterisk media stream arrived but no call session was bound to it; dropping the stream',
      );
      connection.state = 'closed';
      this.connections.delete(connection.uuid);
      session.sendHangup();
      return;
    }

    const record = await this.waitForSession(callSessionId, deadline);
    if (!record || record.status !== 'ACTIVE') {
      this.logger.warn(
        { uuid: connection.uuid, callSessionId, status: record?.status ?? 'missing' },
        'an Asterisk media stream bound to a call session that is not active; dropping the stream',
      );
      connection.state = 'closed';
      this.connections.delete(connection.uuid);
      session.sendHangup();
      return;
    }

    connection.callSessionId = callSessionId;
    connection.emergencyId = record.emergencyId;
    connection.isSimulation = record.isSimulation;
    connection.state = 'active';
    connection.monotonicOriginMs = this.monotonicNow();

    this.logger.info(
      { uuid: connection.uuid, callSessionId, emergencyId: record.emergencyId, remote: connection.remote },
      'Asterisk media stream bound to a call session',
    );

    // Flush audio that arrived before the manager event completed the binding.
    const queued = connection.queue;
    connection.queue = [];
    for (const frame of queued) this.processFrame(session, connection, frame, EXPECTED_SAMPLE_RATE);

    await this.beginConversation(session, connection, record);
  }

  /**
   * Polls the provider for the UUID binding.
   *
   * Polling rather than an event subscription because the provider is already
   * the authority on the map and a short, bounded wait is simpler than wiring a
   * second event path for a race that only exists for a few milliseconds.
   */
  private async resolveCallSession(uuid: string, deadline: number): Promise<string | null> {
    for (;;) {
      const found = this.deps.provider.callSessionIdForUuid(uuid);
      if (found) return found;
      if (Date.now() >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /**
   * Waits for the `CallSession` row the binding points at.
   *
   * `CallService.open()` registers the channel with the provider before it has
   * written the row, so the binding is known a moment before the session exists.
   * Reading the row once at that point drops a call that is being opened
   * correctly, and Asterisk hangs the leg up while it is still being answered.
   * The row is therefore waited for inside the same deadline as the binding.
   *
   * An existing row is returned straight away whatever its status: the caller
   * checks `ACTIVE`, and polling a closed session would only delay reporting
   * that the call already ended.
   */
  private async waitForSession(callSessionId: string, deadline: number): Promise<CallSession | null> {
    for (;;) {
      const record = await this.deps.calls.sessionById(callSessionId);
      if (record) return record;
      if (Date.now() >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  private async playGreeting(
    session: AudioSocketSession,
    connection: ConnectionState,
    record: CallSession,
  ): Promise<void> {
    const greeting = this.deps.config.greeting.trim();
    if (greeting === '') return;
    if (!connection.callSessionId || !connection.emergencyId) return;
    // The line may have dropped between the binding and this call; a greeting
    // synthesised for a dead socket is never played.
    if (this.isStreamClosed(connection)) return;

    try {
      const spoken = await this.deps.speech.speak({
        text: greeting,
        language: record.language,
        tone: this.deps.config.greetingTone,
        // The greeting is configured prose, not the protocol catalogue's wording,
        // and the transcript must not later claim the caller heard reviewed text.
        verbatimProtocolText: false,
        emergencyId: connection.emergencyId,
        callSessionId: connection.callSessionId,
      });

      if (this.isStreamClosed(connection)) {
        this.logger.debug(
          { callSessionId: connection.callSessionId },
          'discarding a greeting synthesised after the call ended',
        );
        return;
      }

      if (spoken.isAudible && spoken.audio.length > 0) {
        this.sendDiagnosticPrompt(session, connection, spoken.audio);
        this.logger.info(
          {
            callSessionId: connection.callSessionId,
            voice: spoken.voice,
            provider: spoken.provider,
            durationMs: spoken.durationMs,
          },
          'played the intake greeting to the caller',
        );
      } else {
        this.logger.warn(
          { callSessionId: connection.callSessionId },
          'the greeting produced no audio; the caller will hear silence',
        );
      }
    } catch (error) {
      // A greeting failure must not tear down a live emergency call: the caller
      // gets silence instead of a prompt, which is bad, but dropping the call is
      // worse. The error is surfaced loudly so it is seen rather than silent.
      this.logger.error(
        { callSessionId: connection.callSessionId, reason: (error as Error).message },
        'could not play the intake greeting',
      );
    }
  }

  /**
   * Starts the spoken half of the call.
   *
   * With a conversation port the caller hears the protocol's first instruction,
   * not the configured greeting, so the two prompts cannot both play and repeat
   * each other. The greeting remains the fallback for a build without a
   * conversation port and for the case where no protocol session could be
   * started — silence would be worse.
   */
  private async beginConversation(
    session: AudioSocketSession,
    connection: ConnectionState,
    record: CallSession,
  ): Promise<void> {
    const conversation = this.deps.conversation;
    const callSessionId = connection.callSessionId;
    const emergencyId = connection.emergencyId;
    if (!conversation || !callSessionId || !emergencyId) {
      await this.playGreeting(session, connection, record);
      return;
    }
    // The caller may have hung up between the binding and here. Do not start a
    // protocol for a call that has already ended.
    if (this.isStreamClosed(connection)) return;

    try {
      const turn = await conversation.onCallConnected({
        callSessionId,
        emergencyId,
        language: record.language,
      });
      if (!turn) {
        // No protocol step to offer (e.g. no catalogue matches the incident):
        // fall back to the configured greeting rather than an opening silence.
        await this.playGreeting(session, connection, record);
        return;
      }
      await this.deliverTurn(session, connection, turn, record.language);
    } catch (error) {
      this.logger.error(
        { callSessionId, emergencyId, reason: (error as Error).message },
        'could not start the protocol conversation; falling back to the greeting',
      );
      await this.playGreeting(session, connection, record);
    }
  }

  /**
   * Advances the protocol after a caller utterance and speaks the next turn.
   *
   * Called only for a stored, final utterance: a rejected or empty transcription
   * is not something the caller said, and feeding it to the protocol would let a
   * recogniser mistake steer a clinical step.
   */
  private async advanceConversation(
    session: AudioSocketSession,
    connection: ConnectionState,
    language: string,
    text: string,
  ): Promise<void> {
    const conversation = this.deps.conversation;
    const callSessionId = connection.callSessionId;
    const emergencyId = connection.emergencyId;
    if (!conversation || !callSessionId || !emergencyId) return;
    if (this.isStreamClosed(connection)) return;

    try {
      const turn = await conversation.onCallerUtterance({
        callSessionId,
        emergencyId,
        language,
        text,
      });
      if (!turn) return;
      // The caller may have hung up while the protocol was deciding.
      if (this.isStreamClosed(connection)) return;
      await this.deliverTurn(session, connection, turn, language);
    } catch (error) {
      // A failed turn must not tear down a live emergency call: the caller keeps
      // the connection and the next utterance may still move the protocol on.
      this.logger.error(
        { callSessionId, emergencyId, reason: (error as Error).message },
        'could not advance the protocol conversation',
      );
    }
  }

  /** Speaks one turn over the live socket, using Module 2 and the paced writer. */
  private async speakTurn(
    session: AudioSocketSession,
    connection: ConnectionState,
    turn: ConversationTurn,
    language: string,
  ): Promise<void> {
    const callSessionId = connection.callSessionId;
    const emergencyId = connection.emergencyId;
    if (!callSessionId || !emergencyId) return;
    if (turn.speech.trim() === '') return;
    if (this.isStreamClosed(connection)) return;

    try {
      const spoken = await this.deps.speech.speak({
        text: turn.speech,
        language,
        tone: turn.tone,
        verbatimProtocolText: turn.verbatimProtocolText,
        emergencyId,
        callSessionId,
      });
      // The caller may have hung up while the audio was being synthesised. The
      // words were already chosen and written to the timeline, but playing them
      // into a closed socket is pointless and masks the hangup.
      if (this.isStreamClosed(connection)) {
        this.logger.debug({ callSessionId }, 'discarding speech synthesised after the call ended');
        return;
      }
      if (spoken.isAudible && spoken.audio.length > 0) {
        this.sendDiagnosticPrompt(session, connection, spoken.audio);
        this.logger.info(
          {
            callSessionId,
            emergencyId,
            terminal: turn.terminal,
            provider: spoken.provider,
            durationMs: spoken.durationMs,
          },
          'spoke a protocol instruction to the caller',
        );
      } else {
        this.logger.warn(
          { callSessionId },
          'the protocol instruction produced no audio; the caller will hear silence',
        );
      }
    } catch (error) {
      this.logger.error(
        { callSessionId, reason: (error as Error).message },
        'could not speak the protocol instruction',
      );
    }
  }

  // -- silence ----------------------------------------------------------------

  /**
   * Speaks one turn and arms the caller-silence timer against it.
   *
   * Every turn the caller hears goes through here so the silence budget is tied to
   * the prompt that is actually outstanding. A terminal turn arms nothing: the
   * protocol has finished, so there is no question left to answer or repeat.
   */
  private async deliverTurn(
    session: AudioSocketSession,
    connection: ConnectionState,
    turn: ConversationTurn,
    language: string,
  ): Promise<void> {
    connection.promptOutstanding = !turn.terminal;
    await this.speakTurn(session, connection, turn, language);
    this.armSilenceTimer(session, connection);
  }

  /** (Re)arms the silence timer for the prompt currently outstanding. */
  private armSilenceTimer(session: AudioSocketSession, connection: ConnectionState): void {
    this.clearSilenceTimer(connection);
    const port = this.deps.conversation;
    const timeoutMs = this.deps.config.silenceTimeoutMs ?? 0;
    if (timeoutMs <= 0) return;
    if (!connection.promptOutstanding) return;
    if (this.isStreamClosed(connection)) return;
    if (typeof port?.onCallerSilence !== 'function') return;

    connection.silenceTimer = setTimeout(() => {
      connection.silenceTimer = null;
      void this.handleCallerSilence(session, connection);
    }, timeoutMs);
    // A pending prompt must never hold the process open; the call itself keeps it
    // alive and will clear the timer on hangup.
    connection.silenceTimer.unref?.();
  }

  private clearSilenceTimer(connection: ConnectionState): void {
    if (connection.silenceTimer) {
      clearTimeout(connection.silenceTimer);
      connection.silenceTimer = null;
    }
  }

  /**
   * Handles one silent window: ask the conversation what, if anything, to repeat.
   *
   * The call is re-read before acting, so a caller who hung up during the wait is
   * not prompted. The conversation's reply is only spoken if the stream is still
   * open, exactly like any other turn.
   */
  private async handleCallerSilence(
    session: AudioSocketSession,
    connection: ConnectionState,
  ): Promise<void> {
    if (this.isStreamClosed(connection)) return;
    const port = this.deps.conversation;
    const callSessionId = connection.callSessionId;
    const emergencyId = connection.emergencyId;
    if (typeof port?.onCallerSilence !== 'function' || !callSessionId || !emergencyId) return;

    let language: string;
    try {
      const record = await this.deps.calls.sessionById(callSessionId);
      if (!record || record.status !== 'ACTIVE') return;
      language = record.language;
    } catch (error) {
      this.logger.warn(
        { callSessionId, reason: (error as Error).message },
        'could not re-read the call session before handling caller silence',
      );
      return;
    }
    if (this.isStreamClosed(connection)) return;

    let turn: ConversationTurn | null;
    try {
      turn = await port.onCallerSilence({ callSessionId, emergencyId, language });
    } catch (error) {
      this.logger.error(
        { callSessionId, emergencyId, reason: (error as Error).message },
        'could not handle caller silence',
      );
      return;
    }

    // The conversation may have taken as long as the transcription path; a hangup
    // in that window must not be answered with speech.
    if (this.isStreamClosed(connection)) {
      this.logger.debug(
        { callSessionId },
        'discarding silence handling that finished after the call ended',
      );
      return;
    }
    if (!turn) {
      // The conversation has stopped prompting (retry budget spent, or the
      // protocol finished). Arm nothing further.
      connection.promptOutstanding = false;
      return;
    }
    await this.deliverTurn(session, connection, turn, language);
  }

  // -- media ------------------------------------------------------------------

  private onAudio(session: AudioSocketSession, frame: AudioFrame): void {
    const connection = this.connections.get(session.uuid);
    if (!connection || this.isStreamClosed(connection)) return;

    if (frame.sampleRate !== EXPECTED_SAMPLE_RATE && !connection.warnedRate) {
      connection.warnedRate = true;
      this.logger.warn(
        { uuid: session.uuid, sampleRate: frame.sampleRate, expected: EXPECTED_SAMPLE_RATE },
        'AudioSocket delivered an unexpected sample rate; transcription quality may degrade',
      );
    }

    if (connection.state === 'resolving') {
      connection.queue.push(frame.pcm);
      return;
    }

    this.processFrame(session, connection, frame.pcm, frame.sampleRate);
  }

  private processFrame(
    session: AudioSocketSession,
    connection: ConnectionState,
    pcm: Buffer,
    sampleRate: number,
  ): void {
    const frameMs = Math.round((pcm.length / BYTES_PER_MS_AT_8K) * (EXPECTED_SAMPLE_RATE / sampleRate));
    const level = rms(pcm);
    const loud = level >= this.deps.config.speechRmsThreshold;

    if (!connection.inSpeech) {
      if (!loud) return;
      connection.inSpeech = true;
      connection.utterance = [pcm];
      connection.utteranceMs = frameMs;
      connection.utteranceFrameCount = 1;
      connection.utteranceFrameBytes = [pcm.length];
      connection.utteranceSampleRates = new Set([sampleRate]);
      connection.segmentSequence += 1;
      const diagnosticEnabled =
        connection.isSimulation && connection.diagnosticSegmentCount < MAX_SYNTHETIC_DIAGNOSTIC_SEGMENTS_PER_CALL;
      if (diagnosticEnabled) connection.diagnosticSegmentCount += 1;
      const framePeak = diagnosticEnabled ? peak(pcm) : 0;
      connection.activeSegment = {
        segmentId: `${connection.callSessionId ?? connection.uuid}:SEG-${String(connection.segmentSequence).padStart(4, '0')}`,
        startedAtMs: Date.now(),
        startedAtMonotonicMs: this.monotonicNow(),
        diagnosticEnabled,
        frameCount: 1,
        frameRmsMin: level,
        frameRmsMax: level,
        frameRmsSum: level,
        frameRmsAboveThreshold: 1,
        framePeakMin: framePeak,
        framePeakMax: framePeak,
        framePeakSum: framePeak,
      };
      connection.trailingSilenceMs = 0;
      connection.trailingSilenceFrameCount = 0;
      // The caller is speaking: the silence budget restarts. It is re-armed only
      // once the resulting turn has been spoken (or the utterance is dropped).
      this.clearSilenceTimer(connection);
      return;
    }

    connection.utterance.push(pcm);
    connection.utteranceMs += frameMs;
    connection.utteranceFrameCount += 1;
    connection.utteranceFrameBytes.push(pcm.length);
    connection.utteranceSampleRates.add(sampleRate);
    const segment = connection.activeSegment;
    if (segment?.diagnosticEnabled) {
      const framePeak = peak(pcm);
      segment.frameCount += 1;
      segment.frameRmsMin = Math.min(segment.frameRmsMin, level);
      segment.frameRmsMax = Math.max(segment.frameRmsMax, level);
      segment.frameRmsSum += level;
      segment.framePeakMin = Math.min(segment.framePeakMin, framePeak);
      segment.framePeakMax = Math.max(segment.framePeakMax, framePeak);
      segment.framePeakSum += framePeak;
      if (loud) segment.frameRmsAboveThreshold += 1;
    }
    connection.trailingSilenceMs = loud ? 0 : connection.trailingSilenceMs + frameMs;
    connection.trailingSilenceFrameCount = loud ? 0 : connection.trailingSilenceFrameCount + 1;

    const reachedMaxDuration = connection.utteranceMs >= this.deps.config.maxUtteranceMs;
    if (connection.trailingSilenceMs >= this.deps.config.hangoverMs || reachedMaxDuration) {
      this.finaliseUtterance(session, connection, reachedMaxDuration ? 'max-duration' : 'silence-hangover');
    }
  }

  private finaliseUtterance(
    session: AudioSocketSession,
    connection: ConnectionState,
    boundaryReason: AudioSegmentDiagnostics['boundaryReason'],
  ): void {
    const utterance = connection.utterance;
    const utteranceMs = connection.utteranceMs;
    const frameCount = connection.utteranceFrameCount;
    const frameBytes = connection.utteranceFrameBytes;
    const sampleRates = [...connection.utteranceSampleRates].sort((a, b) => a - b);
    const segment = connection.activeSegment;
    const endedAtMs = Date.now();
    const endedAtMonotonicMs = this.monotonicNow();
    const pcm = Buffer.concat(utterance);
    const transcriptionOutcome: AudioSegmentDiagnostics['transcriptionOutcome'] =
      utteranceMs < this.deps.config.minUtteranceMs
        ? 'dropped-too-short'
        : connection.callSessionId && connection.emergencyId
          ? 'submitted'
          : 'dropped-missing-session';
    const segmentDiagnostics = segment?.diagnosticEnabled
      ? buildSegmentDiagnostics(segment, endedAtMs, this.callRelativeMs(connection, segment.startedAtMonotonicMs), this.callRelativeMs(connection, endedAtMonotonicMs), utteranceMs, pcm.length, boundaryReason, transcriptionOutcome, connection.trailingSilenceFrameCount)
      : undefined;

    connection.utterance = [];
    connection.utteranceMs = 0;
    connection.utteranceFrameCount = 0;
    connection.utteranceFrameBytes = [];
    connection.utteranceSampleRates.clear();
    connection.activeSegment = null;
    connection.trailingSilenceMs = 0;
    connection.trailingSilenceFrameCount = 0;
    connection.inSpeech = false;

    if (utterance.length === 0) return;

    if (connection.isSimulation && segmentDiagnostics) {
      safeDiagnosticInfo(
        this.logger,
        {
          callSessionId: connection.callSessionId,
          emergencyId: connection.emergencyId,
          scope: 'synthetic-test',
          ...measurePcm(pcm, sampleRates, { frameCount, frameBytes, vadDurationMs: utteranceMs }),
          ...segmentDiagnostics,
        },
        'synthetic test audio ingress diagnostics',
      );
    }

    // Short bursts are clicks, chair scrapes and line noise. Sending them to the
    // recogniser would put noise into the transcript as an "utterance".
    if (utteranceMs < this.deps.config.minUtteranceMs) {
      this.logger.debug(
        { uuid: session.uuid, utteranceMs },
        'discarding a short audio burst that is not an utterance',
      );
      return;
    }

    if (!connection.callSessionId || !connection.emergencyId) return;

    void this.transcribe(session, connection, pcm, segmentDiagnostics);
  }

  private async transcribe(
    session: AudioSocketSession,
    connection: ConnectionState,
    pcm: Buffer,
    segmentDiagnostics?: AudioSegmentDiagnostics,
  ): Promise<void> {
    // A transcription must not even start once the stream has closed: the result
    // could only be written against an ended call.
    if (this.isStreamClosed(connection)) return;
    const callSessionId = connection.callSessionId;
    const emergencyId = connection.emergencyId;
    if (!callSessionId || !emergencyId) return;

    const record = await this.deps.calls.sessionById(callSessionId);
    if (!record || record.status !== 'ACTIVE') {
      this.logger.debug({ callSessionId }, 'dropping an utterance for a call session that already ended');
      return;
    }

    try {
      const transcriptionStartedAt = Date.now();
      const result = await this.deps.speech.transcribe({
        callSessionId,
        emergencyId,
        audio: pcm,
        language: record.language,
        speaker: 'CALLER',
        isFinal: true,
        ...(record.isSimulation && segmentDiagnostics
          ? { diagnosticScope: 'synthetic-test' as const, segmentDiagnostics }
          : {}),
      });
      if (record.isSimulation && segmentDiagnostics) {
        safeDiagnosticInfo(
          this.logger,
          {
            callSessionId,
            emergencyId,
            scope: 'synthetic-test',
            ...segmentDiagnostics,
            transcriptionRoundTripMs: Date.now() - transcriptionStartedAt,
            accepted: result.accepted,
            confidence: result.confidence,
          },
          'synthetic test transcription diagnostics',
        );
      }
      this.logger.info(
        {
          callSessionId,
          emergencyId,
          accepted: result.accepted,
          confidence: result.confidence,
          band: result.band,
          characters: result.text.length,
        },
        'transcribed a caller utterance from the live call',
      );

      // The recogniser can take seconds, during which the caller may hang up.
      // A transcript that completes after the call ended must not advance the
      // protocol, prompt the caller or leave a SYSTEM timeline entry.
      if (this.isStreamClosed(connection)) {
        this.logger.debug(
          { callSessionId },
          'discarding a transcription that finished after the call ended',
        );
        return;
      }

      // Only a stored, final, non-empty utterance is the caller's actual words.
      // Everything the caller said reaches the protocol from here; nothing else
      // does, so a recogniser misfire cannot move a clinical step.
      if (result.accepted && result.text.trim() !== '') {
        // Re-read the session: the binding can be live while the row has already
        // been ended by the hangup path.
        const stillLive = await this.deps.calls.sessionById(callSessionId);
        if (!stillLive || stillLive.status !== 'ACTIVE') {
          this.logger.debug(
            { callSessionId },
            'dropping an utterance for a call session that ended during transcription',
          );
          return;
        }
        await this.advanceConversation(session, connection, record.language, result.text);
      }
    } catch (error) {
      // Failures here are recorded by Module 2 on the timeline; the bridge only
      // has to keep the call alive and say why the utterance vanished.
      this.logger.warn(
        { callSessionId, emergencyId, reason: (error as Error).message },
        'could not transcribe a caller utterance',
      );
    } finally {
      // The caller spoke, so the silence timer was cleared at the start of the
      // utterance. If the turn did not produce a fresh prompt — a rejected or
      // empty transcription, or a turn that returned nothing — the prompt the
      // caller actually heard is still outstanding, so the budget is re-armed
      // against it. A hangup or a new prompt leaves this a no-op or a reset.
      this.armSilenceTimer(session, connection);
    }
  }

  private onDtmf(session: AudioSocketSession, digit: string): void {
    const connection = this.connections.get(session.uuid);
    this.logger.info(
      { uuid: session.uuid, digit, callSessionId: connection?.callSessionId ?? null },
      'received DTMF from the caller',
    );
  }

  private sendDiagnosticPrompt(session: AudioSocketSession, connection: ConnectionState, audio: Uint8Array): void {
    if (!connection.isSimulation) {
      session.sendAudio(audio);
      return;
    }
    this.recordPromptTiming(connection, 'prompt-start');
    session.sendAudio(audio, () => this.recordPromptTiming(connection, 'prompt-end'));
  }

  private recordPromptTiming(connection: ConnectionState, marker: 'prompt-start' | 'prompt-end'): void {
    if (marker === 'prompt-start') {
      if (connection.promptOpen || connection.timingMarkerCount >= MAX_SYNTHETIC_TIMING_MARKERS_PER_CALL) return;
      connection.promptOpen = true;
    } else {
      if (!connection.promptOpen || connection.timingMarkerCount >= MAX_SYNTHETIC_TIMING_MARKERS_PER_CALL) return;
      connection.promptOpen = false;
      connection.completedPromptCount += 1;
    }
    this.recordTimingMarker(connection, marker);
  }

  private recordTimingMarker(
    connection: ConnectionState,
    marker: 'prompt-start' | 'prompt-end' | SyntheticSpeechTimingMarker,
  ): SyntheticTimingMarkerReceipt {
    const origin = connection.monotonicOriginMs;
    if (!connection.isSimulation || origin === null) {
      return { accepted: false, reason: 'no-active-audio-stream' };
    }
    if (connection.timingMarkerCount >= MAX_SYNTHETIC_TIMING_MARKERS_PER_CALL) {
      return { accepted: false, reason: 'limit-reached' };
    }
    const callRelativeMs = Math.max(0, this.monotonicNow() - origin);
    connection.timingMarkerCount += 1;
    connection.timingSequence += 1;
    safeDiagnosticInfo(
      this.logger,
      {
        callSessionId: connection.callSessionId,
        emergencyId: connection.emergencyId,
        scope: 'synthetic-test',
        marker,
        markerSequence: connection.timingSequence,
        promptOrdinal: marker.startsWith('prompt-') ? connection.completedPromptCount + (marker === 'prompt-start' ? 1 : 0) : undefined,
        callRelativeMs,
      },
      'synthetic call audio timing marker',
    );
    return { accepted: true, callRelativeMs };
  }

  private callRelativeMs(connection: ConnectionState, timestamp: number): number {
    return connection.monotonicOriginMs === null ? 0 : Math.max(0, timestamp - connection.monotonicOriginMs);
  }

  /**
   * True once the stream has closed.
   *
   * Read through a method rather than comparing `connection.state` inline: a
   * direct comparison would let the compiler narrow the property to its
   * pre-await value and treat the post-await re-check as dead code, which is
   * exactly the mistake this guard exists to catch.
   */
  private isStreamClosed(connection: ConnectionState): boolean {
    return connection.state === 'closed';
  }

  private onClose(session: AudioSocketSession): void {
    const connection = this.connections.get(session.uuid);
    this.connections.delete(session.uuid);
    if (!connection) return;

    // Mark closed first. Any transcription or synthesis still in flight holds
    // this object and will observe `closed` on its next check, so it stops
    // instead of advancing a protocol or speaking into a dead socket.
    connection.state = 'closed';

    // A pending silence re-prompt belongs to a call that no longer exists. Without
    // this, a timer armed moments before the hangup could fire and start synthesis
    // for an ended call.
    this.clearSilenceTimer(connection);

    // The caller's last, unfinished words are deliberately not transcribed: the
    // call has ended, so the row could only be written against a closed session
    // and the reply could never be heard. Starting that work would be processing
    // speech for a call that no longer exists.
    if (connection.isSimulation && connection.activeSegment?.diagnosticEnabled) {
      const pcm = Buffer.concat(connection.utterance);
      const endedAtMs = Date.now();
      const endedAtMonotonicMs = this.monotonicNow();
      const frameBytes = connection.utteranceFrameBytes;
      const frameCount = connection.utteranceFrameCount;
      const sampleRates = [...connection.utteranceSampleRates].sort((a, b) => a - b);
      const segmentDiagnostics = buildSegmentDiagnostics(
        connection.activeSegment,
        endedAtMs,
        this.callRelativeMs(connection, connection.activeSegment.startedAtMonotonicMs),
        this.callRelativeMs(connection, endedAtMonotonicMs),
        connection.utteranceMs,
        pcm.length,
        'call-ended',
        'discarded-call-ended',
        connection.trailingSilenceFrameCount,
      );
      safeDiagnosticInfo(
        this.logger,
        {
          callSessionId: connection.callSessionId,
          emergencyId: connection.emergencyId,
          scope: 'synthetic-test',
          ...measurePcm(pcm, sampleRates, {
            frameCount,
            frameBytes,
            vadDurationMs: connection.utteranceMs,
          }),
          ...segmentDiagnostics,
        },
        'synthetic test audio ingress diagnostics',
      );
    }

    if (connection.callSessionId) {
      this.deps.conversation?.forget?.(connection.callSessionId);
    }

    this.logger.info(
      { uuid: session.uuid, callSessionId: connection.callSessionId },
      'Asterisk media stream ended',
    );
  }
}

function buildSegmentDiagnostics(
  segment: ActiveSegment,
  endedAtMs: number,
  callRelativeStartMs: number,
  callRelativeEndMs: number,
  durationMs: number,
  payloadBytes: number,
  boundaryReason: AudioSegmentDiagnostics['boundaryReason'],
  transcriptionOutcome: AudioSegmentDiagnostics['transcriptionOutcome'],
  trailingSilenceFrameCount: number,
): AudioSegmentDiagnostics {
  const frameCount = Math.max(1, segment.frameCount);
  return {
    segmentId: segment.segmentId,
    callRelativeStartMs,
    callRelativeEndMs,
    startedAt: new Date(segment.startedAtMs).toISOString(),
    endedAt: new Date(endedAtMs).toISOString(),
    durationMs,
    sampleCount: Math.floor(payloadBytes / 2),
    boundaryReason,
    transcriptionOutcome,
    frameCount,
    trailingSilenceFrameCount,
    frameRmsMin: Math.round(segment.frameRmsMin),
    frameRmsMean: Math.round(segment.frameRmsSum / frameCount),
    frameRmsMax: Math.round(segment.frameRmsMax),
    frameRmsAboveThreshold: segment.frameRmsAboveThreshold,
    framePeakMin: Math.round(segment.framePeakMin),
    framePeakMean: Math.round(segment.framePeakSum / frameCount),
    framePeakMax: Math.round(segment.framePeakMax),
  };
}

function safeDiagnosticInfo(logger: Logger, fields: Record<string, unknown>, message: string): void {
  try {
    logger.info(fields, message);
  } catch {
    // Diagnostics are best-effort and must never disrupt the call path.
  }
}

function measurePcm(
  pcm: Buffer,
  sampleRates: number[],
  framing: { frameCount: number; frameBytes: number[]; vadDurationMs: number },
): {
  sampleRates: number[];
  channels: 1;
  sampleFormat: 'signed-int16-le';
  sampleCount: number;
  payloadBytes: number;
  durationMs: number | null;
  vadDurationMs: number;
  frameCount: number;
  minFrameBytes: number;
  maxFrameBytes: number;
  rms: number;
  peak: number;
  clippedSampleRatio: number;
} {
  const sampleCount = Math.floor(pcm.length / 2);
  let sumSquares = 0;
  let peak = 0;
  let clipped = 0;
  for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
    const sample = pcm.readInt16LE(offset);
    const magnitude = Math.abs(sample);
    sumSquares += sample * sample;
    peak = Math.max(peak, magnitude);
    if (magnitude >= 32760) clipped += 1;
  }
  const oneRate = sampleRates.length === 1 ? sampleRates[0]! : null;
  const frameBytes = framing.frameBytes;
  return {
    sampleRates,
    channels: 1,
    sampleFormat: 'signed-int16-le',
    sampleCount,
    payloadBytes: pcm.length,
    durationMs: oneRate ? (sampleCount / oneRate) * 1000 : null,
    vadDurationMs: framing.vadDurationMs,
    frameCount: framing.frameCount,
    minFrameBytes: frameBytes.length ? Math.min(...frameBytes) : 0,
    maxFrameBytes: frameBytes.length ? Math.max(...frameBytes) : 0,
    rms: sampleCount ? Math.round(Math.sqrt(sumSquares / sampleCount)) : 0,
    peak,
    clippedSampleRatio: sampleCount ? clipped / sampleCount : 0,
  };
}

/** Root-mean-square level of signed 16-bit little-endian mono PCM. */
function rms(pcm: Buffer): number {
  const samples = pcm.length >> 1;
  if (samples === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples; i += 1) {
    const sample = pcm.readInt16LE(i * 2);
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples);
}

/** Peak absolute S16LE sample for a single frame; used only for scoped diagnostics. */
function peak(pcm: Buffer): number {
  const samples = pcm.length >> 1;
  let maximum = 0;
  for (let i = 0; i < samples; i += 1) {
    maximum = Math.max(maximum, Math.abs(pcm.readInt16LE(i * 2)));
  }
  return maximum;
}
