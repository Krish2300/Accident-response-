import { z } from 'zod';

/**
 * Server configuration.
 *
 * Validated once at boot with Zod so a misconfigured deployment fails
 * immediately and loudly, rather than on the first request that needs the value.
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
});

/** `Module11Options.db` is required, so the server supplies the shared singleton. */
export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const parsed = serverConfigSchema.parse(env);
  const isProduction = parsed.NODE_ENV === 'production';

  // In development an empty secret is tolerable, because nothing depends on it.
  // In production a default or missing secret would let anyone mint operator
  // tokens, so it is a hard failure.
  if (isProduction && (!parsed.JWT_SECRET || parsed.JWT_SECRET.length < 32)) {
    throw new Error(
      'JWT_SECRET must be set to at least 32 characters when NODE_ENV=production. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"',
    );
  }

  return {
    nodeEnv: parsed.NODE_ENV,
    isProduction,
    port: parsed.PORT,
    host: parsed.HOST,
    logLevel: parsed.LOG_LEVEL,
    corsOrigins: parsed.CORS_ORIGIN === '*' ? '*' : parsed.CORS_ORIGIN.split(',').map((o) => o.trim()),
    jwtSecret: parsed.JWT_SECRET || 'development-only-insecure-secret',
    jwtExpiresIn: parsed.JWT_EXPIRES_IN,
  };
}