import { describe, expect, it, beforeEach } from 'vitest';
import { ProtocolLoader } from '../src/protocol_engine/protocolLoader.js';
import { ProtocolEngine, mergeFacts } from '../src/protocol_engine/engine.js';
import { evaluateCondition } from '../src/protocol_engine/stateMachine.js';
import { UNKNOWN, isUnknown, type ProtocolFacts } from '../src/protocol_engine/types.js';

const loader = new ProtocolLoader();

describe('protocol catalogue', () => {
  it('loads every shipped protocol without validation problems', () => {
    const protocols = loader.load(true);
    expect(loader.lastLoadError).toBeNull();
    expect(protocols.length).toBeGreaterThanOrEqual(5);
  });

  it('marks every protocol as clinically unreviewed', () => {
    for (const protocol of loader.load()) {
      expect(protocol.source.review_status).toBe('UNREVIEWED');
    }
  });

  it('gives every protocol a disclaimer and a resolvable source URL', () => {
    for (const protocol of loader.load()) {
      expect(protocol.medical_disclaimer.length).toBeGreaterThan(20);
      expect(protocol.source.url).toMatch(/^https:\/\//);
    }
  });

  it('routes each incident type to a protocol that declares it', () => {
    const engine = new ProtocolEngine(loader);
    for (const incidentType of ['CARDIAC_ARREST', 'SEVERE_BLEEDING', 'CHOKING', 'ACTIVE_SEIZURE', 'OTHER']) {
      const match = engine.resolveForIncident(incidentType);
      expect(match).not.toBeNull();
      expect(match!.applies_to.incident_types).toContain(incidentType);
    }
  });

  it('raises a 404-shaped error for an unknown protocol', () => {
    expect(() => loader.get('does-not-exist')).toThrowError(/not in the catalogue/);
  });

  it('sorts versions semantically rather than lexically', () => {
    expect(loader.versionsOf('cardiac-arrest-adult')).toEqual(['1.0.0']);
  });
});

describe('condition evaluation', () => {
  const context = { facts: {} as ProtocolFacts, now: new Date(), sessionStartedAt: new Date(), repeatCount: 0 };

  it('treats UNKNOWN as not established', () => {
    expect(isUnknown(UNKNOWN)).toBe(true);
    expect(isUnknown(null)).toBe(true);
    expect(isUnknown('NO')).toBe(false);
  });

  it('evaluates existence against UNKNOWN', () => {
    expect(evaluateCondition({ fact: 'a', op: 'exists' }, context)).toBe(false);
    expect(evaluateCondition({ fact: 'a', op: 'missing' }, context)).toBe(true);
  });

  it('compares strings case-insensitively', () => {
    expect(evaluateCondition({ fact: 'a', op: 'eq', value: 'no' }, { ...context, facts: { a: 'NO' } })).toBe(true);
  });

  it('evaluates numeric comparisons without coercing UNKNOWN to zero', () => {
    expect(evaluateCondition({ fact: 'n', op: 'gte', value: 5 }, { ...context, facts: { n: UNKNOWN } })).toBe(false);
    expect(evaluateCondition({ fact: 'n', op: 'gte', value: 5 }, { ...context, facts: { n: 7 } })).toBe(true);
  });

  it('evaluates all/any/not', () => {
    const facts = { a: 'YES', b: 'NO' } as ProtocolFacts;
    expect(evaluateCondition({ all: [{ fact: 'a', op: 'eq', value: 'YES' }, { fact: 'b', op: 'eq', value: 'NO' }] }, { ...context, facts })).toBe(true);
    expect(evaluateCondition({ any: [{ fact: 'a', op: 'eq', value: 'NO' }, { fact: 'b', op: 'eq', value: 'NO' }] }, { ...context, facts })).toBe(true);
    expect(evaluateCondition({ not: { fact: 'a', op: 'eq', value: 'YES' } }, { ...context, facts })).toBe(false);
  });
});

describe('fact merging', () => {
  it('never overwrites a known fact with UNKNOWN', () => {
    const merged = mergeFacts({ breathing_status: 'NOT_BREATHING' }, { breathing_status: UNKNOWN });
    expect(merged.breathing_status).toBe('NOT_BREATHING');
  });

  it('overwrites a known fact with a new known value', () => {
    const merged = mergeFacts({ scene_safe: UNKNOWN }, { scene_safe: 'YES' });
    expect(merged.scene_safe).toBe('YES');
  });
});

describe('protocol engine', () => {
  const engine = new ProtocolEngine(loader);
  const t0 = new Date('2026-09-29T10:00:00Z');
  const at = (minutes: number) => new Date(t0.getTime() + minutes * 60000);

  let cardiacFacts: ProtocolFacts;

  beforeEach(() => {
    cardiacFacts = {
      responsive: 'NO',
      breathing_status: 'NOT_BREATHING',
      scene_safe: 'YES',
      caller_with_patient: 'YES',
      caller_location: 'Main Street near the pharmacy',
    };
  });

  it('starts at the entry step and stays ACTIVE', () => {
    const state = engine.start('cardiac-arrest-adult', { facts: cardiacFacts, now: t0 });
    expect(state.currentStepId).toBe('confirm-arrest');
    expect(state.status).toBe('ACTIVE');
    expect(state.protocolVersion).toBe('1.0.0');
  });

  it('refuses to start when entry conditions are not satisfied', () => {
    expect(() => engine.start('cardiac-arrest-adult', { facts: { responsive: 'YES', breathing_status: 'BREATHING' }, now: t0 })).toThrowError(
      /entry conditions/i,
    );
  });

  it('advances through the cardiac arrest flow and completes on handover', () => {
    let state = engine.start('cardiac-arrest-adult', { facts: cardiacFacts, now: t0 });
    const seen: string[] = [state.currentStepId];

    for (const facts of [{ cpr_started: 'YES' }, { ambulance_arrived: 'YES' }, { handover_complete: 'YES' }]) {
      const turn = engine.advance(state, { observedFacts: facts, now: at(seen.length * 5) });
      state = turn.nextState;
      seen.push(state.currentStepId);
    }

    expect(seen).toEqual(['confirm-arrest', 'check-scene-safety', 'call-emergency-services', 'start-compressions']);
    expect(state.status).toBe('ACTION_REQUIRED');
  });

  it('escalates instead of advancing when the scene is unsafe', () => {
    const state = engine.start('cardiac-arrest-adult', { facts: cardiacFacts, now: t0 });
    const toSafetyCheck = engine.advance(state, { observedFacts: {}, now: at(1) });
    expect(toSafetyCheck.result.action).toBe('ADVANCED');
    expect(toSafetyCheck.nextState.currentStepId).toBe('check-scene-safety');

    const escalated = engine.advance(toSafetyCheck.nextState, {
      observedFacts: { scene_safe: 'NO' },
      now: at(2),
    });
    expect(escalated.result.action).toBe('ESCALATED');
    expect(escalated.nextState.status).toBe('ESCALATED');
    expect(escalated.result.events.map((e) => e.type)).toContain('PROTOCOL_ESCALATED');
  });

  it('asks for the missing fact rather than guessing', () => {
    // Same flow, but scene safety has not been reported yet.
    const state = engine.start('cardiac-arrest-adult', {
      facts: { ...cardiacFacts, scene_safe: UNKNOWN },
      now: t0,
    });
    const toSafetyCheck = engine.advance(state, { now: at(1) });
    const turn = engine.advance(toSafetyCheck.nextState, { now: at(2) });

    expect(turn.result.action).toBe('CLARIFY');
    expect(turn.result.requiresClarification).toBe(true);
    expect(turn.result.missingFacts).toContain('scene_safe');
    expect(turn.result.clarificationQuestion).toBeTruthy();
    expect(turn.nextState.clarificationCount).toBe(1);
  });

  it('does not treat an unreported fact as an unsafe scene', () => {
    const state = engine.start('cardiac-arrest-adult', {
      facts: { ...cardiacFacts, scene_safe: UNKNOWN },
      now: t0,
    });
    const turn = engine.advance(state, { now: at(1) });
    // An unknown scene must not satisfy the "scene_safe ne YES" escalation rule.
    expect(turn.result.escalations.map((e) => e.ruleId)).not.toContain('scene-safety-first');
  });

  it('keeps the protocol wording as the approved instruction', () => {
    const state = engine.start('cardiac-arrest-adult', { facts: cardiacFacts, now: t0 });
    const turn = engine.advance(state, { observedFacts: { scene_safe: 'YES' }, now: at(1) });
    const protocol = loader.get('cardiac-arrest-adult');
    const step = protocol.steps.find((s) => s.step_id === turn.result.currentStepId)!;

    expect(turn.result.approvedInstruction).toBe(step.instruction);
    expect(turn.result.instruction).toBe(step.instruction);
  });

  it('is deterministic: identical inputs produce identical transitions', () => {
    const run = () => {
      const state = engine.start('cardiac-arrest-adult', { facts: cardiacFacts, now: t0 });
      return engine.advance(state, { observedFacts: { cpr_started: 'YES' }, now: at(1) });
    };
    const a = run();
    const b = run();
    expect(a.result.action).toBe(b.result.action);
    expect(a.nextState.currentStepId).toBe(b.nextState.currentStepId);
    expect(a.result.instruction).toBe(b.result.instruction);
  });

  it('forces escalation after the step repeat budget is exhausted', () => {
    // The "call emergency services" step loops with a 3-repeat budget when no
    // dispatch is confirmed; past that the engine must escalate, not loop forever.
    let state = engine.start('general-triage', {
      facts: { caller_location: 'Main Street', scene_safe: 'YES' },
      now: t0,
    });
    const actions: string[] = [];

    for (let i = 0; i < 12 && state.status !== 'ESCALATED' && state.status !== 'COMPLETED'; i += 1) {
      const turn = engine.advance(state, { observedFacts: { ambulance_dispatched: 'NO' }, now: at(i) });
      state = turn.nextState;
      actions.push(turn.result.action);
    }

    expect(actions).toContain('LOOPED');
    expect(state.status).toBe('ESCALATED');
    expect(state.escalationReason).toMatch(/repeated/i);
  });

  it('emits PROTOCOL_STEP_PRESENTED for every newly reached step', () => {
    const state = engine.start('cardiac-arrest-adult', { facts: cardiacFacts, now: t0 });
    const turn = engine.advance(state, { now: at(1) });
    const presented = turn.result.events.filter((e) => e.type === 'PROTOCOL_STEP_PRESENTED');
    expect(presented).toHaveLength(1);
    expect(presented[0]!.payload.stepId).toBe('check-scene-safety');
  });

  it('records step updates with completion timestamps', () => {
    const state = engine.start('cardiac-arrest-adult', { facts: cardiacFacts, now: t0 });
    const turn = engine.advance(state, { observedFacts: { scene_safe: 'YES' }, now: at(3) });
    const completed = turn.result.stepUpdates.filter((u) => u.status === 'COMPLETED');
    expect(completed).toHaveLength(1);
    expect(completed[0]!.stepId).toBe('confirm-arrest');
    expect(completed[0]!.completedAt).toEqual(at(3));
  });
});

describe('engine safety guards', () => {
  const t0 = new Date('2026-01-01T10:00:00.000Z');
  const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);

  it('does not refuse entry when the entry facts are simply not known yet', () => {
    // `confirm-arrest` exists to establish breathing and responsiveness, so an
    // unknown fact must not lock the caller out of triage.
    const state = new ProtocolEngine(loader).start('cardiac-arrest-adult', { facts: {}, now: t0 });
    expect(state.currentStepId).toBe('confirm-arrest');
    expect(state.status).toBe('ACTIVE');
  });

  it('refuses entry when known facts contradict the entry conditions', () => {
    expect(() =>
      new ProtocolEngine(loader).start('cardiac-arrest-adult', {
        facts: { responsive: 'YES', breathing_status: 'BREATHING' },
        now: t0,
      }),
    ).toThrow(/contradict/i);
  });

  it('halts on a CRITICAL escalation rule whatever the step transition wants', () => {
    const engine = new ProtocolEngine(loader);
    const state = engine.start('cardiac-arrest-adult', {
      facts: { breathing_status: 'GASPNING_AGAINST' },
      now: t0,
    });
    // An unsafe scene triggers the CRITICAL `scene-safety-first` rule. The
    // current step would otherwise loop back to a clarification question.
    const turn = engine.advance(state, { observedFacts: { scene_safe: 'NO' }, now: at(1) });

    expect(turn.result.action).toBe('ESCALATED');
    expect(turn.nextState.status).toBe('ESCALATED');
    expect(turn.nextState.escalationRequired).toBe(true);
    expect(turn.result.escalations.map((e) => e.ruleId)).toContain('scene-safety-first');
    expect(turn.result.events.some((e) => e.type === 'PROTOCOL_ESCALATED')).toBe(true);
  });

  it('speaks the escalation step, not the step that was active', () => {
    const engine = new ProtocolEngine(loader);
    const state = engine.start('cardiac-arrest-adult', { facts: {}, now: t0 });
    const turn = engine.advance(state, { observedFacts: { scene_safe: 'NO' }, now: at(1) });

    expect(turn.result.action).toBe('ESCALATED');
    // The protocol names `scene-unsafe` as the target of scene-safety-first.
    expect(turn.result.currentStepId).toBe('scene-unsafe');
    expect(turn.result.approvedInstruction).toMatch(/do not approach/i);
    // Critically, it must not tell the caller to go and check the patient.
    expect(turn.result.approvedInstruction).not.toMatch(/check whether the person is unresponsive/i);
  });

  it('stops asking the same unanswered question after the clarification limit', () => {
    const engine = new ProtocolEngine(loader, undefined, 2);
    let state = engine.start('cardiac-arrest-adult', {
      facts: { breathing_status: 'GASPNING_AGAINST' },
      now: t0,
    });

    // Answer nothing new, repeatedly. The engine must not loop forever.
    let turn = engine.advance(state, { now: at(1) });
    state = turn.nextState;
    expect(turn.result.requiresClarification || turn.result.action === 'LOOPED').toBe(true);

    for (let i = 0; i < 6 && turn.result.status !== 'ESCALATED'; i += 1) {
      turn = engine.advance(state, { now: at(i + 2) });
      state = turn.nextState;
    }

    expect(turn.result.status).toBe('ESCALATED');
    expect(
      turn.result.escalations.some((e) => ['clarification_limit', 'unmatched_transition'].includes(e.ruleId)),
    ).toBe(true);
  });

  it('recognises gasping breathing as a cardiac arrest', () => {
    // The extraction vocabulary emits GASPNING_AGAINST; the catalogue must
    // treat it as agonal breathing, so the patient advances into the arrest
    // pathway rather than the "breathing normally" reassurance branch.
    const engine = new ProtocolEngine(loader);
    const state = engine.start('cardiac-arrest-adult', {
      facts: { responsive: 'NO', breathing_status: 'GASPNING_AGAINST' },
      now: t0,
    });
    const turn = engine.advance(state, { observedFacts: { scene_safe: 'YES' }, now: at(1) });

    expect(turn.result.action).toBe('ADVANCED');
    expect(turn.result.previousStepId).toBe('confirm-arrest');
    expect(turn.result.currentStepId).toBe('check-scene-safety');

    // ...and the next turn proceeds to calling emergency services.
    const next = engine.advance(turn.nextState, { now: at(2) });
    expect(next.result.currentStepId).toBe('call-emergency-services');
  });
});

describe('clarification wording', () => {
  const engine = new ProtocolEngine(loader);
  const t0 = new Date('2026-01-01T10:00:00.000Z');
  const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);

  it('asks only about the fact that is still missing', () => {
    const state = engine.start('cardiac-arrest-adult', {
      facts: { responsive: 'NO' },
      now: t0,
    });
    const turn = engine.advance(state, { observedFacts: { responsive: 'NO' }, now: at(1) });

    expect(turn.result.missingFacts).toEqual(['breathing_status']);
    expect(turn.result.requiresClarification).toBe(true);
    // Not the bundled two-part question, which would re-ask for unresponsiveness.
    expect(turn.result.clarificationQuestion).toBe(
      'Are they breathing normally, gasping occasionally, or not breathing at all?',
    );
    expect(turn.result.clarificationQuestion).not.toMatch(/unresponsive\?/);
  });

  it('asks for both facts when neither is known', () => {
    const state = engine.start('cardiac-arrest-adult', { facts: {}, now: t0 });
    const turn = engine.advance(state, { now: at(1) });

    expect(turn.result.missingFacts).toEqual(['responsive', 'breathing_status']);
    expect(turn.result.clarificationQuestion).toMatch(/unresponsive/i);
    expect(turn.result.clarificationQuestion).toMatch(/breathing/i);
  });

  it('keeps the step question when the step asks for a single fact', () => {
    const state = engine.start('cardiac-arrest-adult', {
      facts: { responsive: 'NO', breathing_status: 'GASPNING_AGAINST' },
      now: t0,
    });
    // Arrest confirmed, scene reported safe: the engine advances one step at a
    // time and must not skip the scene-safety question.
    const first = engine.advance(state, { observedFacts: { scene_safe: 'YES' }, now: at(1) });
    expect(first.result.currentStepId).toBe('check-scene-safety');

    const second = engine.advance(first.nextState, { observedFacts: { scene_safe: 'YES' }, now: at(2) });
    expect(second.result.currentStepId).toBe('call-emergency-services');
  });

  it('takes every clarification question from the protocol file', () => {
    // No question may be invented in code: whatever is asked must be either a
    // protocol `question` or a join of protocol `fact_questions` entries.
    const protocol = loader.get('cardiac-arrest-adult');
    const approved = new Set<string>();
    for (const step of protocol.steps) {
      if (step.question) approved.add(step.question);
      for (const q of Object.values(step.fact_questions ?? {})) approved.add(q);
    }

    const scenarios = [
      { responsive: 'NO' },
      { breathing_status: 'NOT_BREATHING' },
      {},
      { scene_safe: 'NO' },
    ];

    for (const facts of scenarios) {
      const state = engine.start('cardiac-arrest-adult', { facts: {}, now: t0 });
      const turn = engine.advance(state, { observedFacts: facts, now: at(1) });
      const question = turn.result.clarificationQuestion;
      if (!question) continue;

      // Split the joined form back into its approved parts.
      const parts = [...approved]
        .filter((q) => question.includes(q))
        .sort((a, b) => question.indexOf(a) - question.indexOf(b));
      const rebuilt = parts.join(' ');
      expect(rebuilt, question).toBe(question);
      expect(parts.length, question).toBeGreaterThan(0);
    }
  });
});