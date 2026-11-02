/**
 * Module 9 - outbound ports.
 *
 * Module 9 depends on these structural interfaces, never on Module 11's Prisma
 * client. The composition root injects Module 11's repositories, which already
 * satisfy them; tests can inject fakes. Keeping the dependency structural is
 * what lets Module 9 build and unit-test without a database.
 */

import type { Coordinate } from '@resus/core';

/** The subset of a persisted planned route a corridor is derived from. */
export interface CorridorRoute {
  id: string;
  emergencyId: string;
  ambulanceId: string;
  hospitalId: string | null;
  originName: string;
  destinationName: string;
  polyline: Array<[number, number]>;
  estimatedMinutes: number | null;
  isSimulation: boolean;
  provider?: string;
  isLiveTraffic?: boolean;
}

/** Read side of route persistence (Module 11 `RouteRepository`). */
export interface CorridorRouteReadPort {
  routesForEmergency(emergencyId: string): Promise<CorridorRoute[]>;
}

export interface CorridorActivationInput {
  emergencyId: string;
  ambulanceId: string;
  hospitalId: string;
  fromLabel: string;
  toLabel: string;
  estimatedMinutes: number;
  isSimulation: boolean;
  /** Always `SIMULATED` in this repository; there is no real integration. */
  priorityMode: string;
  radiusM: number;
  /** Resampled corridor centre line. */
  geofence: Coordinate[];
  /** Simulated road-user detections (JSON-serializable). */
  roadUsers: unknown;
  /** Junctions where priority was *conceptually* requested. Always empty here. */
  signals: unknown;
}

export interface CorridorActivationResult {
  id: string;
  status: string;
  isActive: boolean;
  /** False when an active corridor for this emergency already existed. */
  activated: boolean;
}

export interface CorridorRecord {
  id: string;
  emergencyId: string;
  ambulanceId: string;
  hospitalId: string;
  fromLabel: string;
  toLabel: string;
  estimatedMinutes: number;
  isActive: boolean;
  activatedAt: string;
  releasedAt: string | null;
  isSimulation: boolean;
  status: string;
  priorityMode: string;
  radiusM: number;
  geofence: Array<[number, number]>;
  roadUsers: unknown[];
  signals: unknown[];
  renegotiationCount: number;
}

export interface CorridorReleaseResult {
  released: boolean;
}

/** Write + read side of corridor persistence (Module 11 `RouteRepository`). */
export interface CorridorWriterPort {
  activateCorridor(input: CorridorActivationInput): Promise<CorridorActivationResult>;
  releaseCorridor(emergencyId: string, reason?: string): Promise<CorridorReleaseResult>;
  getCorridor(emergencyId: string): Promise<CorridorRecord | null>;
}

export interface NotificationCreateInput {
  emergencyId: string;
  corridorId?: string | null;
  channel: string;
  audience: string;
  status: string;
  provider: string;
  delivered: boolean;
  body: string;
  latitude?: number | null;
  longitude?: number | null;
  failureReason?: string | null;
}

export interface NotificationRecord extends NotificationCreateInput {
  id: string;
  createdAt: string;
  sentAt: string | null;
}

export interface PoliceRouteNotificationInput {
  createdByUserId: string;
  emergencyId: string;
  ambulanceId: string;
  routeId: string;
  provider: string;
  isLiveTraffic: boolean;
  routeIsSimulation: boolean;
  estimatedMinutes: number | null;
  geometry: Array<[number, number]>;
}

/** Notification persistence (Module 11 `NotificationRepository`). */
export interface NotificationWriterPort {
  create(input: NotificationCreateInput): Promise<NotificationRecord>;
  listForEmergency(emergencyId: string): Promise<NotificationRecord[]>;
  createPoliceRouteNotification?(input: PoliceRouteNotificationInput): Promise<NotificationRecord>;
  acknowledgePoliceRouteNotification?(input: { emergencyId: string; notificationId: string; acknowledgedByUserId: string }): Promise<NotificationRecord>;
}
