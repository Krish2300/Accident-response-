import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';

/**
 * Serves the server-rendered pages (caller phone, police console) with strict
 * security headers. Assets are read once at startup from the source tree; both
 * the tsx (source) and bundled (dist/server) layouts are supported.
 */
const here = dirname(fileURLToPath(import.meta.url));

export function readAsset(relativeToServerSrc: string): string {
  for (const candidate of [
    resolve(here, '..', relativeToServerSrc),
    resolve(here, '../../apps/server/src', relativeToServerSrc),
    resolve(process.cwd(), 'apps/server/src', relativeToServerSrc),
  ]) {
    try {
      return readFileSync(candidate, 'utf8');
    } catch {
      // try the next layout
    }
  }
  throw new Error(`static asset not found: ${relativeToServerSrc}`);
}

const TILE_HOSTS = 'https://*.tile.openstreetmap.org';
const CDN = 'https://unpkg.com';

export function pageCsp(options: { inlineScript?: boolean; media?: boolean } = {}): string {
  return [
    "default-src 'self'",
    `script-src 'self' ${CDN}${options.inlineScript ? " 'unsafe-inline'" : ''}`,
    `style-src 'self' 'unsafe-inline' ${CDN}`,
    `img-src 'self' data: blob: ${TILE_HOSTS} ${CDN}`,
    `media-src 'self' blob:${options.media ? ' data:' : ''}`,
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ');
}

export function registerStaticPages(fastify: FastifyInstance): void {
  const police = readAsset('police/police.html');
  const policeJs = readAsset('police/police.js');
  fastify.get('/police', async (_request, reply) =>
    reply.header('content-security-policy', pageCsp()).header('cache-control', 'no-store').type('text/html; charset=utf-8').send(police));
  fastify.get('/police.js', async (_request, reply) =>
    reply.header('cache-control', 'no-store').type('application/javascript; charset=utf-8').send(policeJs));
}
