import Fastify, { type FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import jwt from '@fastify/jwt';
import {
  RouteTable,
  createConsoleLogger,
  isAppError,
  type Logger,
  type RouteDefinition,
  type RoutingProvider,
} from '@resus/core';
import { createModule11, getPrismaClient } from '@resus/data';
import { Module1 } from '@resus/call';
import { Module2 } from '@resus/speech';
import { Module5, type LLMService } from '@resus/protocols';
import { Module6 } from '@resus/fleet';
import { Module7 } from '@resus/hospital';
import { Module8 } from '@resus/routing';
import { Module9 } from '@resus/corridor';
import { Module12 } from '@resus/analytics';
import { Module10LifecycleObserver } from '../../../modules/module10/module10/src/lifecycle/observer.js';
import { createModule10LifecycleRoutes } from '../../../modules/module10/module10/src/lifecycle/routes.js';
import { loadServerConfig, type ServerConfig } from './config.js';
import { startAsteriskRuntime, type AsteriskRuntime } from './asterisk/runtime.js';
import { startAmbulanceOfferExpiryWatch } from './ambulance/offerExpiryWatch.js';
import { registerDevHarness } from './dev/protocolChat.js';
import { AuthService, registerAuthRoutes } from './http/auth.js';
import { registerRoutes } from './http/routeAdapter.js';
import { RealtimeHub } from './realtime/hub.js';
import { AsteriskConversationController } from './asterisk/conversationController.js';
import {
  ConversationSupportAdapter,
  InstructionLocalizer,
} from './conversation/index.js';
import { ProtocolTurnOrchestratorImpl } from './conversation/protocolTurnOrchestrator.js';
import { CallerLocationResolutionService, type CallerLocationResolver } from './conversation/callerLocationResolution.js';
import { createCallerLocationRoutes } from './conversation/callerLocationRoutes.js';
import { Module3Classifier } from './nlp/module3Classifier.js';
import {
  EmergencyClassificationService,
  createNlpClassifyRoutes,
} from './nlp/classifyRoutes.js';

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
  module1: Module1;
  module2: Module2;
  module5: Module5;
  module6: Module6;
  module7: Module7;
  module8: Module8;
  module9: Module9;
  module12: Module12;
  realtime: RealtimeHub;
  logger: Logger;
  /**
   * Non-null only when `TRANSPORT_PROVIDER=asterisk`.
   *
   * Kept out of the module objects because it is sockets and timers rather than
   * domain behaviour; the composition root owns it the same way it owns the
   * WebSocket hub.
   */
  asterisk: AsteriskRuntime | null;
  shutdown: () => Promise<void>;
}

/** Optional composition dependencies, primarily for isolated integration tests. */
export interface BuildServerDependencies {
  /** Shared client injected into every Module 11 repository and event service. */
  db?: PrismaClient;
  /** When false, shutdown leaves an injected client to its test owner. */
  ownsDatabaseClient?: boolean;
  /** Optional logger for isolated tests; production keeps the server logger. */
  logger?: Logger;
  /** Explicit provider overrides for deterministic composition tests. */
  routingProviders?: { primary?: RoutingProvider; fallback?: RoutingProvider };
  /** Explicit Module 5 provider overrides for isolated composition tests. */
  module5Providers?: LLMService[];
  /** Optional resolver override; the default is explicitly unconfigured. */
  callerLocationResolver?: CallerLocationResolver;
}

export async function buildServer(
  config: ServerConfig = loadServerConfig(),
  dependencies: BuildServerDependencies = {},
): Promise<BuiltServer> {
  const logger = dependencies.logger ?? createConsoleLogger(config.logLevel, 'server');
  const fastify = Fastify({ logger: false });

  await fastify.register(cors, {
    origin: config.corsOrigins === '*' ? true : config.corsOrigins,
    credentials: true,
  });

  // Fastify binds the error handler that is installed when a route is added, so
  // this must run before any route registration. Otherwise raw routes (the auth
  // endpoints) fall back to Fastify's default error serialisation and answer
  // with `{ statusCode, code, error, message }` instead of the project's
  // `{ error: { code, message, details } }` envelope that the dashboard client
  // parses.
  fastify.setErrorHandler((error, request, reply) => {
    if (isAppError(error)) {
      return reply
        .status(error.statusCode)
        .send({ error: { code: error.code, message: error.message, details: error.details ?? null } });
    }
    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Unexpected server error.' } });
  });

  // The hub is constructed first so it can be injected into Module 11's bus.
  // Wiring it afterwards would need a mutable setter on the bus, which would let
  // the realtime target be swapped out at runtime.
  const realtime = new RealtimeHub({ logger });

  // Module 11 owns persistence and the event bus; it is created first because
  // everything else depends on its ports.
  const module11 = createModule11({
    db: dependencies.db ?? getPrismaClient(),
    nodeEnv: config.nodeEnv,
    logger,
    realtime,
    ownsClient: dependencies.ownsDatabaseClient,
  });
  // Module 10 observes only committed Module 11 events. It has no write ports
  // and is intentionally not connected to the existing active FSM.
  const module10LifecycleObserver = new Module10LifecycleObserver({
    bus: module11.bus,
    events: module11.eventQuery,
    logger,
  });
  fastify.addHook('onClose', async () => module10LifecycleObserver.dispose());
  try {
    await module10LifecycleObserver.start();
  } catch (error) {
    await fastify.close();
    realtime.dispose();
    await module11.dispose();
    throw error;
  }

  // Module 2 reuses Module 11's call repository so a transcript can only be
  // written against a session that genuinely exists. It is created before
  // Module 5 so the HTTP-utterance orchestrator can be wired into Module 5's
  // public route at construction time.
  const module2 = new Module2({
    calls: module11.calls,
    events: module11.eventPublisher,
    logger,
  });
  const callerLocationResolution = new CallerLocationResolutionService({
    emergencies: module11.emergencies,
    resolver: dependencies.callerLocationResolver,
    timeoutMs: Number(process.env.CALLER_LOCATION_LOOKUP_TIMEOUT_MS ?? 3000),
    logger,
  });

  // Module 5 receives a persistence port, never the Prisma client. It is also
  // given an HTTP-utterance orchestrator so a caller turn arriving over
  // `POST /api/protocol-sessions/:id/utterance` lands in the call transcript
  // and its spoken reply is synthesised — both of which Module 5 cannot do
  // itself because it holds no persistence or speech port. The live
  // AudioBridge path already owns its own persistence and TTS and is left
  // untouched, so no turn is double-written or spoken twice.
  const module5 = new Module5({
    sessions: module11.protocols,
    logger,
    providers: dependencies.module5Providers,
    turnOrchestrator: new ProtocolTurnOrchestratorImpl({
      // The orchestrator only needs the emergency id off the protocol session;
      // Module 11's port already exposes it via getSession.
      sessions: {
        async get(sessionId: string) {
          const session = await module11.protocols.getSession(sessionId);
          if (!session) throw new Error(`Protocol session '${sessionId}' was not found.`);
          return { session: { emergencyId: session.emergencyId } };
        },
      },
      calls: module11.calls,
      speech: module2.speech,
      captureCallerLocation: async (emergencyId, locationText) => { await callerLocationResolution.capture(emergencyId, locationText); },
      logger,
    }),
  });

  // Module 1 likewise receives ports. It picks its telephony transport from
  // configuration, so the wiring below cannot silently install a different one.
  const module1 = new Module1({
    emergencies: module11.emergencies,
    calls: module11.calls,
    events: module11.eventPublisher,
    logger,
  });

  // Module 6 owns the ambulance fleet and is the only writer of GPS positions.
  // It persists through Module 11's repositories, so a phone reporting its
  // position takes exactly the same path as any other client. It is also given
  // the event bus and an emergency read port, which enables automatic assignment
  // on emergency lifecycle events (see Module 6 `autoDispatch` config).
  const module6 = new Module6({
    ambulances: module11.ambulances,
    events: module11.eventPublisher,
    bus: module11.bus,
    emergencies: module11.emergencies,
    logger,
  });

  // Module 7 owns hospital suitability scoring. It reads hospitals and their
  // resource rows through Module 11 and is the only writer of an emergency's
  // `selectedHospitalId`. Given the event bus it selects automatically on
  // `EMERGENCY_CLASSIFIED` (see Module 7 `autoSelect` config).
  const module7 = new Module7({
    hospitals: module11.hospitals,
    hospitalResources: module11.hospitals,
    emergencies: module11.emergencies,
    events: module11.eventPublisher,
    bus: module11.bus,
    logger,
  });

  // Module 8 owns route planning. It resolves each leg's endpoints from Module
  // 11 reads, records the route through Module 11's route repository, and is the
  // only writer of route rows. Given the event bus it plans the response leg only
  // after explicit dispatch and the transport leg on hospital selection (see Module
  // 8 `generation` config). Dispatcher response-route requests also verify persisted
  // dispatch evidence. The default provider is deterministic and every
  // route carries its provider provenance (`isLiveTraffic` false in development).
  const module8 = new Module8({
    routes: module11.routes,
    emergencies: module11.emergencies,
    ambulances: module11.ambulances,
    hospitals: module11.hospitals,
    events: module11.eventPublisher,
    dispatchEvents: module11.eventQuery,
    bus: module11.bus,
    ...(dependencies.routingProviders?.primary
      ? { primaryProvider: dependencies.routingProviders.primary }
      : {}),
    ...(dependencies.routingProviders?.fallback
      ? { fallbackProvider: dependencies.routingProviders.fallback }
      : {}),
    logger,
  });

  // Module 9 owns corridor coordination. It derives a corridor geofence from a
  // persisted route, records the corridor and its (simulated) road users through
  // Module 11, and is the only writer of corridor + notification rows. Given the
  // event bus it coordinates automatically once an emergency has a transport
  // route (see Module 9 `enabled` config). There is no traffic-signal, road-user
  // feed or messaging integration: every corridor is stored `priorityMode:
  // SIMULATED` and every notification with `delivered: false`.
  const module9 = new Module9({
    corridors: module11.routes,
    notifications: module11.notifications,
    routes: module11.routes,
    bus: module11.bus,
    dispatchEvents: module11.eventQuery,
    logger,
  });

  // Module 12 is read-only: it sees Module 6's writes purely through Module 11's
  // projection repository and the event log.
  const module12 = new Module12({
    analyticsRead: module11.analyticsRead,
    events: module11.eventQuery,
  });
  // Module 3 is an external Python service, so it has no in-process module
  // object. The classifier adapter and the operator-triggered classify route
  // live in the composition root, alongside the other external-service glue.
  // Classification is explicit and disabled by default; see `config.nlp`.
  const nlpClassifier = new Module3Classifier({
    baseUrl: config.nlp.baseUrl,
    timeoutMs: config.nlp.timeoutMs,
    logger,
  });
  const classification = new EmergencyClassificationService({
    classifier: nlpClassifier,
    emergencies: module11.emergencies,
    calls: module11.calls,
    events: module11.eventPublisher,
    logger,
    enabled: config.nlp.enabled,
  });

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
  module1.register(table);
  module2.register(table);
  module6.register(table);
  module7.register(table);
  module8.register(table);
  module9.register(table);
  module12.register(table);
  table.addAll(createModule10LifecycleRoutes(module10LifecycleObserver));
  table.addAll(createNlpClassifyRoutes(classification));
  table.addAll(createCallerLocationRoutes(module11, callerLocationResolution));
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

  /**
   * Raw binary bodies, kept as a Buffer.
   *
   * Module 2 posts caller audio rather than JSON. Fastify's default behaviour for
   * an unknown content type is 415, so without this parser the audio routes are
   * unreachable: the body has to be buffered untouched for the speech provider,
   * never parsed as JSON or coerced to a string.
   */
  fastify.addContentTypeParser(
    ['application/octet-stream', 'audio/wav', 'audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/*'],
    { parseAs: 'buffer' },
    (_request, body, done) => done(null, body),
  );

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

  // Telephony is started last: it opens a manager connection and a media port,
  // so it must not be left half-open if anything above this line fails. When the
  // provider is `asterisk` and the PBX cannot be reached, this throws and the
  // process does not boot â€” a silent server that accepts no calls is worse than
  // a visible startup failure.
  const asterisk = await startAsteriskRuntime({
    module1,
    speech: module2.speech,
    calls: module11.calls,
    // Module 5 owns what is said; the controller renders it into the call's
    // language (Module 4's language layer) and the adapter adds the caller-silence
    // retry budget and its conversation-layer events. Both are inert by default:
    // no localiser unless a reviewed table is configured, and no silence timer
    // unless a positive timeout is set.
    conversation: new ConversationSupportAdapter({
      inner: new AsteriskConversationController({
        sessions: module5.sessions,
        emergencies: module11.emergencies,
        transcripts: module11.calls,
        captureCallerLocation: async (emergencyId, locationText) => { await callerLocationResolution.capture(emergencyId, locationText); },
        logger,
        ...(config.conversation.localisationEnabled && config.conversation.translationsFile
          ? { localizer: InstructionLocalizer.fromFile(config.conversation.translationsFile, logger) }
          : {}),
      }),
      events: module11.eventPublisher,
      config: {
        silenceTimeoutMs: config.conversation.silenceTimeoutMs,
        silenceRetryLimit: config.conversation.silenceRetryLimit,
      },
      logger,
    }),
    config,
    logger,
  });

  // Offer expiry belongs to the server lifecycle, not the Asterisk transport:
  // loopback/demo runtimes need the same persisted expiry behavior. Module 11
  // performs the conditional state transition and audit event transactionally.
  const offerExpiryWatch = startAmbulanceOfferExpiryWatch({
    expireDueOffers: () => module6.fleet.expireDueOffers(),
    logger,
  });
  fastify.addHook('onClose', async () => { await offerExpiryWatch.stop(); });

  const shutdown = async (): Promise<void> => {
    logger.info('shutting down');
    await offerExpiryWatch.stop();
    module7.dispose();
    module8.dispose();
    module9.dispose();
    if (asterisk) await asterisk.stop();
    await module10LifecycleObserver.dispose();
    realtime.dispose();
    await fastify.close();
    await module11.dispose();
  };

  return { fastify, module11, module1, module2, module5, module6, module7, module8, module9, module12, realtime, logger, asterisk, shutdown };
}
