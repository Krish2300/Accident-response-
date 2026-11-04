import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '@resus/core';
import type { WebCallService } from './webCallService.js';

/**
 * Public Web Call surface. A bystander has no account, so these routes are
 * unauthenticated like `POST /calls`; each call is protected by the bearer
 * token issued by `/api/webcall/start` (header `x-call-token`).
 */
const startBody = z.object({
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  language: z.string().max(8).optional(),
}).optional();
const textBody = z.object({ text: z.string().min(1).max(2000) });
const params = z.object({ id: z.string().uuid() });

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw AppError.validation('Invalid request.', result.error.flatten());
  return result.data;
}

const token = (request: FastifyRequest): string => String(request.headers['x-call-token'] ?? '');

function loadPage(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // Source layout (tsx) and bundled layout (dist/server) are both supported.
  for (const candidate of [resolve(here, 'caller.html'), resolve(here, '../../apps/server/src/webcall/caller.html'), resolve(process.cwd(), 'apps/server/src/webcall/caller.html')]) {
    try {
      return readFileSync(candidate, 'utf8');
    } catch {
      // try next
    }
  }
  return '<!doctype html><title>Web call</title><p>caller.html not found.</p>';
}

export function registerWebCallRoutes(fastify: FastifyInstance, service: WebCallService): void {
  const page = loadPage();
  fastify.get('/call', async (_request, reply) => reply.type('text/html; charset=utf-8').send(page));

  fastify.post('/api/webcall/start', async (request, reply) => {
    const body = parse(startBody, request.body) ?? {};
    return reply.status(201).send(service.start(body));
  });

  fastify.post('/api/webcall/:id/utterance', async (request) => {
    const { id } = parse(params, request.params);
    const { text } = parse(textBody, request.body);
    return service.utterance(id, token(request), text);
  });

  fastify.post('/api/webcall/:id/audio', { bodyLimit: 4 * 1024 * 1024 }, async (request) => {
    const { id } = parse(params, request.params);
    const body = request.body;
    if (!Buffer.isBuffer(body) || body.length === 0) throw AppError.validation('Send the recording as audio/wav.');
    return service.audio(id, token(request), new Uint8Array(body));
  });

  fastify.post('/api/webcall/:id/tts', async (request, reply) => {
    const { id } = parse(params, request.params);
    const { text } = parse(textBody, request.body);
    const audio = await service.synthesize(id, token(request), text);
    if (!audio) return reply.status(204).send();
    return reply.type(audio.mimeType).send(Buffer.from(audio.audio));
  });

  fastify.get('/api/webcall/:id/status', async (request) => {
    const { id } = parse(params, request.params);
    return service.status(id, token(request));
  });

  fastify.post('/api/webcall/:id/hangup', async (request) => {
    const { id } = parse(params, request.params);
    return service.hangup(id, token(request));
  });
}
