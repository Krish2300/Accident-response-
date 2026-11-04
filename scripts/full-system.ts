/**
 * One-command, cross-platform launcher for the fully integrated system.
 *
 *   npm run dev:full        (server + dashboard, hot reload)
 *   npm run start:full      (server only)
 *
 * Works on Windows (PowerShell / cmd), macOS and Linux. No Ubuntu/WSL, no
 * Asterisk, no API keys: calls are placed from the browser at /call, speech
 * recognition runs in the browser (or whisper.cpp if configured), and the
 * Module 10 orchestrator drives the whole response end to end.
 *
 * What it does before booting the normal server entrypoint:
 *  1. loads `.env` (creating it from `.env.example` on first run),
 *  2. switches on the autonomous pipeline (Modules 6-10 automation),
 *  3. applies database migrations and seeds hospitals/ambulances when empty.
 * Values already set in the real environment always win over `.env`; the
 * automation switches can be turned off with RESUS_FULL_AUTOMATION=false.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const schema = 'modules/module_11_database_event_system/prisma/schema.prisma';
const isWindows = process.platform === 'win32';

function log(message: string): void {
  // eslint-disable-next-line no-console
  console.log(`[full-system] ${message}`);
}

function run(command: string, args: string[], extraEnv: Record<string, string> = {}): boolean {
  const executable = command === 'node' ? process.execPath : isWindows ? `${command}.cmd` : command;
  const result = spawnSync(executable, args, {
    cwd: root,
    stdio: 'inherit',
    shell: isWindows && command !== 'node',
    env: { ...process.env, ...extraEnv },
  });
  return result.status === 0;
}

async function main(): Promise<void> {
  const envFile = resolve(root, '.env');
  if (!existsSync(envFile)) {
    copyFileSync(resolve(root, '.env.example'), envFile);
    log('created .env from .env.example');
  }
  // Replace the template JWT secret with a strong random one, once, so sessions
  // survive restarts and no deployment ever runs on a publicly known secret.
  const envText = readFileSync(envFile, 'utf8');
  if (/^JWT_SECRET=(change-me.*|)$/m.test(envText)) {
    writeFileSync(envFile, envText.replace(/^JWT_SECRET=.*$/m, `JWT_SECRET=${randomBytes(48).toString('hex')}`));
    log('generated a random JWT_SECRET in .env');
  }
  const preset = new Set(Object.keys(process.env));
  const dotenv = await import('dotenv');
  dotenv.config({ path: envFile });

  if ((process.env.RESUS_FULL_AUTOMATION ?? 'true').toLowerCase() !== 'false') {
    const automation: Record<string, string> = {
      MODULE6_AUTO_DISPATCH_ENABLED: 'true',
      MODULE7_AUTO_SELECT_ENABLED: 'true',
      MODULE8_AUTO_ROUTE_ENABLED: 'true',
      MODULE9_CORRIDOR_ENABLED: 'true',
      MODULE10_AUTONOMOUS_ENABLED: 'true',
      LLM_ALLOW_HEURISTIC_FALLBACK: 'true',
      MODULE12_INCLUDE_SIM: 'true',
    };
    for (const [key, value] of Object.entries(automation)) {
      if (!preset.has(key)) process.env[key] = value;
    }
    log('autonomous pipeline ON (Modules 6, 7, 8, 9, 10). Set RESUS_FULL_AUTOMATION=false to keep the manual gates.');
  }
  // No PBX on this machine unless explicitly configured.
  process.env.TRANSPORT_PROVIDER ??= 'loopback';
  process.env.CORS_ORIGIN ??= 'http://localhost:5173,http://127.0.0.1:5173';

  log('applying database migrations…');
  if (!run('npx', ['prisma', 'migrate', 'deploy', '--schema', schema])) {
    throw new Error('prisma migrate deploy failed (run `npm install` first?)');
  }
  // Always regenerate: the schema may have changed since `npm install`.
  if (!run('node', ['scripts/prisma-generate.mjs'])) throw new Error('prisma generate failed');

  // Idempotent: adds any missing region hospitals / ambulance posts and the
  // operator account, never duplicates or deletes recorded history.
  log(`seeding region '${process.env.SEED_REGION ?? 'sabarimala'}' (idempotent)…`);
  if (!run('npx', ['tsx', 'modules/module_11_database_event_system/src/seed/seed.ts'], { SEED_DEMO_DATA: process.env.SEED_DEMO_DATA ?? 'false' })) {
    throw new Error('database seed failed');
  }

  const port = process.env.PORT ?? '4000';
  log(`caller (browser phone): http://localhost:${port}/call`);
  log('dispatcher dashboard : http://localhost:5173  (npm run dev:full starts it)');
  log(`login                : ${process.env.SEED_OPERATOR_EMAIL ?? 'operator@resus.local'} / (SEED_OPERATOR_PASSWORD in .env)`);
  await import('../apps/server/src/main.js');
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`[full-system] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
