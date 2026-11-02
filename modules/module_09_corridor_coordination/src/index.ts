/**
 * Module 9 - Corridor Coordination.
 */
export { Module9, type Module9Deps } from './module.js';
export { loadModule9Config, type Module9Config } from './config.js';
export {
  EARTH_RADIUS_M,
  METERS_PER_DEG_LAT,
  buildCorridorGeofence,
  distanceM,
  distancePointToPathM,
  distancePointToSegmentM,
  isWithinCorridor,
  metersPerDegreeLongitude,
  pathLengthM,
  pointAtFraction,
  resamplePath,
  type CorridorGeofence,
} from './geometry.js';
export {
  MockRoadUserProvider,
  MOCK_ROAD_USER_PROVIDER_NAME,
  MockNotificationProvider,
  MOCK_NOTIFICATION_PROVIDER_NAME,
  type SimulatedRoadUser,
} from './providers/index.js';
export {
  CorridorService,
  SIMULATED_PRIORITY_MODE,
  type CorridorActivationOutcome,
  type CorridorNotificationOutcome,
  type CorridorOutcome,
  type CorridorReleaseOutcome,
  type CorridorServiceDeps,
  type CorridorState,
  type SimulatedRoadUserProvider,
} from './corridorService.js';
export {
  CorridorIntegrationAdapter,
  type CorridorIntegrationDeps,
  type EmergencyCorridorActivationResult,
} from './corridorIntegration.js';
export {
  AutoCorridorService,
  AUTO_CORRIDOR_EVENT_TYPES,
  type AutoCorridorDeps,
} from './autoCorridorService.js';
export { createModule9Routes } from './api/routes.js';
export type {
  CorridorActivationInput,
  CorridorActivationResult,
  CorridorRecord,
  CorridorReleaseResult,
  CorridorRoute,
  CorridorRouteReadPort,
  CorridorWriterPort,
  NotificationCreateInput,
  NotificationRecord,
  NotificationWriterPort,
} from './ports.js';
