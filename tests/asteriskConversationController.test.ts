import { describe, expect, it } from 'vitest';
import type { HandleUtteranceInput, StartSessionInput } from '@resus/protocols';
import {
  AsteriskConversationController,
  type AsteriskConversationDeps,
  type ConversationEmergencySource,
  type ConversationSessions,
  type ConversationTranscriptSink,
  type ConversationTurnResult,
} from '../apps/server/src/asterisk/conversationController.js';

/**
 * Unit tests for the live-call conversation controller.
 *
 * The controller is the seam that lets a real Asterisk call drive Module 5 and
 * write the SYSTEM side of the transcript. These tests pin the contract the
 * bridge relies on: the emergency's incident type selects the protocol, the
 * opening instruction is persisted before it is spoken, each caller utterance
 * produces exactly one SYSTEM reply written after the caller line, and the loop
 * stops dead at the first terminal result.
 *
 * Module 5 itself is faked here so the test is about ordering and stopping
 * rules, not about protocol inference; the live call proves the two together.
 */

function turn(overrides: Partial<ConversationTurnResult> = {}): ConversationTurnResult {
  return {
    session: { id: 'PSE-1' },
    status: 'ACTIVE',
    speech: 'Check for danger, then see if they respond.',
    tone: 'CALM',
    paraphrased: false,
    ...overrides,
  };
}

class FakeSessions implements ConversationSessions {
  readonly started: StartSessionInput[] = [];
  readonly handled: HandleUtteranceInput[] = [];
  startImpl: (input: StartSessionInput) => Promise<ConversationTurnResult> = async () =>
    turn({ speech: 'Opening instruction.' });
  handleImpl: (input: HandleUtteranceInput) => Promise<ConversationTurnResult> = async () =>
    turn({ speech: 'Follow-up instruction.' });

  async start(input: StartSessionInput): Promise<ConversationTurnResult> {
    this.started.push(input);
    return this.startImpl(input);
  }

  async handleUtterance(input: HandleUtteranceInput): Promise<ConversationTurnResult> {
    this.handled.push(input);
    return this.handleImpl(input);
  }
}

class FakeEmergencies implements ConversationEmergencySource {
  incidentType: string | null = 'CARDIAC_ARREST';
  fail = false;

  async findById(_id: string): Promise<{ incidentType: string } | null> {
    if (this.fail) throw new Error('database offline');
    return this.incidentType ? { incidentType: this.incidentType } : null;
  }
}

class FakeTranscripts implements ConversationTranscriptSink {
  readonly appended: Array<{ callSessionId: string; speaker: string; text: string }> = [];
  fail = false;

  async appendTranscript(input: {
    callSessionId: string;
    emergencyId: string;
    speaker: string;
    text: string;
    isFinal?: boolean;
    isSimulation?: boolean;
  }): Promise<unknown> {
    if (this.fail) throw new Error('write failed');
    this.appended.push({
      callSessionId: input.callSessionId,
      speaker: input.speaker,
      text: input.text,
    });
    return {};
  }
}

function build(): {
  controller: AsteriskConversationController;
  sessions: FakeSessions;
  emergencies: FakeEmergencies;
  transcripts: FakeTranscripts;
} {
  const sessions = new FakeSessions();
  const emergencies = new FakeEmergencies();
  const transcripts = new FakeTranscripts();
  const deps: AsteriskConversationDeps = { sessions, emergencies, transcripts };
  return { controller: new AsteriskConversationController(deps), sessions, emergencies, transcripts };
}

const connect = { callSessionId: 'CALL-1', emergencyId: 'EMG-1', language: 'en' };
const utterance = { callSessionId: 'CALL-1', emergencyId: 'EMG-1', language: 'en', text: 'he is not breathing' };

describe('AsteriskConversationController', () => {
  it('starts a protocol from the emergency incident type and persists the opening as SYSTEM', async () => {
    const { controller, sessions, transcripts } = build();
    sessions.startImpl = async () =>
      turn({ session: { id: 'PSE-9' }, speech: 'Opening instruction.' });

    const result = await controller.onCallConnected(connect);

    expect(sessions.started).toHaveLength(1);
    expect(sessions.started[0]).toMatchObject({ emergencyId: 'EMG-1', incidentType: 'CARDIAC_ARREST' });
    expect(transcripts.appended).toEqual([
      { callSessionId: 'CALL-1', speaker: 'SYSTEM', text: 'Opening instruction.' },
    ]);
    expect(result).toMatchObject({ speech: 'Opening instruction.', verbatimProtocolText: true, terminal: false });
  });

  it('defaults to OTHER only when the emergency has no incident type', async () => {
    const { controller, sessions, emergencies } = build();
    emergencies.incidentType = null;

    await controller.onCallConnected(connect);

    expect(sessions.started[0]!.incidentType).toBe('OTHER');
  });

  it('treats a paraphrased reply as non-verbatim so it is never recorded as reviewed text', async () => {
    const { controller, sessions } = build();
    sessions.startImpl = async () => turn({ paraphrased: true, speech: 'The model rewrote this.' });

    const result = await controller.onCallConnected(connect);

    expect(result?.verbatimProtocolText).toBe(false);
  });

  it('writes the SYSTEM reply after the caller line, in speaking order', async () => {
    const { controller, sessions, transcripts } = build();
    sessions.startImpl = async () => turn({ speech: 'Opening.' });
    sessions.handleImpl = async () => turn({ speech: 'Next, press hard and fast.' });

    await controller.onCallConnected(connect);
    // Module 2 has already stored the CALLER line by the time the controller runs.
    transcripts.appended.push({ callSessionId: 'CALL-1', speaker: 'CALLER', text: 'he is not breathing' });
    const result = await controller.onCallerUtterance(utterance);

    expect(transcripts.appended.map((line) => `${line.speaker}: ${line.text}`)).toEqual([
      'SYSTEM: Opening.',
      'CALLER: he is not breathing',
      'SYSTEM: Next, press hard and fast.',
    ]);
    expect(result).toMatchObject({ speech: 'Next, press hard and fast.', verbatimProtocolText: true });
  });

  it('passes the caller text to handleUtterance unchanged', async () => {
    const { controller, sessions } = build();
    await controller.onCallConnected(connect);

    await controller.onCallerUtterance(utterance);

    expect(sessions.handled).toEqual([{ sessionId: 'PSE-1', utterance: 'he is not breathing' }]);
  });

  it('stops prompting once a turn reaches a terminal status', async () => {
    const { controller, sessions } = build();
    await controller.onCallConnected(connect);
    sessions.handleImpl = async () => turn({ status: 'ESCALATED', speech: 'Paramedics are being sent.' });

    const escalated = await controller.onCallerUtterance(utterance);
    const after = await controller.onCallerUtterance({ ...utterance, text: 'are they coming?' });

    expect(escalated).toMatchObject({ terminal: true, speech: 'Paramedics are being sent.' });
    // The second utterance must not reach the engine again.
    expect(after).toBeNull();
    expect(sessions.handled).toHaveLength(1);
  });

  it('stops before greeting when the opening turn is already terminal', async () => {
    const { controller, sessions } = build();
    sessions.startImpl = async () => turn({ status: 'COMPLETED', speech: 'Stay with them.' });

    const opening = await controller.onCallConnected(connect);
    const after = await controller.onCallerUtterance(utterance);

    expect(opening).toMatchObject({ terminal: true });
    expect(after).toBeNull();
    expect(sessions.handled).toHaveLength(0);
  });

  it('returns null when the protocol cannot be started, so the bridge can greet instead', async () => {
    const { controller, sessions } = build();
    sessions.startImpl = async () => {
      throw new Error('no protocol for incident');
    };

    const opening = await controller.onCallConnected(connect);
    const after = await controller.onCallerUtterance(utterance);

    expect(opening).toBeNull();
    expect(after).toBeNull();
    expect(sessions.handled).toHaveLength(0);
  });

  it('does not prompt again after an advance failure, and still writes nothing misleading', async () => {
    const { controller, sessions, transcripts } = build();
    await controller.onCallConnected(connect);
    sessions.handleImpl = async () => {
      throw new Error('session already completed');
    };

    const first = await controller.onCallerUtterance(utterance);
    const second = await controller.onCallerUtterance(utterance);

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(sessions.handled).toHaveLength(1);
    // Only the opening instruction was persisted.
    expect(transcripts.appended).toHaveLength(1);
  });

  it('a transcript write failure does not stop the prompt from being spoken', async () => {
    const { controller, sessions, transcripts } = build();
    sessions.startImpl = async () => turn({ speech: 'Check breathing.' });
    transcripts.fail = true;

    const result = await controller.onCallConnected(connect);

    expect(result).toMatchObject({ speech: 'Check breathing.' });
  });

  it('ignores a second connect for the same call', async () => {
    const { controller, sessions } = build();

    const first = await controller.onCallConnected(connect);
    const second = await controller.onCallConnected(connect);

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(sessions.started).toHaveLength(1);
  });
});
