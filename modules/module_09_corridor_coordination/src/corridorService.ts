/**
 * Module 9 - corridor coordination service.
 *
 * The service owns the corridor lifecycle for one emergency:
 *   REQUESTED -> ACTIVE -> RELEASED
 * and the notification *intents* raised while a corridor is active.
 *
 * It is deliberately passive about truth:
 *  - Geometry is taken verbatim from a persisted planned route; it never invents
 *    a coordinate.
 *  - Road users come from a provider and are persisted with an explicit
 *    `simulated: true` marker and `isLive: false`.
 *  - Notifications are recorded exactly as the provider reports them;
 *    `delivered` is carried through untouched (always false here).
 *  - The corridor is stored with `priorityMode: SIMULATED`; no signal is touched
 *    and `signals` is always empty.
 *
 * It never changes emergency status, protocol state, dispatch or hospital
 * selection. It only writes corridor + notification records through Module 11.
 */

import {
  noopLogger,
  type Coordinate,
  type Logger,
  type NotificationProvider,
  type NotificationRequest,
  type RoadUserProvider,
} from '@resus/core';
import { buildCorridorGeofence } from './geometry.js';
import type {
  CorridorRecord,
  CorridorRoute,
  CorridorWriterPort,
  NotificationWriterPort,
} from './ports.js';
import type { SimulatedRoadUser } from './providers/roadUserProvider.js';
import type { Module9Config } from './config.js';

/** The only priority mode this repository can produce. No real integration exists. */
export const SIMULATED_PRIORITY_MODE = 'SIMULATED';

export type CorridorOutcome = 'ACTIVATED' | 'ALREADY_ACTIVE' | 'SKIPPED' | 'FAILED';

export interface CorridorActivationOutcome {
  outcome: CorridorOutcome;
  emergencyId: string;
  corridorId: string | null;
  status: string | null;
  reason?: string;
  /** Whether the *source emergency* is a simulation (mirrors the route). */
  isSimulation: boolean;
  /** Always `SIMULATED`: the coordination itself is never live. */
  priorityMode: string;
  /** Always false: nothing leaves the system and no signal is controlled. */
  isLive: false;
  signalsControlled: false;
  radiusM: number;
  simulatedRoadUsers: SimulatedRoadUser[];
  notifications: CorridorNotificationOutcome[];
}

export interface CorridorNotificationOutcome {
  id: string;
  channel: string;
  audience: string;
  status: string;
  provider: string;
  delivered: boolean;
}

export interface CorridorReleaseOutcome {
  released: boolean;
  outcome: 'RELEASED' | 'ALREADY_RELEASED';
}

export interface CorridorState {
  corridor: CorridorRecord | null;
  /** Always false: a persisted corridor is never a live traffic integration. */
  isLive: false;
  signalsControlled: false;
}

export interface CorridorServiceDeps {
  corridors: CorridorWriterPort;
  notifications: NotificationWriterPort;
  roadUsers: SimulatedRoadUserProvider;
  notificationProvider: NotificationProvider;
  config: Module9Config;
  logger?: Logger;
}

/**
 * A `RoadUserProvider` whose detections are labelled simulated. Narrowing the
 * return type keeps the `simulated: true` marker in the type system rather than
 * relying on a cast, so the service cannot store an unlabelled detection.
 */
export interface SimulatedRoadUserProvider extends RoadUserProvider {
  detectNear(
    path: Coordinate[],
    radiusM: number,
    ambulancePosition: Coordinate | null,
  ): Promise<SimulatedRoadUser[]>;
}

export class CorridorService {
  private readonly corridors: CorridorWriterPort;
  private readonly notifications: NotificationWriterPort;
  private readonly roadUsers: SimulatedRoadUserProvider;
  private readonly notificationProvider: NotificationProvider;
  private readonly config: Module9Config;
  private readonly logger: Logger;

  constructor(deps: CorridorServiceDeps) {
    this.corridors = deps.corridors;
    this.notifications = deps.notifications;
    this.roadUsers = deps.roadUsers;
    this.notificationProvider = deps.notificationProvider;
    this.config = deps.config;
    this.logger = deps.logger ?? noopLogger;
  }

  /**
   * Activates the corridor for a persisted planned route.
   *
   * Idempotent: activating an already-active corridor returns `ALREADY_ACTIVE`
   * and raises no second event or notification. A persistence failure surfaces as
   * `FAILED` and never yields a success event (the write and its event share one
   * transaction inside Module 11).
   */
  async activateForRoute(route: CorridorRoute): Promise<CorridorActivationOutcome> {
    const blank = (
      outcome: CorridorOutcome,
      reason: string,
      status: string | null = null,
    ): CorridorActivationOutcome => ({
      outcome,
      emergencyId: route.emergencyId,
      corridorId: null,
      status,
      reason,
      isSimulation: route.isSimulation,
      priorityMode: SIMULATED_PRIORITY_MODE,
      isLive: false,
      signalsControlled: false,
      radiusM: this.config.radiusM,
      simulatedRoadUsers: [],
      notifications: [],
    });

    if (route.isSimulation && !this.config.includeSimulation) {
      return blank('SKIPPED', 'simulation emergencies are not coordinated');
    }
    if (!route.hospitalId) {
      return blank('SKIPPED', 'route has no destination hospital');
    }
    if (route.polyline.length < 2) {
      return blank('SKIPPED', 'route has no usable geometry');
    }

    let geofence;
    try {
      const coordinates: Coordinate[] = route.polyline.map(([latitude, longitude]) => ({
        latitude,
        longitude,
      }));
      geofence = buildCorridorGeofence(coordinates, this.config.radiusM);
    } catch (error) {
      return blank('SKIPPED', error instanceof Error ? error.message : 'invalid route geometry');
    }

    const simulatedRoadUsers = await this.detectRoadUsers(geofence.centreLine);

    let activation;
    try {
      activation = await this.corridors.activateCorridor({
        emergencyId: route.emergencyId,
        ambulanceId: route.ambulanceId,
        hospitalId: route.hospitalId,
        fromLabel: route.originName,
        toLabel: route.destinationName,
        estimatedMinutes: route.estimatedMinutes ?? 0,
        isSimulation: route.isSimulation,
        priorityMode: SIMULATED_PRIORITY_MODE,
        radiusM: this.config.radiusM,
        geofence: geofence.centreLine,
        // Stored verbatim as the schema's "array of detections". Each detection
        // carries `simulated: true`, so the record is self-describing.
        roadUsers: simulatedRoadUsers,
        signals: [],
      });
    } catch (error) {
      this.logger.error(
        {
          emergencyId: route.emergencyId,
          error: error instanceof Error ? error.message : String(error),
        },
        'corridor activation failed',
      );
      return blank('FAILED', 'corridor persistence failed');
    }

    const notifications =
      activation.activated && simulatedRoadUsers.length > 0
        ? await this.raiseRoadUserNotifications(route.emergencyId, activation.id, simulatedRoadUsers)
        : [];

    return {
      outcome: activation.activated ? 'ACTIVATED' : 'ALREADY_ACTIVE',
      emergencyId: route.emergencyId,
      corridorId: activation.id,
      status: activation.status,
      isSimulation: route.isSimulation,
      priorityMode: SIMULATED_PRIORITY_MODE,
      isLive: false,
      signalsControlled: false,
      radiusM: this.config.radiusM,
      simulatedRoadUsers,
      notifications,
    };
  }

  /** Releases the corridor. Idempotent: a second call raises no second event. */
  async release(emergencyId: string, reason = 'RELEASED'): Promise<CorridorReleaseOutcome> {
    const result = await this.corridors.releaseCorridor(emergencyId, reason);
    return { released: result.released, outcome: result.released ? 'RELEASED' : 'ALREADY_RELEASED' };
  }

  /** Read a corridor's persisted state (never presents it as a live integration). */
  async getState(emergencyId: string): Promise<CorridorState> {
    return {
      corridor: await this.corridors.getCorridor(emergencyId),
      isLive: false,
      signalsControlled: false,
    };
  }

  private async detectRoadUsers(path: Coordinate[]): Promise<SimulatedRoadUser[]> {
    try {
      return await this.roadUsers.detectNear(path, this.config.radiusM, null);
    } catch (error) {
      this.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'road-user detection failed; continuing with none',
      );
      return [];
    }
  }

  private async raiseRoadUserNotifications(
    emergencyId: string,
    corridorId: string,
    users: SimulatedRoadUser[],
  ): Promise<CorridorNotificationOutcome[]> {
    const request: NotificationRequest = {
      emergencyId,
      corridorId,
      channel: 'PUSH',
      audience: 'NEARBY_ROAD_USERS',
      body:
        `SIMULATED corridor notice: an emergency ambulance corridor is active on ` +
        `${this.describe(users)} simulated road-user position(s). This is a mock ` +
        `coordination record; no message was sent to any road user.`,
    };

    let result;
    try {
      result = await this.notificationProvider.notify(request);
    } catch (error) {
      this.logger.warn(
        { emergencyId, error: error instanceof Error ? error.message : String(error) },
        'notification provider failed; recording the intent as SUPPRESSED',
      );
      result = {
        providerName: this.notificationProvider.providerName,
        isLive: false,
        delivered: false,
        status: 'FAILED' as const,
        detail: 'notification provider threw',
      };
    }

    try {
      const record = await this.notifications.create({
        emergencyId,
        corridorId,
        channel: request.channel,
        audience: request.audience,
        status: result.status,
        provider: result.providerName,
        delivered: result.delivered,
        body: request.body,
      });
      return [
        {
          id: record.id,
          channel: record.channel,
          audience: record.audience,
          status: record.status,
          provider: record.provider,
          delivered: record.delivered,
        },
      ];
    } catch (error) {
      this.logger.warn(
        { emergencyId, error: error instanceof Error ? error.message : String(error) },
        'notification persistence failed; corridor remains active',
      );
      return [];
    }
  }

  private describe(users: SimulatedRoadUser[]): number {
    return users.length;
  }
}
