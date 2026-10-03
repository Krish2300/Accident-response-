import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const r = (...parts: string[]) => resolve(root, ...parts).replace(/\\/g, '/');

export default defineConfig({
  resolve: {
    alias: {
      '@resus/core': r('packages/core/src/index.ts'),
      '@resus/protocols': r('modules/module_05_bystander_assistance/src/index.ts'),
      '@resus/fleet': r('modules/module_06_ambulance_management/src/index.ts'),
      '@resus/data': r('modules/module_11_database_event_system/src/index.ts'),
      '@resus/analytics': r('modules/module_12_dashboard_analytics/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    globals: false,
    include: ['packages/**/*.test.ts', 'modules/**/*.test.ts', 'apps/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.data/**'],
    // Each integration test gets its own SQLite file; run them serially to keep
    // database files and port bindings predictable on the F: drive.
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
