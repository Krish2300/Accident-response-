import { describe, expect, it } from 'vitest';
import {
  AppError,
  ErrorCode,
  VOICE_CONFIDENCE,
  confidenceBand,
  normaliseLanguageCode,
  type CallSession,
  type Database,
  type EventPublisherPort,
  type SpeechProvider,
  type SystemEventEnvelope,
  type SystemEventRecord,
  type TextToSpeechProvider,
  type Transcript,
} from '@resus/core';
import { SpeechService, type CallSessionStore } from '../src/speechService.js';
import { loadModule2Config } from '../src/config.js';
import {
  LoopbackSpeechProvider,
  LoopbackSynthesisProvider,
  audioCarrier,
} from '../src/providers/loopbackProviders.js';

/**
 * Module 2 speech tests.
 *
 * The behaviour that matters most here is what the module *refuses*: audio it
 * cannot trust, a language no provider supports, a session that has ended, and
 * synthesis that would produce nothing audible. Those refusals are asserted as
 * precisely as the happy path, because a speech layer that guesses is worse than
 * one that admits it did not hear.
 */

const config = loadModule2Config();

class FakeEvents implements EventPublisherPort {
  readonly recorded: SystemEventEnvelope[] = [];

  async record(event: SystemEventEnvelope): Promise<SystemEventRecord> {
    this.recorded.push(event);
    return { id: `EVT-${this.recorded.length}` } as SystemEventRecord;
  }

  async recordMany(events: SystemEventEnvelope[]): Promise<SystemEventRecord[]> {
    for (const event of events) this.recorded.push(event);
    return events.map((_, index) => ({ id: `EVT-${index}` }) as SystemEventRecord);
  }

  async recordInTransaction(_db: Database, event: SystemEventEnvelope): Promise<SystemEventRecord> {
    return this.record(event);
  }

  types(): string[] {
    return this.recorded.map((event) => event.type);
  }

  payloadOf<T>(type: string): T | undefined {
    return this.recorded.find((event) => event.type === type)?.payload as T | undefined;
  }

  countOf(type: string): number {
    return this.recorded.filter((event) => event.type === type).length;
  }
}

class FakeCalls implements CallSessionStore {
  readonly transcripts: Array<Record<string, unknown>> = [];
  session: CallSession | null = {
    id: 'CALL-1',
    emergencyId: 'EMG-1',
    channel: 'LOOPBACK',
    callerId: null,
    status: 'ACTIVE',
    language: 'en',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: null,
    isSimulation: false,
  };
  private sequence = 0;

  async sessionById(id: string): Promise<CallSession | null> {
    return this.session && this.session.id === id ? this.session : null;
  }

  async endSession(): Promise<CallSession | null> {
    return this.session;
  }

  async appendTranscript(input: Record<string, unknown>) {
    this.sequence += 1;
    const transcript = { id: `TRN-${this.sequence}`, sequence: this.sequence, ...input } as unknown as Transcript;
    this.transcripts.push(input);
    return transcript;
  }
}

function harness(
  options: {
    speech?: SpeechProvider;
    synthesis?: TextToSpeechProvider;
    config?: typeof config;
  } = {},
) {
  const calls = new FakeCalls();
  const events = new FakeEvents();
  const service = new SpeechService({
    config: options.config ?? config,
    speech: options.speech ?? new LoopbackSpeechProvider({ scripted: { 'CALL-1': 'He is not breathing.' } }),
    synthesis: options.synthesis ?? new LoopbackSynthesisProvider(),
    calls,
    events,
  });
  return { service, calls, events };
}

const session = { callSessionId: 'CALL-1', emergencyId: 'EMG-1' };

// -- confidence policy --------------------------------------------------------

describe('confidence policy', () => {
  it('bands confidence consistently at the documented thresholds', () => {
    expect(confidenceBand(VOICE_CONFIDENCE.HIGH)).toBe('HIGH');
    expect(confidenceBand(VOICE_CONFIDENCE.HIGH - 0.01)).toBe('LOW');
    expect(confidenceBand(VOICE_CONFIDENCE.DISCARD_BELOW)).toBe('LOW');
    expect(confidenceBand(VOICE_CONFIDENCE.DISCARD_BELOW - 0.01)).toBe('UNUSABLE');
    expect(confidenceBand(0)).toBe('UNUSABLE');
  });

  it('resolves regional and mixed-case language codes', () => {
    expect(normaliseLanguageCode('en-IN')).toBe('en');
    expect(normaliseLanguageCode('EN_us')).toBe('en');
    expect(normaliseLanguageCode('ml')).toBe('ml');
    expect(normaliseLanguageCode('fr')).toBeNull();
    expect(normaliseLanguageCode('')).toBeNull();
  });
});

// -- transcription ------------------------------------------------------------

describe('transcribing a final utterance', () => {
  it('stores the transcript and reports it accepted', async () => {
    const { service, calls, events } = harness();

    const result = await service.transcribe({ ...session, audio: audioCarrier('He is not breathing.') });

    expect(result.accepted).toBe(true);
    expect(result.text).toBe('He is not breathing.');
    expect(result.band).toBe('HIGH');
    expect(result.persisted).not.toBeNull();
    expect(calls.transcripts).toHaveLength(1);
    expect(calls.transcripts[0]).toMatchObject({
      callSessionId: 'CALL-1',
      emergencyId: 'EMG-1',
      speaker: 'CALLER',
      text: 'He is not breathing.',
      isFinal: true,
    });
    // TRANSCRIPT_UPDATED is emitted by the repository inside its transaction;
    // Module 2 must not add a duplicate.
    expect(events.types()).not.toContain('TRANSCRIPT_UPDATED');
  });

  it('reads the agreed text out of the development audio carrier', async () => {
    const { service } = harness({ speech: new LoopbackSpeechProvider() });

    const result = await service.transcribe({ ...session, audio: audioCarrier('She has fallen down.') });

    expect(result.text).toBe('She has fallen down.');
  });

  it('honours a scripted transcript keyed by session', async () => {
    const { service } = harness({
      speech: new LoopbackSpeechProvider({ scripted: { 'CALL-1': 'Scripted answer.' } }),
    });

    const result = await service.transcribe({ ...session, audio: audioCarrier('ignored') });

    expect(result.text).toBe('Scripted answer.');
  });

  it('marks a low-confidence result as needing confirmation but still stores it', async () => {
    const { service, calls } = harness({
      speech: new LoopbackSpeechProvider({ scripted: { 'CALL-1': 'He is not... breathing?' }, confidence: 0.6 }),
    });

    const result = await service.transcribe({ ...session, audio: audioCarrier('x') });

    expect(result.accepted).toBe(true);
    expect(result.band).toBe('LOW');
    expect(result.notice).toMatch(/confirm/i);
    expect(calls.transcripts).toHaveLength(1);
  });
});

describe('discarding what it did not hear', () => {
  it('never stores a result below the confidence threshold', async () => {
    const { service, calls, events } = harness({
      speech: new LoopbackSpeechProvider({ scripted: { 'CALL-1': 'He is not breathing.' }, confidence: 0.2 }),
    });

    const result = await service.transcribe({ ...session, audio: audioCarrier('x') });

    expect(result.accepted).toBe(false);
    expect(result.text).toBe('');
    expect(result.persisted).toBeNull();
    // A guess at this level is more dangerous than an admitted gap.
    expect(calls.transcripts).toHaveLength(0);
    expect(events.payloadOf<{ failureKind: string }>('SPEECH_TRANSCRIPTION_FAILED')?.failureKind).toBe(
      'LOW_CONFIDENCE',
    );
  });

  it('records a failure when a final result contains no words', async () => {
    const { service, calls, events } = harness({
      speech: new LoopbackSpeechProvider({ scripted: { 'CALL-1': '   ' } }),
    });

    const result = await service.transcribe({ ...session, audio: audioCarrier('x') });

    expect(result.accepted).toBe(false);
    expect(calls.transcripts).toHaveLength(0);
    expect(events.payloadOf<{ failureKind: string }>('SPEECH_TRANSCRIPTION_FAILED')?.failureKind).toBe('EMPTY_AUDIO');
  });

  it('rejects empty audio before calling the provider', async () => {
    const { service, events } = harness();

    await expect(service.transcribe({ ...session, audio: new Uint8Array(0) })).rejects.toMatchObject({
      code: ErrorCode.SPEECH_TRANSCRIPTION_FAILED,
      statusCode: 422,
    });
    expect(events.payloadOf<{ failureKind: string }>('SPEECH_TRANSCRIPTION_FAILED')?.failureKind).toBe('EMPTY_AUDIO');
  });

  it('rejects audio beyond the configured size limit', async () => {
    const small = { ...config, speech: { ...config.speech, maxAudioBytes: 16 } };
    const { service, events } = harness({ config: small });

    await expect(service.transcribe({ ...session, audio: audioCarrier('x'.repeat(64)) })).rejects.toMatchObject({
      statusCode: 413,
    });
    expect(events.payloadOf<{ failureKind: string }>('SPEECH_TRANSCRIPTION_FAILED')?.failureKind).toBe(
      'INVALID_AUDIO',
    );
  });
});

describe('interim results', () => {
  it('publishes a partial but never writes a transcript row', async () => {
    const { service, calls, events } = harness();

    const result = await service.transcribe({ ...session, audio: audioCarrier('x'), isFinal: false });

    expect(result.accepted).toBe(true);
    expect(result.persisted).toBeNull();
    // Interim guesses would consume `sequence` numbers and interleave with real
    // utterances in the incident review.
    expect(calls.transcripts).toHaveLength(0);
    expect(events.countOf('TRANSCRIPT_PARTIAL')).toBe(1);
    expect(events.payloadOf<{ sequence: number }>('TRANSCRIPT_PARTIAL')?.sequence).toBe(-1);
  });

  it('exposes the latest interim text and clears it on a final result', async () => {
    const { service } = harness();

    await service.transcribe({ ...session, audio: audioCarrier('He is not breathing.'), isFinal: false });
    expect(service.pendingPartial('CALL-1')).toBe('He is not breathing.');

    await service.transcribe({ ...session, audio: audioCarrier('He is not breathing.'), isFinal: true });
    expect(service.pendingPartial('CALL-1')).toBeNull();
  });

  it('can be switched off entirely', async () => {
    const quiet = { ...config, speech: { ...config.speech, emitPartials: false } };
    const { service, events } = harness({ config: quiet });

    await service.transcribe({ ...session, audio: audioCarrier('x'), isFinal: false });

    expect(events.types()).not.toContain('TRANSCRIPT_PARTIAL');
  });

  it('emits no partial for a below-threshold interim guess', async () => {
    const { service, events } = harness({
      speech: new LoopbackSpeechProvider({ scripted: { 'CALL-1': 'mumble' }, confidence: 0.1 }),
    });

    await service.transcribe({ ...session, audio: audioCarrier('x'), isFinal: false });

    expect(events.types()).not.toContain('TRANSCRIPT_PARTIAL');
  });
});

describe('refusing a request it cannot honour', () => {
  it('rejects a language no provider supports', async () => {
    const { service } = harness();

    await expect(
      service.transcribe({ ...session, audio: audioCarrier('x'), language: 'fr' }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('rejects a call session that has ended', async () => {
    const { service, calls } = harness();
    calls.session = { ...(calls.session as CallSession), status: 'ENDED' };

    await expect(service.transcribe({ ...session, audio: audioCarrier('x') })).rejects.toMatchObject({
      code: ErrorCode.CONVERSATION_CLOSED,
      statusCode: 409,
    });
  });

  it('refuses to attribute an utterance to the wrong emergency', async () => {
    const { service } = harness();

    // Guards against corrupting two transcripts at once.
    await expect(
      service.transcribe({ callSessionId: 'CALL-1', emergencyId: 'EMG-OTHER', audio: audioCarrier('x') }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR, statusCode: 409 });
  });

  it('reports a provider outage as PROVIDER_UNAVAILABLE and records it', async () => {
    const { service, events } = harness({
      speech: new LoopbackSpeechProvider({ failWith: 'recognizer offline' }),
    });

    await expect(service.transcribe({ ...session, audio: audioCarrier('x') })).rejects.toMatchObject({
      code: ErrorCode.PROVIDER_UNAVAILABLE,
      statusCode: 503,
    });
    expect(events.payloadOf<{ failureKind: string }>('SPEECH_TRANSCRIPTION_FAILED')?.failureKind).toBe(
      'PROVIDER_ERROR',
    );
  });
});

// -- synthesis ----------------------------------------------------------------

describe('synthesizing speech', () => {
  it('records the attempt and reports honestly that nothing is audible', async () => {
    const { service, events } = harness();

    const result = await service.speak({
      text: 'Are they breathing normally?',
      language: 'en',
      tone: 'CALM',
      verbatimProtocolText: true,
      emergencyId: 'EMG-1',
      callSessionId: 'CALL-1',
    });

    expect(result.isAudible).toBe(false);
    expect(result.isLive).toBe(false);
    expect(result.characterCount).toBe('Are they breathing normally?'.length);
    expect(result.verbatimProtocolText).toBe(true);

    const payload = events.payloadOf<{ verbatimProtocolText: boolean; voice: string; provider: string }>(
      'SPEECH_SYNTHESIZED',
    );
    // The record states whether the caller heard catalogue wording or a paraphrase.
    expect(payload?.verbatimProtocolText).toBe(true);
    expect(payload?.provider).toBe('loopback');
  });

  it('distinguishes paraphrase from verbatim text in the record', async () => {
    const { service, events } = harness();

    await service.speak({
      text: 'Check whether they are breathing.',
      language: 'en',
      tone: 'CALM',
      verbatimProtocolText: false,
      emergencyId: 'EMG-1',
    });

    expect(events.payloadOf<{ verbatimProtocolText: boolean }>('SPEECH_SYNTHESIZED')?.verbatimProtocolText).toBe(
      false,
    );
  });

  it('refuses an unsupported language without calling the provider', async () => {
    const { service, events } = harness();

    await expect(
      service.speak({ text: 'Hello', language: 'de', tone: 'CALM', verbatimProtocolText: true }),
    ).rejects.toMatchObject({ code: ErrorCode.SPEECH_LANGUAGE_UNSUPPORTED, statusCode: 422 });
    expect(events.payloadOf<{ failureKind: string }>('SPEECH_SYNTHESIS_FAILED')?.failureKind).toBe(
      'UNSUPPORTED_LANGUAGE',
    );
  });

  it('refuses empty text and over-long text', async () => {
    const { service } = harness();
    const short = { ...config, speech: { ...config.speech, maxSynthesisChars: 10 } };
    const { service: strict } = harness({ config: short });

    await expect(
      service.speak({ text: '   ', language: 'en', tone: 'CALM', verbatimProtocolText: true }),
    ).rejects.toMatchObject({ statusCode: 422 });

    await expect(
      strict.speak({ text: 'x'.repeat(50), language: 'en', tone: 'CALM', verbatimProtocolText: true }),
    ).rejects.toMatchObject({ statusCode: 413 });
  });

  it('refuses to speak into an ended call', async () => {
    const { service, calls } = harness();
    calls.session = { ...(calls.session as CallSession), status: 'ENDED' };

    await expect(
      service.speak({
        text: 'Stay calm.',
        language: 'en',
        tone: 'REASSURING',
        verbatimProtocolText: true,
        emergencyId: 'EMG-1',
        callSessionId: 'CALL-1',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.CONVERSATION_CLOSED });
  });

  it('records a synthesis provider outage', async () => {
    const { service, events } = harness({
      synthesis: new LoopbackSynthesisProvider({ failWith: 'tts offline' }),
    });

    await expect(
      service.speak({ text: 'Hello', language: 'en', tone: 'CALM', verbatimProtocolText: true }),
    ).rejects.toMatchObject({ code: ErrorCode.PROVIDER_UNAVAILABLE });
    expect(events.payloadOf<{ failureKind: string }>('SPEECH_SYNTHESIS_FAILED')?.failureKind).toBe(
      'PROVIDER_ERROR',
    );
  });
});

// -- status -------------------------------------------------------------------

describe('status', () => {
  it('never reports a development provider as live', () => {
    const { service } = harness();

    const status = service.status();

    expect(status.speech).toMatchObject({ provider: 'loopback', isLive: false });
    expect(status.synthesis).toMatchObject({ provider: 'loopback', isLive: false });
    expect(status.minConfidence).toBe(VOICE_CONFIDENCE.DISCARD_BELOW);
  });
});