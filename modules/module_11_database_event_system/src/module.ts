import type { PrismaClient } from '@prisma/client';
import {
  type Database,
  type DomainEventBusPort,
  type EventPublisherPort,
  type EventQueryPort,
  type Logger,
  type RealtimePublisherPort,
  type RouteDefinition,
  createConsoleLogger,
} from '@resus/core';
import { DomainEventBus } from './events/bus.js';
import { createModule11Routes } from './api/routes.js';
import { EventService } from './events/eventService.js';
import { EmergencyRepository } from './repositories/emergencyRepository.js';
import { AmbulanceRepository } from './repositories/ambulanceRepository.js';
import { HospitalRepository } from './repositories/hospitalRepository.js';
import {
  DecisionRepository,
  OutcomeRepository,
  ProtocolRepository,
} from './repositories/protocolRepository.js';
import { CallRepository, RouteRepository } from './repositories/callRepository.js';
import { UserRepository } from './repositories/userRepository.js';
import { AnalyticsReadRepository } from './repositories/analyticsRepository.js';

/**
 * Module 11 composition root.
 *
 * The whole persistence + event capability of the system is assembled here once
 * and handed to modules 5, 6 and 12. They receive repositories and the event
 * port; they never see the Prisma client.
 */
export interface Module11 {
  db: PrismaClient;
  database: Database;
  bus: DomainEventBus;
  events: EventService;
  eventPublisher: EventPublisherPort;
  eventQuery: EventQueryPort;
  emergencies: EmergencyRepository;
  ambulances: AmbulanceRepository;
  hospitals: HospitalRepository;
  protocols: ProtocolRepository;
  decisions: DecisionRepository;
  outcomes: OutcomeRepository;
  calls: CallRepository;
  routes: RouteRepository;
  users: UserRepository;
  analyticsRead: AnalyticsReadRepository;
  /** HTTP surface, as framework-agnostic route definitions for the server. */
  routeDefinitions(): RouteDefinition<any>[];
  dispose(): Promise<void>;
}

export interface Module11Options {
  db: PrismaClient;
  realtime?: RealtimePublisherPort;
  logger?: Logger;
  /** Dispose the Prisma client on shutdown. Off for tests that reuse the client. */
  ownsClient?: boolean;
}

export function createModule11(options: Module11Options): Module11 {
  const logger = options.logger ?? createConsoleLogger('info', 'module_11');
  const db = options.db;
  const bus = new DomainEventBus({ realtime: options.realtime, logger });
  const events = new EventService({ db, bus, logger });

  const module: Module11 = {
    db,
    database: db as unknown as Database,
    bus,
    events,
    eventPublisher: events,
    eventQuery: events,
    emergencies: new EmergencyRepository(db, events),
    ambulances: new AmbulanceRepository(db, events),
    hospitals: new HospitalRepository(db),
    protocols: new ProtocolRepository(db, events, logger),
    decisions: new DecisionRepository(db),
    outcomes: new OutcomeRepository(db),
    calls: new CallRepository(db, events),
    routes: new RouteRepository(db, events),
    users: new UserRepository(db),
    analyticsRead: new AnalyticsReadRepository(db),
    routeDefinitions: () => createModule11Routes(module),
    dispose: async () => {
      if (options.ownsClient !== false) await db.$disconnect();
    },
  };

  return module;
}

export type { DomainEventBusPort };
