import { AppError, ErrorCode, createConsoleLogger } from '@resus/core';
import { z } from 'zod';
import {
  classificationSchema,
  extractionSchema,
  responseSchema,
  type Classification,
  type ExtractContext,
  type Extraction,
  type GenerateOptions,
  type GenerateResult,
  type LLMService,
  type LlmHealth,
  type ProtocolResponse,
  type RespondRequest,
} from './contracts.js';
import {
  buildClassificationPrompt,
  buildExtractionPrompt,
  buildRespondPrompt,
  jsonSchemas,
  SYSTEM_CLASSIFICATION,
  SYSTEM_EXTRACTION,
  SYSTEM_RESPOND,
} from './prompts.js';
import { assertSafeRephrasing, normaliseForSafetyCheck } from './safety.js';

export interface OllamaProviderOptions {
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  temperature?: number;
  numCtx?: number;
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  logger?: ReturnType<typeof createConsoleLogger>;
}

/**
 * Local, free, offline inference through Ollama.
 *
 * Failure handling (specification section 7): connection refused, model missing,
 * timeout, malformed body and load failure are each mapped to a distinct error
 * code. None of them can take the process down.
 */
export class OllamaProvider implements LLMService {
  readonly providerName = 'ollama';

  private readonly baseUrl: string;
  readonly model: string;
  private readonly timeoutMs: number;
  private readonly temperature: number;
  private readonly numCtx: number;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: ReturnType<typeof createConsoleLogger>;

  constructor(options: OllamaProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? 30000;
    this.temperature = options.temperature ?? 0.1;
    this.numCtx = options.numCtx ?? 8192;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.logger = options.logger ?? createConsoleLogger('warn', 'module_05.llm');
  }

  get modelName(): string {
    return this.model;
  }

  // -- raw generation ---------------------------------------------------------

  async generate(options: GenerateOptions): Promise<GenerateResult> {
    const messages = options.messages ?? [
      ...(options.system ? [{ role: 'system' as const, content: options.system }] : []),
      ...(options.prompt ? [{ role: 'user' as const, content: options.prompt }] : []),
    ];
    if (messages.length === 0) {
      throw AppError.validation('generate() requires either a prompt or messages.');
    }

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: false,
      options: {
        temperature: options.temperature ?? this.temperature,
        num_ctx: options.numCtx ?? this.numCtx,
        ...(options.maxTokens ? { num_predict: options.maxTokens } : {}),
      },
    };
    // Ollama >= 0.5 accepts a JSON Schema here and constrains decoding to it.
    if (options.schema) body.format = options.schema;

    const started = Date.now();
    const raw = await this.post('/api/chat', body);
    const latencyMs = Date.now() - started;

    const content = extractMessageContent(raw);
    if (content === null) {
      throw new AppError(
        ErrorCode.LLM_MALFORMED_RESPONSE,
        'Ollama returned a response without a message content field.',
        502,
        { provider: this.providerName, model: this.model },
      );
    }
    return { text: content, provider: this.providerName, model: this.model, latencyMs, repaired: false, degraded: false, raw };
  }

  // -- schema-constrained operations -----------------------------------------

  async extract(transcript: string, context: ExtractContext = {}): Promise<Extraction> {
    const prompt = buildExtractionPrompt({
      transcript,
      currentStepQuestion: context.currentStepQuestion ?? null,
      knownFacts: (context.knownFacts ?? {}) as Record<string, unknown>,
      missingFacts: context.missingFacts ?? [],
    });

    const { value, latencyMs, degraded } = await this.generateJson(
      extractionSchema,
      SYSTEM_EXTRACTION,
      prompt,
      jsonSchemas.extraction as unknown as Record<string, unknown>,
    );

    return this.postProcessExtraction(value, context, latencyMs, degraded);
  }

  async classify(
    transcript: string,
    context: { incidentHint?: string; callerLocation?: string } = {},
  ): Promise<Classification> {
    const prompt = buildClassificationPrompt({
      transcript,
      incidentHint: context.incidentHint,
      callerLocation: context.callerLocation,
    });
    const { value, degraded } = await this.generateJson(
      classificationSchema,
      SYSTEM_CLASSIFICATION,
      prompt,
      jsonSchemas.classification as unknown as Record<string, unknown>,
    );
    if (degraded) this.logger.warn({ transcript: transcript.slice(0, 80) }, 'classification from degraded provider');
    return value;
  }

  /**
   * Turns a protocol-approved instruction into speech.
   *
   * Safety gate: the model's output is compared against the source instruction.
   * Any clinical content that is not present in the protocol text (new numbers,
   * dosages, techniques) causes the raw protocol text to be used instead.
   */
  async respond(request: RespondRequest): Promise<ProtocolResponse> {
    const prompt = buildRespondPrompt({
      instruction: request.instruction,
      question: request.question ?? null,
      callerUtterance: request.callerUtterance ?? null,
      tone: request.tone,
    });

    try {
      const { value, degraded } = await this.generateJson(
        responseSchema,
        SYSTEM_RESPOND,
        prompt,
        jsonSchemas.response as unknown as Record<string, unknown>,
      );
      const verdict = assertSafeRephrasing(request.instruction, value.speech);
      if (!verdict.safe) {
        this.logger.warn({ reason: verdict.reason }, 'LLM rephrasing rejected by safety gate; using protocol text');
        return {
          speech: buildSafeSpeech(request),
          tone: request.tone ?? 'CALM',
          echo_of_source: true,
        };
      }
      if (degraded) {
        return { speech: buildSafeSpeech(request), tone: request.tone ?? 'CALM', echo_of_source: true };
      }
      return { ...value, echo_of_source: true };
    } catch (error) {
      if (error instanceof AppError && error.code !== ErrorCode.INTERNAL_ERROR) throw error;
      this.logger.warn({ error: String(error) }, 'respond() failed; using protocol text verbatim');
      return { speech: buildSafeSpeech(request), tone: request.tone ?? 'CALM', echo_of_source: true };
    }
  }

  // -- health -----------------------------------------------------------------

  async health(): Promise<LlmHealth> {
    const checkedAt = new Date().toISOString();
    const started = Date.now();
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/tags`, {
        method: 'GET',
        signal: AbortSignal.timeout(Math.min(this.timeoutMs, 5000)),
      });
      if (!response.ok) {
        return this.unavailable(`Ollama responded with HTTP ${response.status}`, checkedAt, Date.now() - started);
      }
      const body = (await response.json()) as { models?: Array<{ name?: string; model?: string }> };
      const names = (body.models ?? []).map((m) => m.name ?? m.model ?? '');
      const present = names.some(
        (name) => name === this.model || name === `${this.model}:latest` || name.startsWith(`${this.model}:`),
      );
      if (!present) {
        return this.unavailable(
          `Model '${this.model}' is not pulled. Run: ollama pull ${this.model}`,
          checkedAt,
          Date.now() - started,
        );
      }
      return {
        provider: this.providerName,
        model: this.model,
        available: true,
        baseUrl: this.baseUrl,
        latencyMs: Date.now() - started,
        degraded: false,
        checkedAt,
      };
    } catch (error) {
      return this.unavailable(describeNetworkError(error), checkedAt, Date.now() - started);
    }
  }

  private unavailable(reason: string, checkedAt: string, latencyMs: number): LlmHealth {
    return {
      provider: this.providerName,
      model: this.model,
      available: false,
      baseUrl: this.baseUrl,
      reason,
      latencyMs,
      // An unreachable or missing model means the language layer is not doing its
      // job, so the deployment must surface itself as degraded.
      degraded: true,
      checkedAt,
    };
  }

  // -- internals --------------------------------------------------------------

  private async generateJson<T>(
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    system: string,
    prompt: string,
    jsonSchema?: Record<string, unknown>,
  ): Promise<{ value: T; latencyMs: number; degraded: boolean }> {
    const result = await this.generate({ system, prompt, schema: jsonSchema });
    const parsed = parseJsonPayload(result.text);

    if (!parsed.ok) {
      throw new AppError(
        ErrorCode.LLM_MALFORMED_RESPONSE,
        'The language model did not return valid JSON.',
        502,
        { provider: this.providerName, snippet: result.text.slice(0, 200) },
      );
    }

    const validation = schema.safeParse(parsed.value);
    if (!validation.success) {
      throw new AppError(
        ErrorCode.LLM_OUTPUT_SCHEMA_VIOLATION,
        'The language model output did not match the required schema.',
        502,
        {
          provider: this.providerName,
          issues: validation.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
      );
    }
    return { value: validation.data, latencyMs: result.latencyMs, degraded: result.degraded };
  }

  /**
   * Merges extracted facts into already-confirmed facts and enforces the
   * "never invent" rule: an UNKNOWN extraction never overwrites a known value,
   * and a low-confidence extraction is forced to ask for clarification.
   */
  private postProcessExtraction(
    value: Extraction,
    context: ExtractContext,
    latencyMs: number,
    degraded: boolean,
  ): Extraction {
    const known = (context.knownFacts ?? {}) as Record<string, unknown>;
    const entities = { ...value.entities };
    for (const [key, current] of Object.entries(entities)) {
      if ((current === 'UNKNOWN' || current === null) && known[key] !== undefined) {
        (entities as Record<string, unknown>)[key] = known[key];
      }
    }

    const needsClarification =
      value.requires_clarification || value.confidence < 0.5 || degraded;
    return {
      ...value,
      entities: entities as Extraction['entities'],
      requires_clarification: needsClarification,
      clarification_question: needsClarification
        ? (value.clarification_question ?? defaultClarification(context, entities as Extraction['entities']))
        : value.clarification_question,
      confidence: degraded ? Math.min(value.confidence, 0.4) : value.confidence,
    };
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (isTimeout(error)) {
        throw new AppError(
          ErrorCode.LLM_TIMEOUT,
          `The language model did not respond within ${this.timeoutMs}ms.`,
          504,
          { provider: this.providerName, model: this.model },
        );
      }
      throw new AppError(
        ErrorCode.LLM_UNAVAILABLE,
        `Cannot reach Ollama at ${this.baseUrl}. ${describeNetworkError(error)}`,
        503,
        { provider: this.providerName, model: this.model },
      );
    }

    if (response.status === 404) {
      throw new AppError(
        ErrorCode.LLM_MODEL_NOT_FOUND,
        `Ollama has no model '${this.model}'. Run: ollama pull ${this.model}`,
        503,
        { provider: this.providerName, model: this.model },
      );
    }
    if (!response.ok) {
      const detail = await safeText(response);
      throw new AppError(
        ErrorCode.LLM_UNAVAILABLE,
        `Ollama request failed with HTTP ${response.status}.`,
        503,
        { provider: this.providerName, status: response.status, detail: detail.slice(0, 300) },
      );
    }

    try {
      return (await response.json()) as unknown;
    } catch {
      throw new AppError(
        ErrorCode.LLM_MALFORMED_RESPONSE,
        'Ollama returned a body that is not valid JSON.',
        502,
        { provider: this.providerName },
      );
    }
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function extractMessageContent(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const message = (raw as { message?: { content?: unknown } }).message;
  if (message && typeof message.content === 'string') return message.content;
  const response = (raw as { response?: unknown }).response;
  if (typeof response === 'string') return response;
  return null;
}

/** Parses a JSON payload, tolerating markdown code fences around it. */
export function parseJsonPayload(text: string): { ok: true; value: unknown } | { ok: false } {
  const trimmed = text.trim();
  const candidates = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(trimmed.slice(firstBrace, lastBrace + 1));

  for (const candidate of candidates) {
    try {
      const value: unknown = JSON.parse(candidate);
      if (value && typeof value === 'object') return { ok: true, value };
    } catch {
      continue;
    }
  }
  return { ok: false };
}

function isTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'TimeoutError' || error.name === 'AbortError' || /timeout/i.test(error.message))
  );
}

function describeNetworkError(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: { code?: string } }).cause;
    if (cause?.code) return `${error.message} (${cause.code})`;
    return error.message;
  }
  return String(error);
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function buildSafeSpeech(request: RespondRequest): string {
  return request.question ? `${request.instruction} ${request.question}` : request.instruction;
}

function defaultClarification(
  context: ExtractContext,
  entities: Extraction['entities'],
): string {
  const missing = context.missingFacts?.filter((key) => {
    const value = (entities as Record<string, unknown>)[key];
    return value === undefined || value === 'UNKNOWN' || value === null;
  });
  if (missing?.length) {
    return `Before I continue, can you tell me about: ${missing.slice(0, 2).join(' and ')}?`;
  }
  return 'Sorry, I did not catch that. Could you say it again?';
}

export { normaliseForSafetyCheck };
