/**
 * Production build for the whole system.
 *
 * Usage:
 *   node scripts/build.mjs              # server + web
 *   node scripts/build.mjs --server     # server only
 *   node scripts/build.mjs --web        # web only
 *
 * Why this file exists
 * --------------------
 * `package.json` declared a `build` script that pointed at `scripts/build.mjs`,
 * but that file was never written, so `npm run build` failed with a module-not-found
 * error. This is that file.
 *
 * Shape of the build
 * ------------------
 * Two artefacts, because the system has exactly one backend process and one
 * browser bundle:
 *
 *   dist/server/server.js   - esbuild bundle of apps/server/src/main.ts
 *   dist/web/               - vite build of apps/dashboard
 *
 * The server bundle marks node_modules as `external`, so `@prisma/client`,
 * `fastify` and friends are resolved from disk at runtime rather than inlined.
 * Inlining the Prisma client in particular would break it: the generated client
 * resolves engine binaries and query engines relative to its own location on disk.
 *
 * The TypeScript gate is `npm run typecheck` (`tsc --noEmit`), not this script.
 * esbuild strips types without checking them, so this build is only meaningful
 * after typecheck has passed.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';

const args = process.argv.slice(2);
const wantServer = args.length === 0 || args.includes('--server');
const wantWeb = args.length === 0 || args.includes('--web');

/** Runs a command in the repository root, inheriting stdio. Returns exit code. */
function run(command, commandArgs, label) {
  process.stdout.write(`\n[build] ${label}\n`);
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    stdio: 'inherit',
    shell: isWindows,
  });
  if (result.error) {
    process.stderr.write(`[build] ${label} could not start: ${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 1;
}

/** npx resolves the locally installed binary rather than a global one. */
const npx = isWindows ? 'npx.cmd' : 'npx';

let failed = false;

// -- server -------------------------------------------------------------------

if (wantServer) {
  const entry = resolve(root, 'apps/server/src/main.ts');
  if (!existsSync(entry)) {
    process.stderr.write(`[build] server entry missing: ${entry}\n`);
    process.exit(1);
  }

  const status = run(
    npx,
    [
      'esbuild',
      'apps/server/src/main.ts',
      '--bundle',
      '--platform=node',
      '--target=node20',
      '--format=esm',
      '--packages=external',
      // The bundle is ESM, so relative imports must keep their extensions.
      '--outfile=dist/server/server.js',
      '--sourcemap',
      // Fail the build on anything esbuild cannot represent, rather than
      // emitting a bundle that throws only once it is imported at runtime.
      '--log-level=warning',
    ],
    'server -> dist/server/server.js',
  );
  if (status !== 0) failed = true;
}

// -- web ----------------------------------------------------------------------

if (wantWeb) {
  const viteConfig = resolve(root, 'apps/dashboard/vite.config.ts');
  if (!existsSync(viteConfig)) {
    // Not an error: the dashboard is built by Module 12 and until then there is
    // no web bundle to produce. Saying so beats failing the whole build.
    process.stdout.write(
      '\n[build] web skipped: apps/dashboard/vite.config.ts does not exist yet\n',
    );
  } else {
    const status = run(
      npx,
      ['vite', 'build', '--config', viteConfig],
      'web -> dist/web',
    );
    if (status !== 0) failed = true;
  }
}

// -- result -------------------------------------------------------------------

if (failed) {
  process.stderr.write('\n[build] FAILED\n');
  process.exit(1);
}

process.stdout.write('\n[build] ok\n');
process.stdout.write('  run the server with: npm start\n');
process.exit(0);
