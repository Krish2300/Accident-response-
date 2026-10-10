import { AppError, ErrorCode, createConsoleLogger } from '@resus/core';
import {
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
import { HeuristicProvider } from './heuristicProvider.js';
import { OllamaProvider } from './ollamaProvider.js';

export interface LlmServiceConfig {
  provider: string;
  model: string;
  ollamaBaseUrl: string;
  timeoutMs: number;
  temperature: number;
  numCtx: number;
  allowHeuristicFallback: boolean;
}

/**
 * Registry of available providers.
 *
 * The rest of Module 5 only ever sees `LLMService`. Adding a different local
 * model later means implementing the interface and registering it here; no other
 * file changes. There are no paid providers in this repository.
 */
export class LLMServiceRegistry {
  private readonly providers = new Map<string, LLMService>();

  register(provider: LLMService): void {
    this.providers.set(provider.providerName, provider);
  }

  get(name: string): LLMService | undefined {
    return this.providers.get(name);
  }

  names(): string[] {
    return [...this.providers.keys()];
  }

  list(): LLMService[] {
    return [...this.providers.values()];
  }
}

export interface ResolvedLlm {
  service: LLMService;
  /** True when the primary provider is unusable and the fallback is active. */
  degraded: boolean;
  reason?: string;
}

/**
 * The single entry point used by the protocol session service.
 *
 * Resolution order:
 *   1. the configured provider, if its health check passes;
 *   2. the heuristic fallback, if `allowHeuristicFallback` is enabled;
 *   3. otherwise throw LLM_UNAVAILABLE — never silently fabricate output.
 *
 * Health is cached for a short window. Resolution runs on every utterance, and an
 * HTTP probe per turn would add a network round trip to a live emergency call and
 * let a slow provider push the protocol past its own turn budget. The window is
 * short enough that a provider coming back or going away is picked up within
 * seconds, and it is deliberately not re-checked once per call in `resolve`: the
 * cost of a stale answer is one bad extraction, and the engine treats that as
 * untrusted rather than acting on it.
 */
export class LlmGateway {
  private lastKnownHealth: Map<string, LlmHealth> = new Map();
  private readonly healthCache = new Map<string, { at: number; health: LlmHealth }>();
  private inflight: Map<string, Promise<LlmHealth>> = new Map();

  constructor(
    private readonly registry: LLMServiceRegistry,
    private readonly config: LlmServiceConfig,
    private readonly logger: ReturnType<typeof createConsoleLogger> = createConsoleLogger('warn', 'module_05.llm'),
    private readonly healthTtlMs = 15_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Health for one provider, cached for `healthTtlMs`. */
  private async healthOf(service: LLMService): Promise<LlmHealth> {
    const cached = this.healthCache.get(service.providerName);
    if (cached && this.now() - cached.at < this.healthTtlMs) return cached.health;

    // One probe per provider at a time: concurrent turns that all find the cache
    // cold should not fan out into parallel probes.
    const existing = this.inflight.get(service.providerName);
    if (existing) return existing;

    const probe = service
      .health()
      .then((health) => {
        this.healthCache.set(service.providerName, { at: this.now(), health });
        return health;
      })
      .finally(() => {
        this.inflight.delete(service.providerName);
      });
    this.inflight.set(service.providerName, probe);
    return probe;
  }

  async resolve(): Promise<ResolvedLlm> {
    const primary = this.registry.get(this.config.provider);
    if (!primary) {
      throw new AppError(
        ErrorCode.LLM_UNAVAILABLE,
        `Unknown LLM provider '${this.config.provider}'. Registered: ${this.registry.names().join(', ')}.`,
        503,
      );
    }

    const health = await this.healthOf(primary);
    this.lastKnownHealth.set(primary.providerName, health);
    if (health.available) {
      // The heuristic matcher reports itself available but is not a language
      // model. Configuring it as the primary provider must still surface as a
      // degraded deployment, not as working LLM inference.
      if (primary.providerName === 'heuristic-fallback') {
        return { service: primary, degraded: true, reason: 'Configured as the primary provider.' };
      }
      return { service: primary, degraded: false };
    }

    this.logger.warn(
      { provider: primary.providerName, reason: health.reason },
      'primary LLM provider unavailable',
    );

    if (this.config.allowHeuristicFallback) {
      const fallback = this.registry.get('heuristic-fallback') ?? new HeuristicProvider();
      return { service: fallback, degraded: true, reason: health.reason };
    }

    throw new AppError(
      ErrorCode.LLM_UNAVAILABLE,
      `LLM provider '${primary.providerName}' is unavailable: ${health.reason ?? 'unknown reason'}`,
      503,
      { provider: primary.providerName, model: this.config.model },
    );
  }

  /**
   * Health of every registered provider, for `GET /api/health/llm`.
   *
   * Uses the same cache as `resolve`, and says so in `cached`: an operator
   * debugging an outage needs to know whether the answer is a fresh probe or one
   * that is up to `healthTtlMs` old.
   */
  async health(): Promise<{
    provider: string;
    model: string;
    available: boolean;
    degraded: boolean;
    reason?: string;
    latencyMs?: number;
    baseUrl?: string;
    checkedAt: string;
    cached: boolean;
    registered: string[];
    fallbackEnabled: boolean;
  }> {
    const primary = this.registry.get(this.config.provider);
    const cachedEntry = primary ? this.healthCache.get(primary.providerName) : undefined;
    const primaryHealth = primary
      ? await this.healthOf(primary)
      : {
          provider: this.config.provider,
          model: this.config.model,
          available: false,
          reason: 'Provider is not registered.',
          checkedAt: new Date().toISOString(),
        };

    const effective =
      primaryHealth.available
        ? { degraded: false }
        : this.config.allowHeuristicFallback
          ? { degraded: true, reason: 'Operating on heuristic fallback.' }
          : { degraded: false, reason: 'No fallback enabled; protocol flow is blocked.' };

    return {
      provider: primaryHealth.provider,
      model: primaryHealth.model,
      available: primaryHealth.available,
      latencyMs: primaryHealth.latencyMs,
      baseUrl: primaryHealth.baseUrl,
      reason: primaryHealth.reason ?? effective.reason,
      degraded: Boolean(effective.degraded),
      checkedAt: primaryHealth.checkedAt,
      cached: Boolean(cachedEntry) && this.now() - (cachedEntry?.at ?? 0) < this.healthTtlMs,
      registered: this.registry.names(),
      fallbackEnabled: this.config.allowHeuristicFallback,
    };
  }

  rawHealthFor(provider: string): LlmHealth | undefined {
    return this.lastKnownHealth.get(provider);
  }
}

/**
 * Builds the registry described by `.env`.
 *
 * `extra` registers additional implementations (tests, or a future provider).
 * An unknown configured provider is only tolerated when one of those extra
 * providers actually answers to that name — otherwise a typo in `LLM_PROVIDER`
 * would silently degrade every call, which is exactly the failure this guard
 * exists to prevent.
 */
export function createDefaultRegistry(
  config: LlmServiceConfig,
  extra: LLMService[] = [],
): LLMServiceRegistry {
  const registry = new LLMServiceRegistry();
  const logger = createConsoleLogger('warn', 'module_05.llm');

  const supplied = extra.some((p) => p.providerName === config.provider);

  if (config.provider === 'ollama') {
    registry.register(
      new OllamaProvider({
        baseUrl: config.ollamaBaseUrl,
        model: config.model,
        timeoutMs: config.timeoutMs,
        temperature: config.temperature,
        numCtx: config.numCtx,
        logger,
      }),
    );
  } else if (!supplied) {
    throw new AppError(
      ErrorCode.LLM_UNAVAILABLE,
      `No provider implementation registered for '${config.provider}'. Implement LLMService and register it.`,
      500,
    );
  }

  registry.register(new HeuristicProvider('rule-based', logger));
  for (const provider of extra) registry.register(provider);
  return registry;
}

export type {
  Classification,
  ExtractContext,
  Extraction,
  GenerateOptions,
  GenerateResult,
  LLMService,
  LlmHealth,
  ProtocolResponse,
  RespondRequest,
};
