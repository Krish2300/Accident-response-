import { AppError, ErrorCode, noopLogger, type Logger } from '@resus/core';

/** Module 5 configuration, read from the environment. */
export interface Module5Config {
  llm: {
    provider: string;
    model: string;
    ollamaBaseUrl: string;
    timeoutMs: number;
    temperature: number;
    numCtx: number;
    allowHeuristicFallback: boolean;
  };
  protocol: {
    /** Directory holding the versioned JSON catalogues. */
    directory: string;
  };
  /** Rejects a clarification question beyond this many attempts. */
  clarificationLimit: number;
}

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

export function loadModule5Config(env: NodeJS.ProcessEnv = process.env): Module5Config {
  const provider = env.LLM_PROVIDER?.trim() || 'ollama';
  const model = env.LLM_MODEL?.trim();

  if (provider === 'ollama' && !model) {
    // Failing loudly beats silently running a different model than the operator
    // believes is in use.
    throw new AppError(
      ErrorCode.LLM_MODEL_NOT_FOUND,
      'LLM_MODEL is required when LLM_PROVIDER is "ollama". Set it in .env (see scripts/setup-ollama.ps1).',
      500,
    );
  }

  return {
    llm: {
      provider,
      model: model ?? '',
      ollamaBaseUrl: env.OLLAMA_BASE_URL?.trim() || 'http://127.0.0.1:11434',
      timeoutMs: num(env.LLM_TIMEOUT_MS, 20_000),
      temperature: num(env.LLM_TEMPERATURE, 0.1),
      numCtx: num(env.LLM_NUM_CTX, 4096),
      allowHeuristicFallback: bool(env.LLM_ALLOW_HEURISTIC_FALLBACK, true),
    },
    protocol: {
      directory: env.PROTOCOL_DIR?.trim() || 'modules/module_05_bystander_assistance/protocols',
    },
    // `PROTOCOL_MAX_CLARIFICATIONS` is the documented name; the shorter
    // spelling is accepted so either form in an existing .env takes effect
    // rather than silently reverting to the default.
    clarificationLimit: num(
      env.PROTOCOL_MAX_CLARIFICATIONS ?? env.PROTOCOL_CLARIFICATION_LIMIT,
      3,
    ),
  };
}

export function createModule5Logger(): Logger {
  return noopLogger;
}
