import { describe, expect, it, beforeEach } from 'vitest';
import { AppError, type ProtocolSession, type ProtocolSessionPort, type ProtocolStepRecord } from '@resus/core';
import { Module5 } from '../src/module.js';
import { HeuristicProvider } from '../src/llm/heuristicProvider.js';
import type { LlmHealth, LLMService, Extraction, ProtocolResponse } from '../src/llm/contracts.js';

const CONFIG = {
  llm: {
    provider: 'stub',
    model: 'stub-model',
    ollamaBaseUrl: 'http://127.0.0.1:11434',
    timeoutMs: 1000,
    temperature: 0.1,
    numCtx: 2048,
    allowHeuristicFallback: true,
  },
  protocol: { directory: 'modules/module_05_bystander_assistance/protocols' },
  clarificationLimit: 3,
};

/** In-memory `ProtocolSessionPort`, so the service is tested without a database. */
class FakeSessionPort implements ProtocolSessionPort {
  readonly sessions = new Map<string, ProtocolSession>();
  readonly steps = new Map<string, ProtocolStepRecord[]>();
  /** Every transition ever applied, for asserting atomicity of the call. */
  readonly transitions: unknown[] = [];
  private seq = 0;

  async createSession(input: {
    emergencyId: string;
    protocolId: string;
    protocolVersion: string;
    protocolSource: string;
    currentStep: string;
  }): Promise<ProtocolSession> {
    const now = new Date().toISOString();
    const session: ProtocolSession = {
      id: `PSE_FAKE${(this.seq += 1)}`,
      emergencyId: input.emergencyId,
      protocolId: input.protocolId,
      protocolVersion: input.protocolVersion,
      protocolSource: input.protocolSource,
      currentStep: input.currentStep,
      status: 'ACTIVE',
      startedAt: now,
      updatedAt: now,
      completedAt: null,
      escalationRequired: false,
      escalationReason: null,
      clarificationCount: 0,
      collectedFacts: {},
      initiatedBy: 'SYSTEM',
    };
    this.sessions.set(session.id, session);
    this.steps.set(session.id, []);
    return session;
  }

  async getSession(id: string): Promise<ProtocolSession | null> {
    return this.sessions.get(id) ?? null;
  }

  async listSessionsForEmergency(emergencyId: string): Promise<ProtocolSession[]> {
    return [...this.sessions.values()].filter((s) => s.emergencyId === emergencyId);
  }

  async stepsForSession(id: string): Promise<ProtocolStepRecord[]> {
    return this.steps.get(id) ?? [];
  }

  /** Test helper: simulates a transition that happened outside the service. */
  forceStatus(id: string, status: ProtocolSession['status']): void {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`missing session ${id}`);
    this.sessions.set(id, { ...session, status });
  }

  async applyTransition(input: {
    sessionId: string;
    emergencyId: string;
    currentStep: string;
    status: ProtocolSession['status'];
    completedAt?: Date | null;
    escalationRequired?: boolean;
    escalationReason?: string | null;
    clarificationCount?: number;
    collectedFacts?: Record<string, unknown>;
    degraded?: boolean;
    steps?: Array<{
      stepId: string;
      orderIndex: number;
      status: ProtocolStepRecord['status'];
      presentedAt?: Date | null;
      completedAt?: Date | null;
      result?: Record<string, unknown> | null;
    }>;
    events: unknown[];
  }): Promise<{ session: ProtocolSession; steps: ProtocolStepRecord[] }> {
    const existing = this.sessions.get(input.sessionId);
    if (!existing) throw new Error('missing session');
    // A transition is one unit: state, steps and events are applied together.
    this.transitions.push({ ...input });

    const updated: ProtocolSession = {
      ...existing,
      currentStep: input.currentStep,
      status: input.status,
      updatedAt: new Date().toISOString(),
      completedAt: input.completedAt ? input.completedAt.toISOString() : existing.completedAt,
      escalationRequired: input.escalationRequired ?? existing.escalationRequired,
      escalationReason: input.escalationReason ?? existing.escalationReason,
      clarificationCount: input.clarificationCount ?? existing.clarificationCount,
      collectedFacts: input.collectedFacts ?? existing.collectedFacts,
    };
    this.sessions.set(updated.id, updated);

    const list = this.steps.get(updated.id) ?? [];
    for (const step of input.steps ?? []) {
      const record: ProtocolStepRecord = {
        id: `PST_${step.stepId}`,
        protocolSessionId: updated.id,
        stepId: step.stepId,
        orderIndex: step.orderIndex,
        status: step.status,
        presentedAt: step.presentedAt ? step.presentedAt.toISOString() : null,
        completedAt: step.completedAt ? step.completedAt.toISOString() : null,
        result: step.result ?? null,
      };
      const at = list.findIndex((s) => s.stepId === step.stepId);
      if (at >= 0) list[at] = record;
      else list.push(record);
    }
    this.steps.set(updated.id, list);
    return { session: updated, steps: list };
  }
}

/** A stub LLM whose every response the test controls. */
class StubProvider implements LLMService {
  readonly providerName = 'stub';
  readonly model = 'stub-model';
  extraction: Extraction | Error = {
    intent: 'OTHER',
    entities: {} as Extraction['entities'],
    confidence: 0.5,
    requires_clarification: false,
    clarification_question: null,
    evidence: null,
  };
  reply: ProtocolResponse | Error = { speech: '', tone: 'CALM', echo_of_source: true };
  available = true;

  async health(): Promise<LlmHealth> {
    return {
      provider: this.providerName,
      model: this.model,
      available: this.available,
      checkedAt: new Date().toISOString(),
    };
  }

  async generate(): Promise<never> {
    throw new Error('not used');
  }

  async extract(): Promise<Extraction> {
    if (this.extraction instanceof Error) throw this.extraction;
    return this.extraction;
  }

  async classify(): Promise<never> {
    throw new Error('not used');
  }

  async respond(): Promise<ProtocolResponse> {
    if (this.reply instanceof Error) throw this.reply;
    return this.reply;
  }
}

function build(options: { useHeuristicFallback?: boolean } = {}): {
  module5: Module5;
  port: FakeSessionPort;
  stub: StubProvider;
} {
  const port = new FakeSessionPort();
  const stub = new StubProvider();
  const module5 = new Module5({
    sessions: port,
    config: options.useHeuristicFallback
      ? { ...CONFIG, llm: { ...CONFIG.llm, provider: 'heuristic-fallback', model: 'rule-based' } }
      : CONFIG,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    providers: [stub, new HeuristicProvider()],
  });
  return { module5, port, stub };
}

function extraction(entities: Partial<Extraction['entities']>, intent: Extraction['intent'] = 'OTHER'): Extraction {
  return {
    intent,
    entities: {
      responsive: 'UNKNOWN',
      consciousness: 'UNKNOWN',
      breathing_status: 'UNKNOWN',
      severe_bleeding: 'UNKNOWN',
      choking_signs: 'UNKNOWN',
      seizure_active: 'UNKNOWN',
      chest_pain: 'UNKNOWN',
      scene_safe: 'UNKNOWN',
      caller_with_patient: 'UNKNOWN',
      age_group: 'UNKNOWN',
      patient_count: null,
      mechanism: null,
      duration_minutes: null,
      notes: null,
      ...entities,
    } as Extraction['entities'],
    confidence: 0.8,
    requires_clarification: false,
    clarification_question: null,
    evidence: null,
  };
}

describe('protocol session service', () => {
  beforeEach(() => {
    process.env.PROTOCOL_DIR = 'modules/module_05_bystander_assistance/protocols';
  });

  it('starts a session and returns the catalogue instruction verbatim', async () => {
    const { module5, stub } = build();
    stub.reply = { speech: 'anything', tone: 'CALM', echo_of_source: true };

    const turn = await module5.sessions.start({ emergencyId: 'EMG_1', protocolId: 'cardiac-arrest-adult' });

    expect(turn.session.status).toBe('ACTIVE');
    expect(turn.currentStepId).toBe('confirm-arrest');
    // The stub said "anything", which the safety gate must reject; the protocol
    // text is what gets spoken.
    expect(turn.speech).not.toBe('anything');
    expect(turn.speech).toContain(turn.instruction);
    expect(turn.instruction).toMatch(/unresponsive/i);
  });

  it('selects a protocol from the incident type', async () => {
    const { module5 } = build();
    const turn = await module5.sessions.start({ emergencyId: 'EMG_2', incidentType: 'CARDIAC_ARREST' });
    expect(turn.session.protocolId).toBe('cardiac-arrest-adult');
  });

  it('refuses to start rather than guessing a protocol for an unknown incident', async () => {
    const { module5 } = build();
    await expect(
      module5.sessions.start({ emergencyId: 'EMG_3', incidentType: 'DEFINITELY_NOT_A_REAL_TYPE' }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('asks rather than assuming when the model reports UNKNOWN', async () => {
    const { module5, stub } = build();
    stub.extraction = extraction({ responsive: 'UNKNOWN' });

    const started = await module5.sessions.start({ emergencyId: 'EMG_4', incidentType: 'CARDIAC_ARREST' });
    const turn = await module5.sessions.handleUtterance({ sessionId: started.session.id, utterance: 'uhh' });

    expect(turn.status).toBe('WAITING_FOR_RESPONSE');
    expect(turn.requiresClarification).toBe(true);
    expect(turn.clarificationQuestion).toBeTruthy();
  });

  it('keeps running on the catalogue when fact extraction fails entirely', async () => {
    const { module5, stub } = build();
    const started = await module5.sessions.start({ emergencyId: 'EMG_5', incidentType: 'CARDIAC_ARREST' });

    stub.extraction = new Error('ollama exploded');
    const turn = await module5.sessions.handleUtterance({ sessionId: started.session.id, utterance: 'he is not breathing' });

    // A broken model must never fail the caller's session.
    expect(turn.degraded).toBe(true);
    expect(turn.llmNotice).toBeTruthy();
    expect(turn.instruction).toBeTruthy();
  });

  it('escalates on an unsafe scene without being talked past it', async () => {
    const { module5, stub } = build();
    const started = await module5.sessions.start({ emergencyId: 'EMG_6', incidentType: 'CARDIAC_ARREST' });

    stub.extraction = extraction({ scene_safe: 'NO' });
    const turn = await module5.sessions.handleUtterance({ sessionId: started.session.id, utterance: 'there are wires everywhere' });

    expect(turn.escalationRequired).toBe(true);
    expect(turn.status).toBe('ESCALATED');
  });

  it('escalates a looped step rather than repeating forever', async () => {
    const { module5, stub } = build();
    const started = await module5.sessions.start({ emergencyId: 'EMG_7', incidentType: 'CARDIAC_ARREST' });
    // Gasping breathing satisfies neither the "arrest confirmed" nor the
    // "breathing normally" transition, so the protocol must loop.
    stub.extraction = extraction({ breathing_status: 'GASPNING_AGAINST' });

    let turn = await module5.sessions.handleUtterance({ sessionId: started.session.id, utterance: 'gasping' });
    for (let i = 0; i < 8 && turn.status !== 'ESCALATED'; i += 1) {
      turn = await module5.sessions.handleUtterance({ sessionId: started.session.id, utterance: 'still gasping' });
    }
    expect(turn.status).toBe('ESCALATED');
    expect(turn.escalationRequired).toBe(true);
  });

  it('speaks the protocol text when the model invents a dose', async () => {
    const { module5, stub } = build();
    const started = await module5.sessions.start({ emergencyId: 'EMG_8', protocolId: 'cardiac-arrest-adult' });
    stub.reply = { speech: 'Give them 500 mg of aspirin now.', tone: 'CALM', echo_of_source: true };

    const turn = await module5.sessions.handleUtterance({ sessionId: started.session.id, utterance: 'what do I do' });
    expect(turn.paraphrased).toBe(false);
    expect(turn.speech).not.toContain('500');
    expect(turn.speech).toContain(turn.instruction);
  });

  it('persists facts and bookkeeping together in one transition', async () => {
    const { module5, port, stub } = build();
    const started = await module5.sessions.start({ emergencyId: 'EMG_9', incidentType: 'CARDIAC_ARREST' });
    stub.extraction = extraction({ responsive: 'YES', breathing_status: 'NOT_BREATHING' });

    await module5.sessions.handleUtterance({ sessionId: started.session.id, utterance: 'he collapsed and is not breathing' });

    const last = port.transitions.at(-1) as { collectedFacts: Record<string, unknown>; events: unknown[] };
    expect(last.collectedFacts.responsive).toBe('YES');
    expect(last.collectedFacts.breathing_status).toBe('NOT_BREATHING');
    expect(last.collectedFacts).toHaveProperty('__completedSteps');
    expect(Array.isArray(last.events)).toBe(true);
    expect(last.events.length).toBeGreaterThan(0);
  });

  it('refuses further turns once a session has completed', async () => {
    const { module5, port } = build();
    const started = await module5.sessions.start({ emergencyId: 'EMG_10', incidentType: 'CARDIAC_ARREST' });
    port.forceStatus(started.session.id, 'COMPLETED');

    await expect(
      module5.sessions.handleUtterance({ sessionId: started.session.id, utterance: 'hello' }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('cancels on operator request and stops accepting turns', async () => {
    const { module5 } = build();
    const started = await module5.sessions.start({ emergencyId: 'EMG_11', incidentType: 'CARDIAC_ARREST' });

    const cancelled = await module5.sessions.cancel(started.session.id, 'Ambulance on scene.');
    expect(cancelled.status).toBe('CANCELLED');

    await expect(
      module5.sessions.handleUtterance({ sessionId: started.session.id, utterance: 'still here' }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('records the catalogue review status on the session', async () => {
    const { module5 } = build();
    const turn = await module5.sessions.start({ emergencyId: 'EMG_12', incidentType: 'CARDIAC_ARREST' });
    // Every protocol in this repository is UNREVIEWED and must say so.
    expect(turn.session.protocolSource).toContain('UNREVIEWED');
  });

  it('keeps engine bookkeeping out of API responses while persisting it', async () => {
    const { module5, port, stub } = build();
    const started = await module5.sessions.start({ emergencyId: 'EMG_13', incidentType: 'CARDIAC_ARREST' });
    stub.extraction = extraction({ responsive: 'YES', breathing_status: 'NOT_BREATHING' });

    const turn = await module5.sessions.handleUtterance({
      sessionId: started.session.id,
      utterance: 'he collapsed and is not breathing',
    });

    // Persisted, so a resumed session remembers its progress...
    const last = port.transitions.at(-1) as { collectedFacts: Record<string, unknown> };
    expect(last.collectedFacts).toHaveProperty('__completedSteps');

    // ...but never handed to a client.
    expect(turn.session.collectedFacts).not.toHaveProperty('__completedSteps');
    expect(turn.session.collectedFacts).not.toHaveProperty('__repeatCount');
    expect(turn.session.collectedFacts.responsive).toBe('YES');

    const fetched = await module5.sessions.get(started.session.id);
    expect(fetched.session.collectedFacts).not.toHaveProperty('__completedSteps');
    const listed = await module5.sessions.listForEmergency('EMG_13');
    expect(listed).toHaveLength(1);
    expect(listed[0]?.collectedFacts).not.toHaveProperty('__completedSteps');
  });

  it('asks only about the missing fact, not the whole bundled question', async () => {
    const { module5, stub } = build();
    const started = await module5.sessions.start({ emergencyId: 'EMG_14', incidentType: 'CARDIAC_ARREST' });
    stub.extraction = extraction({ responsive: 'NO' }, 'PATIENT_UNRESPONSIVE');

    const turn = await module5.sessions.handleUtterance({
      sessionId: started.session.id,
      utterance: 'he is unresponsive',
    });

    expect(turn.missingFacts).toEqual(['breathing_status']);
    expect(turn.requiresClarification).toBe(true);
    expect(turn.clarificationQuestion).toMatch(/breathing/i);
    expect(turn.clarificationQuestion).not.toMatch(/unresponsive/i);
  });

  it('routes gasping breathing into the arrest pathway, not reassurance', async () => {
    // Regression guard: gasping used to be read as normal breathing, which sent
    // an unresponsive gasping patient to "keep them warm and wait" instead of
    // cardiac arrest. The whole conversation is driven through the real
    // fallback provider, because that is what runs when the LLM is down.
    const { module5 } = build({ useHeuristicFallback: true });
    const started = await module5.sessions.start({ emergencyId: 'EMG_16', incidentType: 'CARDIAC_ARREST' });

    await module5.sessions.handleUtterance({ sessionId: started.session.id, utterance: 'he is unresponsive' });
    const turn = await module5.sessions.handleUtterance({
      sessionId: started.session.id,
      utterance: 'he is gasping, like really irregular',
    });

    expect(turn.session.collectedFacts.breathing_status).toBe('GASPNING_AGAINST');
    expect(turn.action).toBe('ADVANCED');
    // Into the arrest pathway, which always checks scene safety next.
    expect(turn.currentStepId).toBe('check-scene-safety');
    expect(turn.speech).not.toMatch(/keep talking to the person/i);
  });

  it('halts when the fallback reports an unsafe scene mid-conversation', async () => {
    // End-to-end over the real HeuristicProvider, because the hazard lexicon is
    // what stops a bystander walking into a dangerous scene when the LLM is down.
    const { module5 } = build({ useHeuristicFallback: true });
    const started = await module5.sessions.start({ emergencyId: 'EMG_15', incidentType: 'CARDIAC_ARREST' });

    const turn = await module5.sessions.handleUtterance({
      sessionId: started.session.id,
      utterance: 'there are wires sparking across the road and I cannot reach him',
    });

    expect(turn.escalationRequired).toBe(true);
    expect(turn.status).toBe('ESCALATED');
    expect(turn.escalations.map((e) => e.ruleId)).toContain('scene-safety-first');
    expect(turn.degraded).toBe(true);
    // The caller must hear "do not approach", not the step they were on.
    expect(turn.speech).toMatch(/do not approach/i);
    expect(turn.currentStepId).toBe('scene-unsafe');
  });
});
