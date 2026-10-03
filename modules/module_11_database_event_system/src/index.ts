/**
 * MODULE 11 - DATABASE + EVENT SYSTEM
 *
 * Public facade. Modules 5, 6 and 12 import from here and nothing deeper:
 * they get repositories, the event port and the event query port. Prisma types
 * and the raw client stay inside this package.
 */

export { createModule11, type Module11, type Module11Options } from './module.js';
export { DomainEventBus } from './events/bus.js';
export { EventService, type EventServiceDeps } from './events/eventService.js';
export { createModule11Routes } from './api/routes.js';
export { loadModule11Config, type Module11Config } from './config.js';

export { EmergencyRepository, type EventCarrier, type ActorContext } from './repositories/emergencyRepository.js';
export {
  AmbulanceRepository,
  type AmbulanceCreateInput,
  type AmbulancePatch,
  type AmbulanceUtilization,
} from './repositories/ambulanceRepository.js';
export { HospitalRepository } from './repositories/hospitalRepository.js';
export {
  ProtocolRepository,
  DecisionRepository,
  OutcomeRepository,
  type NewProtocolSessionInput,
} from './repositories/protocolRepository.js';
export {
  CallRepository,
  RouteRepository,
  type CallSessionRecord,
  type TranscriptRecord,
  type RouteRecord,
} from './repositories/callRepository.js';
export { UserRepository, type UserRecord } from './repositories/userRepository.js';
export {
  AnalyticsReadRepository,
  type EmergencyDurationRow,
  type LiveAmbulanceRow,
  type LiveEmergencyRow,
  type LiveCorridorRow,
  type LearningSampleRow,
} from './repositories/analyticsRepository.js';

export {
  createPrismaClient,
  getPrismaClient,
  disconnectPrisma,
  withTransaction,
  asDatabase,
  type PrismaDatabase,
} from './db/client.js';

export {
  registerCommitSink,
  currentScope,
  type TransactionScope,
} from './db/transactionScope.js';

export {
  mapAmbulance,
  mapAmbulanceLocation,
  mapAssignment,
  mapDecision,
  mapEmergency,
  mapHospital,
  mapOutcome,
  mapProtocolSession,
  mapProtocolStep,
  mapSystemEvent,
  parseJsonColumn,
  parseStringArray,
  parseRecord,
} from './models/mappers.js';
