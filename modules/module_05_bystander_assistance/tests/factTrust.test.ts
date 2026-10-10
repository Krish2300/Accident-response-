/**
 * Tests for the boundary between what a protocol is told and what it is allowed to
 * act on.
 *
 * The engine is authoritative and the language layer is not. These tests pin the
 * two rules that follow from that: a report nobody vouched for is never allowed to
 * become part of what the protocol has established, and a value nobody declared is
 * never allowed to influence a transition. Both are easy to break by accident and
 * neither fails loudly when it does.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProtocolLoader } from '../src/protocol_engine/protocolLoader.js';
import { ProtocolEngine } from '../src/protocol_engine/engine.js';
import { createModule5Routes } from '../src/api/routes.js';
import type { Module5 } from '../src/module.js';
import { closedFactValues } from '../src/llm/contracts.js';
import { LlmGateway } from '../src/llm/llmService.js';
import { LLMServiceRegistry } from '../src/llm/llmService.js';
import type { LlmHealth, LLMService } from '../src/llm/contracts.js';

const loader = new ProtocolLoader();

function buildEngine(): ProtocolEngine {
  // The real vocabulary, exactly as the composition root injects it, so these
  // tests fail if the wiring changes rather than if the fixture drifts.
  return new ProtocolEngine(loader, undefined, 3, closedFactValues());
}

const t0 = new Date('2026-01-01T10:00:00.000Z');
const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);

describe('facts that were never verified', () => {
  it('does not advance the protocol on a low-confidence report', () => {
    const engine = buildEngine();
    const state = engine.start('cardiac-arrest-adult', { now: t0 });

    const turn = engine.advance(state, {
      observedFacts: { responsive: 'NO', breathing_status: 'NOT_BREATHING' },
      factsTrusted: false,
      now: at(1),
    });

    expect(turn.result.action).toBe('CLARIFY');
    expect(turn.result.status).toBe('WAITING_FOR_RESPONSE');
    expect(turn.result.currentStepId).toBe('confirm-arrest');
    expect(turn.result.decision.ruleId).toBe('confirm-arrest.untrusted_facts');
    expect(turn.result.decision.decisionType).toBe('QUESTION_REQUIRED');
  });

  it('does not persist the unverified report, so no later turn inherits it', () => {
    // This is the whole reason the gate exists. If the report were merged into the
    // fact bag, the *next* turn — which may report nothing at all — would find
    // `responsive = NO` waiting for it and walk a bystander into chest
    // compressions on evidence nobody ever confirmed.
    const engine = buildEngine();
    const state = engine.start('cardiac-arrest-adult', { now: t0 });

    const untrusted = engine.advance(state, {
      observedFacts: { responsive: 'NO', breathing_status: 'NOT_BREATHING' },
      factsTrusted: false,
      now: at(1),
    });

    expect(untrusted.nextState.facts.responsive).toBeUndefined();
    expect(untrusted.nextState.facts.breathing_status).toBeUndefined();

    // A later turn that says nothing relevant must not advance.
    const later = engine.advance(untrusted.nextState, { observedFacts: {}, now: at(2) });
    expect(later.result.action).toBe('CLARIFY');
    expect(later.result.currentStepId).toBe('confirm-arrest');
    expect(later.result.missingFacts).toEqual(['responsive', 'breathing_status']);
  });

  it('reports the unverified facts in the audit block rather than dropping them silently', () => {
    const engine = buildEngine();
    const state = engine.start('cardiac-arrest-adult', { now: t0 });

    const turn = engine.advance(state, {
      observedFacts: { responsive: 'NO' },
      factsTrusted: false,
      now: at(1),
    });

    expect(turn.result.decision.audit.factsTrusted).toBe(false);
    expect(turn.result.decision.audit.acceptedFacts).toContain('responsive');
    expect(turn.result.decision.audit.protocolSource).toBeTruthy();
    expect(turn.result.decision.audit.reviewStatus).toBe('UNREVIEWED');
  });

  it('still escalates on an unverified dangerous scene', () => {
    // The asymmetry is deliberate and must not be "tidied" away: escalating on a
    // false positive costs an operator a look at the call, while failing to escalate
    // on a real one costs a bystander walking into traffic.
    const engine = buildEngine();
    const state = engine.start('cardiac-arrest-adult', { now: t0 });

    const turn = engine.advance(state, {
      observedFacts: { scene_safe: 'NO' },
      factsTrusted: false,
      now: at(1),
    });

    expect(turn.result.action).toBe('ESCALATED');
    expect(turn.result.decision.escalation?.ruleId).toBe('scene-safety-first');
  });

  it('hands over to a human rather than asking an unverified caller forever', () => {
    const engine = buildEngine();
    let state = engine.start('cardiac-arrest-adult', { now: t0 });

    let action = '';
    for (let i = 0; i < 6; i += 1) {
      const turn = engine.advance(state, {
        observedFacts: { breathing_status: 'GASPNING_AGAINST' },
        factsTrusted: false,
        now: at(i + 1),
      });
      action = turn.result.action;
      state = turn.nextState;
      if (action === 'ESCALATED') break;
    }

    expect(action).toBe('ESCALATED');
  });

  it('does advance on the same facts once they arrive from a source that vouches for them', () => {
    // The gate must not be a dead end: a trusted report of the same facts moves
    // the protocol exactly as it would have before.
    const engine = buildEngine();
    const state = engine.start('cardiac-arrest-adult', { now: t0 });

    const turn = engine.advance(state, {
      observedFacts: { responsive: 'NO', breathing_status: 'NOT_BREATHING' },
      factsTrusted: true,
      now: at(1),
    });

    expect(turn.result.action).toBe('ADVANCED');
    expect(turn.nextState.facts.responsive).toBe('NO');
  });
});

describe('values nobody declared', () => {
  it('drops a value outside the declared vocabulary instead of acting on it', () => {
    // `scene_safe ne YES` is true for any *known* value the protocol did not
    // enumerate. A hallucinated token therefore satisfies the unsafe-scene
    // escalation and halts a call over nonsense.
    const engine = buildEngine();
    const state = engine.start('cardiac-arrest-adult', { now: t0 });

    const turn = engine.advance(state, {
      observedFacts: { scene_safe: 'YESSS' },
      factsTrusted: true,
      now: at(1),
    });

    expect(turn.result.decision.audit.rejectedFacts).toEqual([
      { fact: 'scene_safe', reason: expect.stringContaining('YESSS') },
    ]);
    expect(turn.result.action).not.toBe('ESCALATED');
    expect(turn.nextState.facts.scene_safe).toBeUndefined();
  });

  it('asks again rather than guessing which declared value was meant', () => {
    const engine = buildEngine();
    const state = engine.start('cardiac-arrest-adult', { now: t0 });

    const turn = engine.advance(state, {
      observedFacts: { responsive: 'NO', breathing_status: 'GASPING_AGAINS' },
      factsTrusted: true,
      now: at(1),
    });

    expect(turn.result.action).toBe('CLARIFY');
    expect(turn.result.missingFacts).toEqual(['breathing_status']);
  });

  it('accepts the catalogue\'s own term for agonal breathing', () => {
    // The ERC source transcribed into the catalogue calls agonal breathing
    // AGHASTIC and uses it alongside GASPNING_AGAINST. Rejecting it would leave
    // those catalogue conditions unreachable however the caller described it.
    const engine = buildEngine();
    const state = engine.start('cardiac-arrest-adult', { now: t0 });

    const turn = engine.advance(state, {
      observedFacts: { responsive: 'NO', breathing_status: 'AGHASTIC' },
      factsTrusted: true,
      now: at(1),
    });

    expect(turn.result.decision.audit.rejectedFacts).toEqual([]);
    expect(turn.result.action).toBe('ADVANCED');
  });

  it('leaves an unbounded fact alone, because the caller may have anything to say', () => {
    // `notes` and `mechanism` are free text. Applying an enum to them would reject
    // the majority of real answers.
    const engine = buildEngine();
    const state = engine.start('cardiac-arrest-adult', { now: t0 });

    const turn = engine.advance(state, {
      observedFacts: { notes: 'collapsed at the kerb, neighbours are shouting' },
      factsTrusted: true,
      now: at(1),
    });

    expect(turn.result.decision.audit.rejectedFacts).toEqual([]);
    expect(turn.nextState.facts.notes).toContain('kerb');
  });

  it('keeps facts no condition references, and says which ones those are', () => {
    const engine = buildEngine();
    const state = engine.start('cardiac-arrest-adult', { now: t0 });

    const turn = engine.advance(state, {
      observedFacts: { mechanism: 'fell down the stairs', age_group: 'ADULT' },
      factsTrusted: true,
      now: at(1),
    });

    expect(turn.nextState.facts.mechanism).toBe('fell down the stairs');
    expect(turn.result.decision.audit.unsupportedFacts).toContain('mechanism');
  });
});

describe('a session that has already ended', () => {
  it('reports itself held rather than working out the next instruction', () => {
    // Re-deriving a transition from a finished session is how a cancelled protocol
    // ends up delivering one more instruction after the ambulance is on scene.
    const engine = buildEngine();
    const state = engine.start('cardiac-arrest-adult', { now: t0 });
    const cancelled: typeof state = { ...state, status: 'CANCELLED' };

    const turn = engine.advance(cancelled, { observedFacts: { responsive: 'NO' }, now: at(1) });

    expect(turn.result.action).toBe('HELD');
    expect(turn.result.status).toBe('CANCELLED');
    expect(turn.result.events).toEqual([]);
    expect(turn.result.stepUpdates).toEqual([]);
    expect(turn.result.decision.decisionType).toBe('HELD');
    // The report is still on the record, but it did not change the session.
    expect(turn.result.facts.responsive).toBeUndefined();
    expect(turn.result.decision.audit.acceptedFacts).toContain('responsive');
  });
});

describe('the decision a session is standing at', () => {
  it('previews the current step instead of the one it would move to next', () => {
    const engine = buildEngine();
    const state = engine.start('cardiac-arrest-adult', {
      facts: { responsive: 'NO', breathing_status: 'NOT_BREATHING' },
      now: t0,
    });

    const preview = engine.turnDecision(state, { now: at(1) });

    expect(preview.action).toBe('HELD');
    expect(preview.currentStepId).toBe('confirm-arrest');
    expect(preview.decision.currentState).toBe('confirm-arrest');
    expect(preview.decision.nextState).toBe('confirm-arrest');
    expect(preview.decision.decisionType).toBe('QUESTION_REQUIRED');
    expect(preview.events).toEqual([]);
  });

  it('gives every decision a stable instruction id and a question id', () => {
    const engine = buildEngine();
    const state = engine.start('cardiac-arrest-adult', { now: t0 });

    const first = engine.turnDecision(state, { now: at(1) });
    const second = engine.turnDecision(state, { now: at(1) });

// The engine always issues an instruction; the field is nullable only so a
    // caller that renders a decision for a session with nothing to say has a way to
    // express that.
    expect(first.decision.instruction?.instructionId).toBe('cardiac-arrest-adult@1.0.0:confirm-arrest');
    expect(first.decision.requiredQuestion?.questionId).toBe('cardiac-arrest-adult@1.0.0:confirm-arrest#q1');
    expect(second.decision.instruction?.instructionId).toBe(first.decision.instruction?.instructionId);
    // The attempt number comes from the session, so a repeat is addressable.
    expect(first.decision.requiredQuestion?.attempt).toBe(1);
  });

  it('never puts a model-authored string into the decision', () => {
    const engine = buildEngine();
    const state = engine.start('cardiac-arrest-adult', { now: t0 });
    const decision = engine.turnDecision(state, { now: at(1) }).decision;

    // The instruction is a verbatim catalogue string; the reference is the file.
    const protocol = loader.get('cardiac-arrest-adult');
    const step = protocol.steps.find((s) => s.step_id === 'confirm-arrest')!;
    expect(decision.instruction?.text).toBe(step.instruction);
    expect(decision.completed).toBe(false);
  });
});

/** Runs `work` and returns whatever it threw, so its `details` can be inspected. */
function captureError(work: () => unknown): Error {
  try {
    work();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the call to fail, but it did not');
}

describe('the public http surface', () => {
  // The engine is only as safe as the easiest way in. These assert on the route
  // declarations rather than on the handler bodies, so they hold even though the
  // handlers are covered end to end elsewhere.
  const routes = createModule5Routes({ sessions: {} } as unknown as Module5);
  const route = (method: string, url: string) =>
    routes.find((r) => r.method === method && r.url === url)!;

  const parse = (method: string, url: string, body: unknown) =>
    route(method, url).body!.safeParse(body);

  it('will not accept caller-asserted facts when starting a session', () => {
    // A client could otherwise pre-load the protocol's entry conditions and its
    // scene-safety escalation and reach an instruction without ever speaking.
    const result = parse('POST', '/api/protocol-sessions', {
      emergencyId: 'EMG_1',
      incidentType: 'CARDIAC_ARREST',
      facts: { responsive: 'NO', breathing_status: 'NOT_BREATHING', scene_safe: 'NO' },
    });

    expect(result.success).toBe(false);
  });

  it('still starts a session with the fields a client legitimately has', () => {
    const result = parse('POST', '/api/protocol-sessions', {
      emergencyId: 'EMG_1',
      incidentType: 'CARDIAC_ARREST',
    });
    expect(result.success).toBe(true);
  });

  it('will not accept a self-chosen escalation reason on the utterance route', () => {
    // Escalating is an operator action and has one route of its own, behind the
    // role check. Here it would be recorded as though an operator had said it.
    const result = parse('POST', '/api/protocol-sessions/:id/utterance', {
      utterance: 'he is not breathing',
      forceEscalationReason: 'because I said so',
    });

    expect(result.success).toBe(false);
  });

  it('accepts a plain utterance', () => {
    expect(
      parse('POST', '/api/protocol-sessions/:id/utterance', { utterance: 'he is not breathing' }).success,
    ).toBe(true);
  });

  it('keeps every operator action off the public routes', () => {
    const publicUrls = routes.filter((r) => r.auth?.public).map((r) => `${r.method} ${r.url}`);
    expect(publicUrls).not.toContain('POST /api/protocol-sessions/:id/escalate');
    expect(publicUrls).not.toContain('POST /api/protocol-sessions/:id/cancel');
    // Escalation is the one action a bystander must never be able to trigger.
    for (const r of routes) {
      if (r.url.endsWith('/escalate')) {
        expect(r.auth?.public).toBeUndefined();
        expect(r.auth?.roles).toBeTruthy();
      }
    }
  });
});

describe('catalogue loading', () => {
  let dir: string | null = null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'protocols-'));
  });

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const realProtocol = (): string =>
    readFileSync(join(loader.protocolDir, 'cardiac-arrest-adult.json'), 'utf8');

  it('refuses to serve a catalogue where two files claim the same id and version', () => {
    // Without this, the winner is whichever the filesystem lists first, so a stray
    // copy could silently shadow a reviewed protocol.
    const body = realProtocol();
    writeFileSync(join(dir!, 'a-cardiac-arrest.json'), body);
    writeFileSync(join(dir!, 'b-cardiac-arrest.json'), body);

    const duplicate = new ProtocolLoader(dir!);
    // The two offending file names travel in `details`; the message stays generic
    // because it is what a bystander's client would ever be shown.
    const failure = captureError(() => duplicate.load(true));
    expect(failure.message).toMatch(/failed validation/);
    expect(duplicate.lastLoadError).toContain('a-cardiac-arrest.json');
    expect(duplicate.lastLoadError).toContain('b-cardiac-arrest.json');
    expect(duplicate.lastLoadError).toMatch(/duplicate cardiac-arrest-adult@1\.0\.0/);
  });

  it('serves nothing at all when one file in the directory is broken', () => {
    // No "load the good ones anyway": a bystander must not be subject to whether
    // the process started with a partial directory listing.
    writeFileSync(join(dir!, 'cardiac-arrest.json'), realProtocol());
    writeFileSync(join(dir!, 'broken.json'), '{ "protocol_id": ');

    const broken = new ProtocolLoader(dir!);
    expect(() => broken.load(true)).toThrowError(/failed validation/);
    expect(() => broken.get('cardiac-arrest-adult')).toThrowError();
  });

  it('refuses a transition that points at a step that does not exist', () => {
    // Otherwise this surfaces as a 500 mid-call, to a bystander.
    const body = JSON.parse(realProtocol());
    const step = body.steps.find((s: { step_id: string }) => s.step_id === 'confirm-arrest');
    step.transitions[0].to = 'no-such-step';
    writeFileSync(join(dir!, 'cardiac-arrest.json'), JSON.stringify(body));

    const dangling = new ProtocolLoader(dir!);
    captureError(() => dangling.load(true));
    expect(dangling.lastLoadError).toContain('no-such-step');
  });
});

describe('llm health', () => {
  class CountingProvider implements LLMService {
    readonly providerName = 'counting';
    readonly model = 'counting-model';
    probes = 0;
    available = true;

    async health(): Promise<LlmHealth> {
      this.probes += 1;
      return {
        provider: this.providerName,
        model: this.model,
        available: this.available,
        checkedAt: new Date().toISOString(),
      };
    }

    async extract(): Promise<never> {
      throw new Error('not used');
    }
    async generate(): Promise<never> {
      throw new Error('not used');
    }
    async classify(): Promise<never> {
      throw new Error('not used');
    }
    async respond(): Promise<never> {
      throw new Error('not used');
    }
  }

  const config = {
    provider: 'counting',
    model: 'counting-model',
    ollamaBaseUrl: '',
    timeoutMs: 1000,
    temperature: 0,
    numCtx: 1024,
    allowHeuristicFallback: false,
  };

  it('probes once per window instead of once per utterance', async () => {
    // Resolution runs on every turn. A network probe per turn would add a round
    // trip to a live call and let a slow provider push the protocol past its own
    // turn budget.
    const provider = new CountingProvider();
    const registry = ((): LLMServiceRegistry => { const r = new LLMServiceRegistry(); r.register(provider); return r; })();
    let clock = 0;
    const gateway = new LlmGateway(
      registry,
      config,
      { debug() {}, info() {}, warn() {}, error() {} },
      15_000,
      () => clock,
    );

    await gateway.resolve();
    await gateway.resolve();
    await gateway.resolve();
    expect(provider.probes).toBe(1);

    clock += 15_001;
    await gateway.resolve();
    expect(provider.probes).toBe(2);
  });

  it('reports whether the answer it is giving is cached', async () => {
    const provider = new CountingProvider();
    const registry = ((): LLMServiceRegistry => { const r = new LLMServiceRegistry(); r.register(provider); return r; })();
    let clock = 0;
    const gateway = new LlmGateway(
      registry,
      config,
      { debug() {}, info() {}, warn() {}, error() {} },
      15_000,
      () => clock,
    );

    const first = await gateway.health();
    expect(first.cached).toBe(false);
    clock += 1_000;
    const second = await gateway.health();
    expect(second.cached).toBe(true);
    expect(provider.probes).toBe(1);
  });

  it('refuses to proceed rather than inventing output when no provider is available', async () => {
    const provider = new CountingProvider();
    provider.available = false;
    const registry = ((): LLMServiceRegistry => { const r = new LLMServiceRegistry(); r.register(provider); return r; })();
    const gateway = new LlmGateway(registry, config, { debug() {}, info() {}, warn() {}, error() {} });

    await expect(gateway.resolve()).rejects.toThrowError(/unavailable/);
  });
});
