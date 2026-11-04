import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '@resus/core';
import type { WebCallService } from './webCallService.js';
import { pageCsp, readAsset } from '../http/staticPages.js';

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

export function registerWebCallRoutes(fastify: FastifyInstance, service: WebCallService): void {
  const page = readAsset('webcall/caller.html');
  fastify.get('/call', async (_request, reply) =>
    reply.header('content-security-policy', pageCsp({ inlineScript: true, media: true })).type('text/html; charset=utf-8').send(page));

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
