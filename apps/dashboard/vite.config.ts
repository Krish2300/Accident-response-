import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const dashboardRoot = fileURLToPath(new URL('.', import.meta.url));
const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url));

/**
 * The proxy target defaults to the local Fastify server. An isolated test that
 * owns a different loopback port sets `RESUS_DASHBOARD_PROXY_TARGET` so it can
 * run next to a manually started session instead of fighting over port 4000.
 */
const proxyTarget = process.env.RESUS_DASHBOARD_PROXY_TARGET ?? 'http://127.0.0.1:4000';

export default defineConfig({
  root: dashboardRoot,
  plugins: [react()],
  resolve: {
    alias: {
      '@resus/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)),
    },
  },
  server: {
    // Bind IPv4 loopback explicitly: on some machines `localhost` resolves to
    // ::1 only, which would leave every documented http://127.0.0.1:5173 URL
    // (demo-server printout, demo-verify default, the demo guide) unreachable.
    host: '127.0.0.1',
    fs: { allow: [workspaceRoot] },
    proxy: {
      '/api': proxyTarget,
      '/ws': { target: proxyTarget.replace(/^http/, 'ws'), ws: true },
    },
  },
  build: {
    outDir: fileURLToPath(new URL('../../dist/web/', import.meta.url)),
    emptyOutDir: true,
  },
});
