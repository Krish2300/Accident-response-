import { describe, expect, it } from 'vitest';
import type { HandleUtteranceInput, ProtocolDecision, StartSessionInput } from '@resus/protocols';
import {
  AsteriskConversationController,
  type ConversationEmergencySource,
  type ConversationSessions,
  type ConversationTranscriptSink,
  type ConversationTurnResult,
} from '../apps/server/src/asterisk/conversationController.js';
import { InstructionLocalizer } from '../apps/server/src/conversation/localizer.js';

/**
 * Module 4 language layer, as seen through the live conversation controller.
 *
 * The controller renders the protocol's reviewed wording *before* it persists and
 * speaks, so the timeline records exactly what the caller heard. These tests pin
 * that ordering and the fallback: with no reviewed entry the protocol wording is
 * spoken and recorded unchanged.
 */

const INSTRUCTION_ID = 'cardiac_arrest@1.0.0:check_response';
const EN = 'Check if they respond, then shout for help.';
const ML = 'അവർ പ്രതികരിക്കുന്നുണ്ടോ എന്ന് പരിശോധിച്ച് സഹായത്തിനായി വിളിക്കുക.';

function decision(overrides: {
  instructionId?: string | null;
  questionId?: string | null;
  questionText?: string | null;
}): ProtocolDecision {
  return {
    instruction: overrides.instructionId
      ? { instructionId: overrides.instructionId, stepId: 'check_response', stepType: 'ACTION', orderIndex: 0, text: EN }
      : null,
    requiredQuestion: overrides.questionId
      ? {
          questionId: overrides.questionId,
          requiredFacts: ['responsive'],
          text: overrides.questionText ?? 'Is the person responding?',
          protocolState: 'check_response',
          attempt: 1,
        }
      : null,
  } as unknown as ProtocolDecision;
}

function turn(overrides: Partial<ConversationTurnResult> = {}): ConversationTurnResult {
  return {
    session: { id: 'PSE-1' },
    status: 'ACTIVE',
    speech: EN,
    tone: 'CALM',
    paraphrased: false,
    instruction: EN,
    question: null,
    decision: decision({ instructionId: INSTRUCTION_ID }),
    ...overrides,
  };
}

class FakeSessions implements ConversationSessions {
  startImpl: (input: StartSessionInput) => Promise<ConversationTurnResult> = async () =>
    turn({ speech: EN });
  handleImpl: (input: HandleUtteranceInput) => Promise<ConversationTurnResult> = async () =>
    turn({ speech: EN });

  async start(input: StartSessionInput): Promise<ConversationTurnResult> {
    return this.startImpl(input);
  }

  async handleUtterance(input: HandleUtteranceInput): Promise<ConversationTurnResult> {
    return this.handleImpl(input);
  }
}

class FakeEmergencies implements ConversationEmergencySource {
  async findById(): Promise<{ incidentType: string } | null> {
    return { incidentType: 'CARDIAC_ARREST' };
  }
}

class FakeTranscripts implements ConversationTranscriptSink {
  readonly appended: Array<{ speaker: string; text: string }> = [];
  async appendTranscript(input: { speaker: string; text: string }): Promise<unknown> {
    this.appended.push({ speaker: input.speaker, text: input.text });
    return {};
  }
}

const connect = { callSessionId: 'CALL-1', emergencyId: 'EMG-1', language: 'ml' };

function build(localizer?: InstructionLocalizer): {
  controller: AsteriskConversationController;
  sessions: FakeSessions;
  transcripts: FakeTranscripts;
} {
  const sessions = new FakeSessions();
  const transcripts = new FakeTranscripts();
  const controller = new AsteriskConversationController({
    sessions,
    emergencies: new FakeEmergencies(),
    transcripts,
    ...(localizer ? { localizer } : {}),
  });
  return { controller, sessions, transcripts };
}

describe('AsteriskConversationController localisation', () => {
  it('persists and speaks the reviewed translation, not the protocol trigger', async () => {
    const localizer = InstructionLocalizer.fromObject({ [INSTRUCTION_ID]: { ml: ML } });
    const { controller, transcripts } = build(localizer);

    const result = await controller.onCallConnected(connect);

    expect(result?.speech).toBe(ML);
    // The timeline must show what the caller heard, so the localised text is what
    // was persisted.
    expect(transcripts.appended).toEqual([{ speaker: 'SYSTEM', text: ML }]);
  });

  it('speaks and records the protocol wording unchanged when there is no translation', async () => {
    const localizer = InstructionLocalizer.fromObject({ other_id: { ml: 'x' } });
    const { controller, transcripts } = build(localizer);

    const result = await controller.onCallConnected(connect);

    expect(result?.speech).toBe(EN);
    expect(transcripts.appended).toEqual([{ speaker: 'SYSTEM', text: EN }]);
  });

  it('leaves speech untouched when no localiser is configured', async () => {
    const { controller, transcripts } = build();

    const result = await controller.onCallConnected(connect);

    expect(result?.speech).toBe(EN);
    expect(transcripts.appended).toEqual([{ speaker: 'SYSTEM', text: EN }]);
  });

  it('does not localise an approved paraphrase, which has no stable key', async () => {
    const localizer = InstructionLocalizer.fromObject({ [INSTRUCTION_ID]: { ml: ML } });
    const { controller, sessions } = build(localizer);
    sessions.startImpl = async () =>
      turn({ speech: 'Please check on them now.', paraphrased: true, instruction: null });

    const result = await controller.onCallConnected(connect);

    expect(result?.speech).toBe('Please check on them now.');
    expect(result?.verbatimProtocolText).toBe(false);
  });

  it('exposes the outstanding question id from the engine decision', async () => {
    const { controller, sessions } = build();
    sessions.startImpl = async () =>
      turn({
        speech: 'Is the person responding?',
        question: 'Is the person responding?',
        decision: decision({ instructionId: INSTRUCTION_ID, questionId: 'cardiac_arrest@1.0.0:q1' }),
      });

    const result = await controller.onCallConnected(connect);

    expect(result?.questionId).toBe('cardiac_arrest@1.0.0:q1');
  });
});
