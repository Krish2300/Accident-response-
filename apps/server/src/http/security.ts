import type { FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';

/**
 * Transport-level hardening shared by every route.
 *
 *  - Rate limits per client address: a general ceiling, and tight limits on
 *    the two routes an attacker would hammer (sign-in and opening calls).
 *    Loopback is exempt outside production so local load tests and the
 *    dashboard proxy are not throttled.
 *  - Security headers on every response; API responses are never cached.
 */
export async function registerSecurity(fastify: FastifyInstance, options: { isProduction: boolean }): Promise<void> {
  const tight: Record<string, { max: number; timeWindow: string }> = {
    '/api/auth/login': { max: Number(process.env.RATE_LIMIT_LOGIN_PER_MIN ?? 10), timeWindow: '1 minute' },
    '/api/webcall/start': { max: Number(process.env.RATE_LIMIT_CALL_START_PER_MIN ?? 20), timeWindow: '1 minute' },
  };
  fastify.addHook('onRoute', (route) => {
    const limit = tight[route.url];
    if (limit) route.config = { ...(route.config as object), rateLimit: limit } as never;
  });
  await fastify.register(rateLimit, {
    global: true,
    max: Number(process.env.RATE_LIMIT_PER_MIN ?? 600),
    timeWindow: '1 minute',
    allowList: (request) => !options.isProduction && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.ip),
    errorResponseBuilder: (_request, context) => ({
      statusCode: 429,
      error: { code: 'RATE_LIMITED', message: `Too many requests. Try again in ${Math.ceil(context.ttl / 1000)} s.` },
    }),
  });

  fastify.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('permissions-policy', 'microphone=(self), geolocation=(self), camera=(), payment=(), usb=()');
    reply.header('cross-origin-opener-policy', 'same-origin');
    if (options.isProduction) reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    if (request.url.startsWith('/api/')) reply.header('cache-control', 'no-store');
    return payload;
  });
}
