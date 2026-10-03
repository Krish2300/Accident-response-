import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import jwt from '@fastify/jwt';
import {
  RouteTable,
  createConsoleLogger,
  isAppError,
  type Logger,
  type RouteDefinition,
} from '@resus/core';
import { createModule11, getPrismaClient } from '@resus/data';
import { Module5 } from '@resus/protocols';
import { loadServerConfig, type ServerConfig } from './config.js';
import { registerDevHarness } from './dev/protocolChat.js';
import { AuthService, registerAuthRoutes } from './http/auth.js';
import { registerRoutes } from './http/routeAdapter.js';
import { RealtimeHub } from './realtime/hub.js';

/**
 * The server composition root.
 *
 * This is the only place where modules meet. It owns the process, the database
 * client, the WebSocket hub and the route table, and it injects ports into
 * modules. No domain logic lives here by design: if something in this file
 * decides a medical or dispatch question, the wrong module owns it.
 */
export interface BuiltServer {
  fastify: FastifyInstance;
  module11: ReturnType<typeof createModule11>;
  module5: Module5;
  realtime: RealtimeHub;
  logger: Logger;
  shutdown: () => Promise<void>;
}

export async function buildServer(config: ServerConfig = loadServerConfig()): Promise<BuiltServer> {
  const logger = createConsoleLogger(config.logLevel, 'server');
  const fastify = Fastify({ logger: false });

  await fastify.register(cors, {
    origin: config.corsOrigins === '*' ? true : config.corsOrigins,
    credentials: true,
  });

  // The hub is constructed first so it can be injected into Module 11's bus.
  // Wiring it afterwards would need a mutable setter on the bus, which would let
  // the realtime target be swapped out at runtime.
  const realtime = new RealtimeHub({ logger });

  // Module 11 owns persistence and the event bus; it is created first because
  // everything else depends on its ports.
  const module11 = createModule11({ db: getPrismaClient(), logger, realtime });

  // Module 5 receives a persistence port, never the Prisma client.
  const module5 = new Module5({ sessions: module11.protocols, logger });

  await fastify.register(jwt, { secret: config.jwtSecret });
  const auth = new AuthService(
    module11.users,
    // The secret is configured once on the fastify-jwt plugin, so the
    // AuthService never needs to pass it per call.
    async (payload, _secret, expiresIn) => fastify.jwt.sign(payload, { expiresIn }),
    async (token, _secret) => fastify.jwt.verify<Record<string, unknown>>(token),
    config.jwtSecret,
    config.jwtExpiresIn,
    !config.isProduction,
  );

  registerAuthRoutes(fastify, auth);

  // Collect routes from every implemented module into one table.
  const table = new RouteTable();
  table.addAll(module11.routeDefinitions());
  module5.register(table);
  const registered = registerRoutes(fastify as never, table.routes as RouteDefinition<any>[], {
    authenticate: async (request) => auth.authenticate(request as never),
  });

  fastify.get('/api/health', async () => ({
    status: 'ok',
    env: config.nodeEnv,
    routes: registered.count,
    modules: registered.modules,
    realtimeClients: realtime.clientCount,
    timestamp: new Date().toISOString(),
  }));

  /** Machine-readable index of every mounted route. */
  fastify.get('/api', async () => ({
    name: 'Pre-Hospital Emergency Survival System',
    modules: registered.modules,
    routes: table.routes.map((route) => ({
      method: route.method,
      url: route.url,
      module: route.module,
      summary: route.summary,
      auth: route.auth ?? { public: false },
    })),
  }));

  await fastify.register(websocket);

  // Mounted last, and never in production: the harness must not shadow or
  // outlive a real route.
  registerDevHarness(fastify, module11, config.isProduction);

  fastify.get('/ws', { websocket: true }, (socket, request) => {
    const url = new URL(request.url, 'http://localhost');
    const requested = url.searchParams.get('channels')?.split(',') ?? undefined;
    const { clientId } = realtime.attach(socket, requested);

    socket.on('close', () => realtime.detach(clientId));
    socket.on('error', () => realtime.detach(clientId));
    socket.on('message', (raw: Buffer) => {
      // The only accepted inbound frame is a subscription change.
      try {
        const parsed = JSON.parse(raw.toString()) as { action?: string; channels?: string[] };
        if (parsed.action === 'subscribe' && Array.isArray(parsed.channels)) {
          realtime.resubscribe(clientId, parsed.channels);
          logger.debug(
            { clientId, channels: parsed.channels.length },
            'realtime subscription updated',
          );
        }
      } catch {
        logger.debug({ clientId }, 'ignoring unparseable websocket frame');
      }
    });
  });

  fastify.setErrorHandler((error, request, reply) => {
    if (isAppError(error)) {
      return reply
        .status(error.statusCode)
        .send({ error: { code: error.code, message: error.message, details: error.details ?? null } });
    }
    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Unexpected server error.' } });
  });

  const shutdown = async (): Promise<void> => {
    logger.info('shutting down');
    realtime.dispose();
    await fastify.close();
    await module11.dispose();
  };

  return { fastify, module11, module5, realtime, logger, shutdown };
}