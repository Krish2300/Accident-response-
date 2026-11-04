import { randomBytes } from 'node:crypto';
import { z } from 'zod';

/**
 * Server configuration.
 *
 * Validated once at boot with Zod so a misconfigured deployment fails
 * immediately and loudly, rather than on the first request that needs the value.
 *
 * The `ASTERISK_*` entries are the media bridge's settings rather than the
 * server's, but they are validated here for the same reason: a greeting, a
 * silence threshold or a bind address discovered to be wrong when a citizen
 * already has the line open is a failure with no easy recovery.
 */
export interface ServerConfig {
  nodeEnv: 'development' | 'test' | 'production';
  isProduction: boolean;
  port: number;
  host: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  corsOrigins: string[] | '*';
  jwtSecret: string;
  jwtExpiresIn: string;
  /** Media bridge: what the system says when an emergency call connects. */
  asterisk: {
    greeting: string;
    greetingTone: 'CALM' | 'URGENT' | 'REASSURING';
    speechRmsThreshold: number;
    hangoverMs: number;
    minUtteranceMs: number;
    maxUtteranceMs: number;
    resolveTimeoutMs: number;
  };
  /**
   * Module 3 (Emergency NLP) integration.
   *
   * Module 3 is an external Python service; the server only invokes it when an
   * operator explicitly asks. It is disabled by default, so a deployment that
   * has not stood the service up keeps working and fails loudly with 503 rather
   * than hanging on an unreachable host.
   */
  nlp: {
    enabled: boolean;
    baseUrl: string;
    timeoutMs: number;
  };
  /**
   * Module 4 (conversation support) integration.
   *
   * Two responsibilities the intended Module 4 owns but that the disconnected
   * Python CLI never provided at the protocol layer: rendering the protocol's
   * reviewed wording into the call's language, and the caller-silence retry
   * budget. Both are off by default, so an unconfigured deployment behaves
   * exactly as before.
   */
  conversation: {
    /** Render protocol wording into the call language from the reviewed table. */
    localisationEnabled: boolean;
    /** Path to the reviewed `instructionId -> language -> text` JSON table. */
    translationsFile: string | null;
    /** Caller silence before a re-prompt, in milliseconds. 0 disables it. */
    silenceTimeoutMs: number;
    /** Re-prompts allowed before the conversation is escalated to an operator. */
    silenceRetryLimit: number;
  };
}

const LEVELS = ['debug', 'info', 'warn', 'error'] as const;

const serverConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(LEVELS).default('info'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  JWT_SECRET: z.string().default(''),
  JWT_EXPIRES_IN: z.string().default('1h'),
  DATABASE_URL: z.string().optional(),

  // Media bridge. Defaults are usable, so a working deployment needs none of
  // these; they exist so the tuning that a real line needs can be changed
  // without a rebuild.
  ASTERISK_GREETING: z.string().default('Emergency line. Tell me what happened.'),
  ASTERISK_GREETING_TONE: z.enum(['CALM', 'URGENT', 'REASSURING']).default('CALM'),
  ASTERISK_SPEECH_RMS_THRESHOLD: z.coerce.number().min(0).max(32767).default(700),
  ASTERISK_HANGOVER_MS: z.coerce.number().int().min(100).max(10_000).default(800),
  ASTERISK_MIN_UTTERANCE_MS: z.coerce.number().int().min(0).max(10_000).default(400),
  ASTERISK_MAX_UTTERANCE_MS: z.coerce.number().int().min(1_000).max(600_000).default(30_000),
  ASTERISK_RESOLVE_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5_000),

  // Module 3 (external Python service). Off by default: it needs the service to
  // be running, and its LLM provider is configured on that side, not here.
  MODULE3_NLP_ENABLED: z
    .string()
    .default('false')
    .transform((value) => value.toLowerCase() === 'true'),
  MODULE3_NLP_URL: z.string().default('http://127.0.0.1:8003'),
  MODULE3_NLP_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(8_000),

  // Module 4 (conversation support). Off by default: localisation needs a
  // reviewed translation table to exist, and silence handling changes live-call
  // behaviour, so neither should switch on implicitly.
  MODULE4_LOCALISATION_ENABLED: z
    .string()
    .default('false')
    .transform((value) => value.toLowerCase() === 'true'),
  MODULE4_TRANSLATIONS_FILE: z.string().default(''),
  MODULE4_SILENCE_TIMEOUT_MS: z.coerce.number().int().min(0).max(600_000).default(0),
  // The approved policy allows at most two silence-triggered re-prompts before the
  // conversation is escalated. The ceiling is enforced here so a deployment cannot
  // configure a longer loop than the policy permits.
  MODULE4_SILENCE_RETRY_LIMIT: z.coerce.number().int().min(0).max(2).default(2),
});

/** `Module11Options.db` is required, so the server supplies the shared singleton. */
export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const parsed = serverConfigSchema.parse(env);
  const isProduction = parsed.NODE_ENV === 'production';

  // In development an empty secret is tolerable, because nothing depends on it.
  // In production a default or missing secret would let anyone mint operator
  // tokens, so it is a hard failure.
  const placeholderSecret = /change-me|changeme|development-only/i.test(parsed.JWT_SECRET);
  if (isProduction && (!parsed.JWT_SECRET || parsed.JWT_SECRET.length < 32 || placeholderSecret)) {
    throw new Error(
      'JWT_SECRET must be set to at least 32 characters when NODE_ENV=production. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"',
    );
  }

  if (isProduction && parsed.CORS_ORIGIN.trim() === '*') {
    throw new Error('CORS_ORIGIN=* is not allowed when NODE_ENV=production; list the exact dashboard origins.');
  }

  return {
    nodeEnv: parsed.NODE_ENV,
    isProduction,
    port: parsed.PORT,
    host: parsed.HOST,
    logLevel: parsed.LOG_LEVEL,
    corsOrigins: parsed.CORS_ORIGIN === '*' ? '*' : parsed.CORS_ORIGIN.split(',').map((o) => o.trim()),
    // Never fall back to a well-known string: anyone who knew it could forge an
    // officer's token. Without a configured secret each process gets a random
    // one (sessions then end on restart; `npm run start:full` persists one).
    jwtSecret: parsed.JWT_SECRET && !placeholderSecret ? parsed.JWT_SECRET : randomBytes(48).toString('hex'),
    jwtExpiresIn: parsed.JWT_EXPIRES_IN,
    asterisk: {
      greeting: parsed.ASTERISK_GREETING,
      greetingTone: parsed.ASTERISK_GREETING_TONE,
      speechRmsThreshold: parsed.ASTERISK_SPEECH_RMS_THRESHOLD,
      hangoverMs: parsed.ASTERISK_HANGOVER_MS,
      minUtteranceMs: parsed.ASTERISK_MIN_UTTERANCE_MS,
      maxUtteranceMs: parsed.ASTERISK_MAX_UTTERANCE_MS,
      resolveTimeoutMs: parsed.ASTERISK_RESOLVE_TIMEOUT_MS,
    },
    nlp: {
      enabled: parsed.MODULE3_NLP_ENABLED,
      baseUrl: parsed.MODULE3_NLP_URL,
      timeoutMs: parsed.MODULE3_NLP_TIMEOUT_MS,
    },
    conversation: {
      localisationEnabled: parsed.MODULE4_LOCALISATION_ENABLED,
      translationsFile:
        parsed.MODULE4_TRANSLATIONS_FILE.trim() === '' ? null : parsed.MODULE4_TRANSLATIONS_FILE,
      silenceTimeoutMs: parsed.MODULE4_SILENCE_TIMEOUT_MS,
      silenceRetryLimit: parsed.MODULE4_SILENCE_RETRY_LIMIT,
    },
  };
}