import { describe, expect, it } from 'vitest';
import type { SessionTurn } from '@resus/protocols';
import { ProtocolTurnOrchestratorImpl } from '../apps/server/src/conversation/protocolTurnOrchestrator.js';

/**
 * Unit tests for the HTTP-utterance turn orchestrator.
 *
 * Module 5's engine is the sole clinical decision-maker. This orchestrator
 * wraps its decision so a caller turn arriving over
 * `POST /api/protocol-sessions/:id/utterance` lands in the call transcript and
 * its spoken reply is synthesised — neither of which Module 5 can do itself
 * because it holds no persistence or speech port. The tests pin the contract
 * the composition root relies on:
 *
 *   - the caller's words are persisted (speaker CALLER) before the decision,
 *   - the decision is produced by calling `decide` exactly once and returned
 *     untouched — the orchestrator never invents or substitutes a turn,
 *   - the spoken reply is persisted (speaker SYSTEM) and synthesised,
 *   - orchestration failures (transcript write, TTS) never fail the turn,
 *   - a failed `decide` fails the turn,
 *   - with no live call bound, the turn still runs without transcript or TTS.
 *
 * The engine, the call repository and the speech service are faked here so the
 * test is about ordering, single-invocation and failure isolation, not about
 * protocol inference or database behaviour.
 */

function turn(overrides: Partial<SessionTurn> = {}): SessionTurn {
  return {
    session: {
      id: 'PSE-1',
      emergencyId: 'EMG-1',
      protocolId: 'cardiac-arrest-adult',
      protocolVersion: '1.0.0',
      protocolSource: 'ERC 2021 [UNREVIEWED]',
      currentStep: 'confirm-arrest',
      status: 'ACTIVE',
      startedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      completedAt: null,
      escalationRequired: false,
      escalationReason: null,
      clarificationCount: 0,
      collectedFacts: {},
      initiatedBy: 'SYSTEM',
    },
    steps: [],
    instruction: 'Shout for help, then check whether the person is unresponsive.',
    question: 'Is the person unresponsive and not breathing normally?',
    speech: 'Shout for help, then check whether the person is unresponsive and not breathing normally.',
    tone: 'CALM',
    action: 'HELD',
    status: 'ACTIVE',
    currentStepId: 'confirm-arrest',
    requiresClarification: true,
    clarificationQuestion: 'Is the person unresponsive and not breathing normally?',
    paraphrased: false,
    degraded: false,
    escalationRequired: false,
    escalations: [],
    missingFacts: ['responsive', 'breathing_status'],
    progressPct: 0,
    llmNotice: null,
    decision: {} as SessionTurn['decision'],
    ...overrides,
  };
}

class FakeSessions {
  emergencyId: string | null = 'EMG-1';
  fail = false;
  readonly getCalls: string[] = [];

  async get(sessionId: string): Promise<{ session: { emergencyId: string } }> {
    this.getCalls.push(sessionId);
    if (this.fail) throw new Error('session store offline');
    if (!this.emergencyId) throw new Error(`Protocol session '${sessionId}' was not found.`);
    return { session: { emergencyId: this.emergencyId } };
  }
}

class FakeCalls {
  status = 'ACTIVE';
  language = 'en';
  isSimulation = true;
  failLookup = false;
  failAppend = false;
  readonly appended: Array<{ callSessionId: string; emergencyId: string; speaker: string; text: string; isSimulation: boolean }> = [];

  async requireSessionFor(_emergencyId: string): Promise<{ id: string; status: string; language: string; isSimulation: boolean }> {
    if (this.failLookup) throw new Error('no call session');
    return { id: 'CALL-1', status: this.status, language: this.language, isSimulation: this.isSimulation };
  }

  async appendTranscript(input: {
    callSessionId: string;
    emergencyId: string;
    speaker: string;
    text: string;
    isFinal?: boolean;
    isSimulation: boolean;
  }): Promise<unknown> {
    if (this.failAppend) throw new Error('transcript write failed');
    this.appended.push({
      callSessionId: input.callSessionId,
      emergencyId: input.emergencyId,
      speaker: input.speaker,
      text: input.text,
      isSimulation: input.isSimulation,
    });
    return {};
  }
}

class FakeSpeech {
  fail = false;
  readonly spoken: Array<{
    text: string;
    language: string;
    tone: string;
    verbatimProtocolText: boolean;
    emergencyId: string;
    callSessionId: string;
  }> = [];

  async speak(input: {
    text: string;
    language: string;
    tone: 'CALM' | 'URGENT' | 'REASSURING';
    verbatimProtocolText: boolean;
    emergencyId: string;
    callSessionId: string;
  }): Promise<unknown> {
    if (this.fail) throw new Error('synthesis failed');
    this.spoken.push({
      text: input.text,
      language: input.language,
      tone: input.tone,
      verbatimProtocolText: input.verbatimProtocolText,
      emergencyId: input.emergencyId,
      callSessionId: input.callSessionId,
    });
    return {};
  }
}

function build(): {
  orchestrator: ProtocolTurnOrchestratorImpl;
  sessions: FakeSessions;
  calls: FakeCalls;
  speech: FakeSpeech;
} {
  const sessions = new FakeSessions();
  const calls = new FakeCalls();
  const speech = new FakeSpeech();
  const orchestrator = new ProtocolTurnOrchestratorImpl({
    sessions,
    calls,
    speech,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  return { orchestrator, sessions, calls, speech };
}

describe('HTTP utterance turn orchestrator', () => {
  it('persists the caller words, then the decision, then the SYSTEM reply and synthesises it', async () => {
    const { orchestrator, calls, speech } = build();
    let decideCalls = 0;

    const result = await orchestrator.orchestrateTurn({
      sessionId: 'PSE-1',
      utterance: 'he is unresponsive',
      decide: async () => {
        decideCalls += 1;
        return turn();
      },
    });

    expect(decideCalls).toBe(1);
    // The decision is returned untouched.
    expect(result.speech).toBe(turn().speech);
    expect(result.currentStepId).toBe('confirm-arrest');

    // Caller transcript, then SYSTEM transcript, in speaking order.
    expect(calls.appended.map((r) => r.speaker)).toEqual(['CALLER', 'SYSTEM']);
    expect(calls.appended[0]?.text).toBe('he is unresponsive');
    expect(calls.appended[1]?.text).toBe(turn().speech);
    expect(calls.appended.every((r) => r.callSessionId === 'CALL-1' && r.emergencyId === 'EMG-1')).toBe(true);
    expect(calls.appended.every((r) => r.isSimulation)).toBe(true);

    // TTS is invoked with the spoken reply.
    expect(speech.spoken).toHaveLength(1);
    expect(speech.spoken[0]?.text).toBe(turn().speech);
    expect(speech.spoken[0]?.language).toBe('en');
    expect(speech.spoken[0]?.verbatimProtocolText).toBe(true); // paraphrased=false
    expect(speech.spoken[0]?.emergencyId).toBe('EMG-1');
    expect(speech.spoken[0]?.callSessionId).toBe('CALL-1');
  });

  it('preserves real-call provenance when persisting the caller and system transcript', async () => {
    const { orchestrator, calls } = build();
    calls.isSimulation = false;

    await orchestrator.orchestrateTurn({
      sessionId: 'PSE-1',
      utterance: 'synthetic caller words',
      decide: async () => turn(),
    });

    expect(calls.appended.map((entry) => entry.isSimulation)).toEqual([false, false]);
  });

  it('calls decide exactly once and returns its result even when it escalates', async () => {
    const { orchestrator } = build();
    let decideCalls = 0;
    const escalated = turn({ status: 'ESCALATED', action: 'ESCALATED', escalationRequired: true, tone: 'URGENT' });

    const result = await orchestrator.orchestrateTurn({
      sessionId: 'PSE-1',
      utterance: 'there are wires sparking',
      decide: async () => {
        decideCalls += 1;
        return escalated;
      },
    });

    expect(decideCalls).toBe(1);
    expect(result).toBe(escalated);
    expect(result.status).toBe('ESCALATED');
  });

  it('fails the turn when decide rejects — never invents a substitute', async () => {
    const { orchestrator } = build();

    await expect(
      orchestrator.orchestrateTurn({
        sessionId: 'PSE-1',
        utterance: 'hello',
        decide: async () => {
          throw new Error('protocol session cancelled');
        },
      }),
    ).rejects.toThrow('protocol session cancelled');
  });

  it('still returns the decision when the transcript write fails', async () => {
    const { orchestrator, calls, speech } = build();
    calls.failAppend = true;

    const result = await orchestrator.orchestrateTurn({
      sessionId: 'PSE-1',
      utterance: 'he is unresponsive',
      decide: async () => turn(),
    });

    // The clinical decision is unaffected by an orchestration failure.
    expect(result.speech).toBe(turn().speech);
    expect(calls.appended).toHaveLength(0);
    // TTS still runs: the caller must still hear the protocol's decision.
    expect(speech.spoken).toHaveLength(1);
  });

  it('still returns the decision when synthesis fails', async () => {
    const { orchestrator, calls, speech } = build();
    speech.fail = true;

    const result = await orchestrator.orchestrateTurn({
      sessionId: 'PSE-1',
      utterance: 'he is unresponsive',
      decide: async () => turn(),
    });

    expect(result.speech).toBe(turn().speech);
    // The transcript rows are still written: the record is not lost because
    // the audio could not be produced.
    expect(calls.appended.map((r) => r.speaker)).toEqual(['CALLER', 'SYSTEM']);
  });

  it('skips transcript and TTS when the protocol session cannot be resolved, but still runs the decision', async () => {
    const { orchestrator, sessions, calls, speech } = build();
    sessions.fail = true;

    const result = await orchestrator.orchestrateTurn({
      sessionId: 'PSE-1',
      utterance: 'he is unresponsive',
      decide: async () => turn(),
    });

    expect(result.speech).toBe(turn().speech);
    expect(calls.appended).toHaveLength(0);
    expect(speech.spoken).toHaveLength(0);
  });

  it('skips transcript and TTS when the call session is not ACTIVE', async () => {
    const { orchestrator, calls, speech } = build();
    calls.status = 'ENDED';

    const result = await orchestrator.orchestrateTurn({
      sessionId: 'PSE-1',
      utterance: 'he is unresponsive',
      decide: async () => turn(),
    });

    expect(result.speech).toBe(turn().speech);
    expect(calls.appended).toHaveLength(0);
    expect(speech.spoken).toHaveLength(0);
  });

  it('skips transcript and TTS when requireSessionFor throws (no call for the emergency)', async () => {
    const { orchestrator, calls, speech } = build();
    calls.failLookup = true;

    const result = await orchestrator.orchestrateTurn({
      sessionId: 'PSE-1',
      utterance: 'he is unresponsive',
      decide: async () => turn(),
    });

    expect(result.speech).toBe(turn().speech);
    expect(calls.appended).toHaveLength(0);
    expect(speech.spoken).toHaveLength(0);
  });

  it('does not synthesise an empty spoken reply but still persists the caller line', async () => {
    const { orchestrator, calls, speech } = build();

    await orchestrator.orchestrateTurn({
      sessionId: 'PSE-1',
      utterance: 'hello',
      decide: async () => turn({ speech: '   ' }),
    });

    expect(calls.appended.map((r) => r.speaker)).toEqual(['CALLER']);
    expect(speech.spoken).toHaveLength(0);
  });

  it('records paraphrased=false turns as verbatim protocol text and paraphrased=true as not', async () => {
    const { orchestrator, speech } = build();

    await orchestrator.orchestrateTurn({
      sessionId: 'PSE-1',
      utterance: 'what do I do',
      decide: async () => turn({ paraphrased: true }),
    });

    expect(speech.spoken[0]?.verbatimProtocolText).toBe(false);
  });

  it('produces a separate transcript row for each repeated request', async () => {
    // A client retry or a caller repeating themselves is a distinct turn, not
    // a duplicate: each accepted utterance gets its own CALLER row and its own
    // SYSTEM row. The engine (inside decide) decides whether the protocol
    // advances, loops or asks again.
    const { orchestrator, calls } = build();

    for (let i = 0; i < 3; i += 1) {
      await orchestrator.orchestrateTurn({
        sessionId: 'PSE-1',
        utterance: 'he is unresponsive',
        decide: async () => turn(),
      });
    }

    expect(calls.appended.filter((r) => r.speaker === 'CALLER')).toHaveLength(3);
    expect(calls.appended.filter((r) => r.speaker === 'SYSTEM')).toHaveLength(3);
  });

  it('never double-persists: one CALLER and one SYSTEM row per invocation', async () => {
    // This is a wiring guarantee, asserted here as documentation: the
    // orchestrator is only reachable from the HTTP utterance route. The live
    // AudioBridge path (AsteriskConversationController.onCallerUtterance)
    // calls sessions.handleUtterance directly and owns its own transcript and
    // TTS, so a live call's turn is persisted exactly once.
    //
    // The observable contract: orchestrateTurn is the only entry point, and it
    // persists each speaker row exactly once per invocation.
    const { orchestrator, calls } = build();

    await orchestrator.orchestrateTurn({
      sessionId: 'PSE-1',
      utterance: 'he is unresponsive',
      decide: async () => turn(),
    });

    expect(calls.appended).toHaveLength(2);
    expect(calls.appended.filter((r) => r.speaker === 'CALLER')).toHaveLength(1);
    expect(calls.appended.filter((r) => r.speaker === 'SYSTEM')).toHaveLength(1);
  });
});
