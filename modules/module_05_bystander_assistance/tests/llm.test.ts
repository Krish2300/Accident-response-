import { describe, expect, it } from 'vitest';
import { OllamaProvider } from '../src/llm/ollamaProvider.js';
import { HeuristicProvider } from '../src/llm/heuristicProvider.js';
import { LLMServiceRegistry, LlmGateway } from '../src/llm/llmService.js';
import { assertSafeRephrasing, normaliseForSafetyCheck } from '../src/llm/safety.js';
import { ErrorCode } from '@resus/core';

const BASE_OPTIONS = { baseUrl: 'http://localhost:11434', model: 'qwen3:8b', timeoutMs: 500 };

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function ollamaReply(content: unknown): Response {
  return jsonResponse({
    model: 'qwen3:8b',
    created_at: new Date().toISOString(),
    done: true,
    message: { role: 'assistant', content: JSON.stringify(content) },
  });
}

describe('safety gate', () => {
  it('rejects invented numbers', () => {
    const verdict = assertSafeRephrasing('Press down hard and fast in the centre of the chest.', 'Press down 30 times per minute.');
    expect(verdict.safe).toBe(false);
    expect(verdict.inventedNumbers).toContain('30');
  });

  it('rejects invented clinical measurements', () => {
    const verdict = assertSafeRephrasing('Give the medicine as directed.', 'Give 5 mg of epinephrine now.');
    expect(verdict.safe).toBe(false);
  });

  it('rejects a reply that drops the required action', () => {
    const verdict = assertSafeRephrasing('Call the emergency number and press on the wound.', 'It is going to be fine.');
    expect(verdict.safe).toBe(false);
    expect(verdict.droppedActions).toContain('call');
  });

  it('accepts a faithful rephrasing that keeps every action', () => {
    const verdict = assertSafeRephrasing(
      'Call the emergency number and press firmly on the wound.',
      'Please call the emergency number, and keep pressing firmly on the wound.',
    );
    expect(verdict.safe).toBe(true);
  });

  it('accepts inflected forms of the action verb', () => {
    const verdict = assertSafeRephrasing('Call the emergency number now.', 'Calling the emergency number is the right thing to do now.');
    expect(verdict.safe).toBe(true);
  });

  it('normalises punctuation and case', () => {
    expect(normaliseForSafetyCheck('Press, hard!')).toBe('press hard');
  });
});

describe('ollama provider error mapping', () => {
  it('maps connection refused to LLM_UNAVAILABLE', async () => {
    const provider = new OllamaProvider({
      ...BASE_OPTIONS,
      fetchImpl: () => Promise.reject(new TypeError('fetch failed')),
    });
    await expect(provider.extract('my dad collapsed')).rejects.toMatchObject({
      code: ErrorCode.LLM_UNAVAILABLE,
    });
  });

  it('maps a timeout to LLM_TIMEOUT', async () => {
    const provider = new OllamaProvider({
      ...BASE_OPTIONS,
      fetchImpl: () => Promise.reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })),
    });
    await expect(provider.extract('hello')).rejects.toMatchObject({ code: ErrorCode.LLM_TIMEOUT });
  });

  it('maps HTTP 500 to LLM_UNAVAILABLE with the status recorded', async () => {
    const provider = new OllamaProvider({
      ...BASE_OPTIONS,
      fetchImpl: () => Promise.resolve(jsonResponse({ error: 'boom' }, false, 500)),
    });
    await expect(provider.extract('hello')).rejects.toMatchObject({ code: ErrorCode.LLM_UNAVAILABLE });
  });

  it('maps a missing model to LLM_MODEL_NOT_FOUND', async () => {
    const provider = new OllamaProvider({
      ...BASE_OPTIONS,
      fetchImpl: () => Promise.resolve(jsonResponse({ error: 'model "qwen3:8b" not found' }, false, 404)),
    });
    await expect(provider.extract('hello')).rejects.toMatchObject({ code: ErrorCode.LLM_MODEL_NOT_FOUND });
  });

  it('maps non-JSON content to LLM_MALFORMED_RESPONSE', async () => {
    const provider = new OllamaProvider({
      ...BASE_OPTIONS,
      fetchImpl: () => Promise.resolve(new Response('I am not JSON at all', { status: 200 })),
    });
    await expect(provider.extract('hello')).rejects.toMatchObject({ code: ErrorCode.LLM_MALFORMED_RESPONSE });
  });

  it('rejects a JSON reply that violates the schema', async () => {
    const provider = new OllamaProvider({
      ...BASE_OPTIONS,
      fetchImpl: () => Promise.resolve(ollamaReply({ intent: 'NOT_A_REAL_INTENT', entities: {} })),
    });
    await expect(provider.extract('hello')).rejects.toMatchObject({
      code: ErrorCode.LLM_OUTPUT_SCHEMA_VIOLATION,
    });
  });
});

describe('ollama provider extraction', () => {
  it('returns a schema-valid extraction from a good reply', async () => {
    const provider = new OllamaProvider({
      ...BASE_OPTIONS,
      fetchImpl: () =>
        Promise.resolve(
          ollamaReply({
            intent: 'PATIENT_NOT_BREATHING',
            entities: { responsive: 'NO', breathing_status: 'NOT_BREATHING', scene_safe: 'UNKNOWN' },
            confidence: 0.8,
            requires_clarification: false,
            clarification_question: null,
            evidence: 'he is not breathing',
          }),
        ),
    });
    const result = await provider.extract('my father is not breathing and is unresponsive');
    expect(result.intent).toBe('PATIENT_NOT_BREATHING');
    expect(result.entities.breathing_status).toBe('NOT_BREATHING');
    // Anything the model left out is filled with UNKNOWN, never guessed.
    expect(result.entities.age_group).toBe('UNKNOWN');
  });

  it('forces clarification when the model is not confident', async () => {
    const provider = new OllamaProvider({
      ...BASE_OPTIONS,
      fetchImpl: () =>
        Promise.resolve(
          ollamaReply({
            intent: 'OTHER',
            entities: {},
            confidence: 0.3,
            requires_clarification: false,
            clarification_question: null,
            evidence: null,
          }),
        ),
    });
    const result = await provider.extract('something happened');
    expect(result.requires_clarification).toBe(true);
    expect(result.clarification_question).toBeTruthy();
  });

  it('never lets an UNKNOWN extraction overwrite a known fact', async () => {
    const provider = new OllamaProvider({
      ...BASE_OPTIONS,
      fetchImpl: () =>
        Promise.resolve(
          ollamaReply({
            intent: 'OTHER',
            entities: { scene_safe: 'UNKNOWN' },
            confidence: 0.9,
            requires_clarification: false,
            clarification_question: null,
            evidence: null,
          }),
        ),
    });
    const result = await provider.extract('unclear', { knownFacts: { scene_safe: 'YES' } });
    expect(result.entities.scene_safe).toBe('YES');
  });
});

describe('ollama provider respond', () => {
  it('falls back to the protocol text when the model invents a dose', async () => {
    const provider = new OllamaProvider({
      ...BASE_OPTIONS,
      fetchImpl: () =>
        Promise.resolve(
          ollamaReply({
            speech: 'Call the emergency number and press on the wound, and give 500 mg of aspirin right now.',
            tone: 'URGENT',
          }),
        ),
    });
    const instruction = 'Call the emergency number and press firmly on the wound.';
    const result = await provider.respond({ instruction });
    expect(result.speech).toBe(instruction);
    expect(result.speech).not.toContain('500');
    expect(result.echo_of_source).toBe(true);
  });

  it('uses the model reply when the safety gate passes', async () => {
    const provider = new OllamaProvider({
      ...BASE_OPTIONS,
      fetchImpl: () =>
        Promise.resolve(
          ollamaReply({
            speech: 'Please call the emergency number now, and keep pressing firmly on the wound.',
            tone: 'URGENT',
          }),
        ),
    });
    const result = await provider.respond({ instruction: 'Call the emergency number and press firmly on the wound.' });
    expect(result.speech).toContain('keep pressing');
    expect(result.tone).toBe('URGENT');
  });
});

describe('ollama health', () => {
  it('reports unavailable when the server cannot be reached', async () => {
    const provider = new OllamaProvider({
      ...BASE_OPTIONS,
      fetchImpl: () => Promise.reject(new TypeError('fetch failed')),
    });
    const health = await provider.health();
    expect(health.available).toBe(false);
    expect(health.degraded).toBe(true);
    expect(health.model).toBe('qwen3:8b');
  });

  it('reports unavailable when the model is not pulled', async () => {
    const provider = new OllamaProvider({
      ...BASE_OPTIONS,
      fetchImpl: () => Promise.resolve(jsonResponse({ models: [{ name: 'llama3:8b' }] })),
    });
    const health = await provider.health();
    expect(health.available).toBe(false);
    expect(health.reason).toMatch(/not pulled/i);
  });

  it('reports available when the model is present', async () => {
    const provider = new OllamaProvider({
      ...BASE_OPTIONS,
      fetchImpl: () => Promise.resolve(jsonResponse({ models: [{ name: 'qwen3:8b' }] })),
    });
    const health = await provider.health();
    expect(health.available).toBe(true);
    expect(health.degraded).toBe(false);
  });
});

describe('heuristic fallback', () => {
  const heuristic = new HeuristicProvider();

  it('always marks itself degraded and never claims to be a language model', async () => {
    const health = await heuristic.health();
    expect(health.degraded).toBe(true);
    expect(health.provider).toBe('heuristic-fallback');
  });

  it('always requires clarification so a human stays involved', async () => {
    const result = await heuristic.extract('my dad is not breathing');
    expect(result.requires_clarification).toBe(true);
    expect(result.confidence).toBeLessThanOrEqual(0.35);
  });

  it('detects the keywords it claims to detect', async () => {
    const result = await heuristic.extract('he is unresponsive and not breathing');
    expect(result.entities.responsive).toBe('NO');
    expect(result.entities.breathing_status).toBe('NOT_BREATHING');
    expect(result.intent).toBe('PATIENT_NOT_BREATHING');
  });

  it('never reports gasping or agonal breathing as normal breathing', async () => {
    // This is the difference between "reassure and monitor" and "start CPR".
    // Gasping in an unresponsive person is cardiac arrest, so collapsing it
    // into BREATHING would talk a bystander out of resuscitation.
    for (const report of [
      'he is gasping, like really irregular',
      'she is making occasional gasping sounds',
      'he is breathing but it sounds gurgling',
      'agonal breathing',
    ]) {
      const result = await heuristic.extract(report);
      expect(result.entities.breathing_status, report).toBe('GASPNING_AGAINST');
      expect(result.entities.breathing_status, report).not.toBe('BREATHING');
      expect(result.intent, report).toBe('PATIENT_NOT_BREATHING');
    }
  });

  it('still reports ordinary breathing as BREATHING', async () => {
    const result = await heuristic.extract('she is breathing normally');
    expect(result.entities.breathing_status).toBe('BREATHING');
  });

  it('leaves unrecognised facts as UNKNOWN rather than guessing', async () => {
    const result = await heuristic.extract('it happened');
    expect(result.entities.breathing_status).toBe('UNKNOWN');
    expect(result.entities.consciousness).toBe('UNKNOWN');
  });

  it('reports an unsafe scene when the caller describes a hazard', async () => {
    for (const report of [
      'there are wires sparking across the road and I cannot reach him',
      'the gas is leaking in here',
      'there is a chemical spill under him',
      'theres an armed man next to the patient',
      'the ceiling is collapsing',
    ]) {
      const result = await heuristic.extract(report);
      expect(result.entities.scene_safe, report).toBe('NO');
    }
  });

  it('does not mistake a reassuring statement for a hazard report', async () => {
    const result = await heuristic.extract('there is no danger, the area is safe');
    expect(result.entities.scene_safe).toBe('YES');
  });

  it('lets a hazard override a reassurance in the same message', async () => {
    const result = await heuristic.extract('he says it is safe but there are live wires');
    expect(result.entities.scene_safe).toBe('NO');
  });

  it('does not treat the mechanism of an injury as a scene hazard', async () => {
    // "fell" describes what happened to the patient, not a danger to the
    // bystander; escalating here would wrongly halt an arrest protocol.
    const result = await heuristic.extract('he fell down the stairs and is unresponsive');
    expect(result.entities.scene_safe).toBe('UNKNOWN');
    expect(result.entities.responsive).toBe('NO');
  });

  it('always flags classification for human review', async () => {
    const classification = await heuristic.classify('he collapsed');
    expect(classification.requires_human_review).toBe(true);
    expect(classification.confidence).toBeLessThanOrEqual(0.2);
  });

  it('echoes protocol text verbatim when rendering a response', async () => {
    const instruction = 'Call the emergency number now.';
    const result = await heuristic.respond({ instruction });
    expect(result.speech).toContain(instruction);
    expect(result.echo_of_source).toBe(true);
  });

  it('refuses free-form generation', async () => {
    await expect(heuristic.generate()).rejects.toThrowError(/does not support free-form/);
  });
});

describe('provider registry', () => {
  it('routes to the registered provider by name', async () => {
    const registry = new LLMServiceRegistry();
    const ollama = new OllamaProvider({
      ...BASE_OPTIONS,
      fetchImpl: () =>
        Promise.resolve(
          ollamaReply({
            incident_type: 'CARDIAC_ARREST',
            severity: 'CRITICAL',
            confidence: 0.9,
            rationale: 'not breathing and unresponsive',
            requires_human_review: false,
          }),
        ),
    });
    registry.register(ollama);
    registry.register(new HeuristicProvider());

    const classification = await registry.get('ollama')!.classify('he is not breathing');
    expect(classification.incident_type).toBe('CARDIAC_ARREST');
    expect(registry.names()).toContain('heuristic-fallback');
  });

  it('returns undefined for an unknown provider so the gateway can reject it', () => {
    const registry = new LLMServiceRegistry();
    expect(registry.get('nope')).toBeUndefined();
  });
});

describe('llm gateway resolution', () => {
  it('uses the primary provider when it is healthy', async () => {
    const registry = new LLMServiceRegistry();
    registry.register(
      new OllamaProvider({
        ...BASE_OPTIONS,
        fetchImpl: () => Promise.resolve(jsonResponse({ models: [{ name: 'qwen3:8b' }] })),
      }),
    );
    const gateway = new LlmGateway(registry, {
      provider: 'ollama',
      model: 'qwen3:8b',
      ollamaBaseUrl: 'http://localhost:11434',
      timeoutMs: 500,
      temperature: 0.1,
      numCtx: 4096,
      allowHeuristicFallback: false,
    });

    const resolved = await gateway.resolve();
    expect(resolved.degraded).toBe(false);
    expect(resolved.service.providerName).toBe('ollama');
  });

  it('falls back to the heuristic provider when the model is unreachable', async () => {
    const registry = new LLMServiceRegistry();
    registry.register(
      new OllamaProvider({
        ...BASE_OPTIONS,
        fetchImpl: () => Promise.reject(new TypeError('fetch failed')),
      }),
    );
    registry.register(new HeuristicProvider());
    const gateway = new LlmGateway(registry, {
      provider: 'ollama',
      model: 'qwen3:8b',
      ollamaBaseUrl: 'http://localhost:11434',
      timeoutMs: 500,
      temperature: 0.1,
      numCtx: 4096,
      allowHeuristicFallback: true,
    });

    const resolved = await gateway.resolve();
    expect(resolved.degraded).toBe(true);
    expect(resolved.service.providerName).toBe('heuristic-fallback');
  });

  it('throws rather than fabricating output when no fallback is allowed', async () => {
    const registry = new LLMServiceRegistry();
    registry.register(
      new OllamaProvider({
        ...BASE_OPTIONS,
        fetchImpl: () => Promise.reject(new TypeError('fetch failed')),
      }),
    );
    const gateway = new LlmGateway(registry, {
      provider: 'ollama',
      model: 'qwen3:8b',
      ollamaBaseUrl: 'http://localhost:11434',
      timeoutMs: 500,
      temperature: 0.1,
      numCtx: 4096,
      allowHeuristicFallback: false,
    });

    await expect(gateway.resolve()).rejects.toMatchObject({ code: ErrorCode.LLM_UNAVAILABLE });
  });

  it('reports a degraded deployment in the health summary', async () => {
    const registry = new LLMServiceRegistry();
    registry.register(
      new OllamaProvider({
        ...BASE_OPTIONS,
        fetchImpl: () => Promise.reject(new TypeError('fetch failed')),
      }),
    );
    const gateway = new LlmGateway(registry, {
      provider: 'ollama',
      model: 'qwen3:8b',
      ollamaBaseUrl: 'http://localhost:11434',
      timeoutMs: 500,
      temperature: 0.1,
      numCtx: 4096,
      allowHeuristicFallback: true,
    });

    const health = await gateway.health();
    expect(health.available).toBe(false);
    expect(health.degraded).toBe(true);
    expect(health.fallbackEnabled).toBe(true);
  });
});
