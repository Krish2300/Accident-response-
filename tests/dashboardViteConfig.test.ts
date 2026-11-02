import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import dashboardConfig from '../apps/dashboard/vite.config.js';

describe('dashboard Vite workspace integration', () => {
  it('serves a favicon for the local dashboard shell', () => {
    const index = readFileSync(fileURLToPath(new URL('../apps/dashboard/index.html', import.meta.url)), 'utf8');
    const favicon = readFileSync(fileURLToPath(new URL('../apps/dashboard/public/favicon.svg', import.meta.url)), 'utf8');

    expect(index).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg" />');
    expect(favicon).toContain('<svg');
  });

  it('resolves shared core contracts and keeps the API proxy on the local Fastify server', () => {
    const aliases = dashboardConfig.resolve?.alias as Record<string, string>;

    expect(aliases['@resus/core']).toBe(
      fileURLToPath(new URL('../packages/core/src/index.ts', import.meta.url)),
    );
    expect(dashboardConfig.server?.proxy).toMatchObject({
      '/api': 'http://127.0.0.1:4000',
      '/ws': { target: 'ws://127.0.0.1:4000', ws: true },
    });
  });

  it('starts the root dev:web command with the dashboard Vite config', () => {
    const packageJson = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.['dev:web']).toContain('--config apps/dashboard/vite.config.ts');
  });
});
