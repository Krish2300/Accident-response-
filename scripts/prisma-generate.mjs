/**
 * `prisma generate` wrapper: generates the client, then repairs the generated
 * files (see fix-prisma-client.mjs for why).
 *
 * Usage: node scripts/prisma-generate.mjs
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const schemaArg = process.argv[2] ?? 'modules/module_11_database_event_system/prisma/schema.prisma';
const schema = resolve(root, schemaArg);

if (!existsSync(schema)) {
  console.error(`[prisma-generate] schema not found: ${schema}`);
  process.exit(1);
}

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const generate = spawnSync(npx, ['prisma', 'generate', '--schema', schema], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (generate.status !== 0) {
  process.exit(generate.status ?? 1);
}

const repair = spawnSync(
  process.execPath,
  [resolve(root, 'scripts/fix-prisma-client.mjs')],
  { cwd: root, stdio: 'inherit' },
);
process.exit(repair.status ?? 0);
