import {
  AppError,
  ErrorCode,
  type EventQueryPort,
  type Logger,
} from '@resus/core';
import type {
  CorridorRoute,
  CorridorRouteReadPort,
  NotificationRecord,
  NotificationWriterPort,
} from './ports.js';

export class SimulatedPoliceNotificationService {
  constructor(private readonly deps: {
    routes: CorridorRouteReadPort;
    dispatchEvents: EventQueryPort;
    notifications: NotificationWriterPort;
    logger?: Logger;
  }) {}

  async create(emergencyId: string, routeId: string, createdByUserId: string): Promise<NotificationRecord> {
    if (!this.deps.notifications.createPoliceRouteNotification) {
      throw new AppError(ErrorCode.INTERNAL_ERROR, 'Simulated notification persistence is unavailable.', 503);
    }
    const route = (await this.deps.routes.routesForEmergency(emergencyId)).find((candidate) => candidate.id === routeId);
    if (!route) throw AppError.notFound('Route', routeId);
    this.assertRouteCanBeNotified(emergencyId, route);

    const confirmed = await hasDispatchEvidence(this.deps.dispatchEvents, emergencyId, route.ambulanceId);
    if (!confirmed) {
      throw new AppError(ErrorCode.CONFLICT, 'A persisted explicit dispatch for this route ambulance is required.', 409);
    }

    this.deps.logger?.info({ emergencyId, ambulanceId: route.ambulanceId, routeId }, 'creating simulated mock police control-room notice');
    return this.deps.notifications.createPoliceRouteNotification({
      emergencyId,
      createdByUserId,
      ambulanceId: route.ambulanceId,
      routeId,
      provider: route.provider!,
      isLiveTraffic: route.isLiveTraffic!,
      routeIsSimulation: route.isSimulation,
      estimatedMinutes: route.estimatedMinutes,
      geometry: route.polyline,
    });
  }

  async acknowledge(emergencyId: string, notificationId: string, acknowledgedByUserId: string): Promise<NotificationRecord> {
    if (!this.deps.notifications.acknowledgePoliceRouteNotification) {
      throw new AppError(ErrorCode.INTERNAL_ERROR, 'Simulated notification acknowledgement is unavailable.', 503);
    }
    return this.deps.notifications.acknowledgePoliceRouteNotification({ emergencyId, notificationId, acknowledgedByUserId });
  }

  async list(emergencyId: string): Promise<NotificationRecord[]> {
    const all = await this.deps.notifications.listForEmergency(emergencyId);
    return all.filter((item) => item.audience === 'MOCK_POLICE_CONTROL_ROOM' && item.provider === 'MOCK_POLICE_CONTROL_ROOM');
  }

  private assertRouteCanBeNotified(emergencyId: string, route: CorridorRoute): void {
    if (route.emergencyId !== emergencyId || route.originName !== 'AMBULANCE' || route.destinationName !== 'SCENE') {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'A persisted response route to the incident scene is required.', 422);
    }
    if (typeof route.provider !== 'string' || route.provider.length === 0 || typeof route.isLiveTraffic !== 'boolean') {
      throw new AppError(ErrorCode.CONFLICT, 'Route provider and traffic provenance are unavailable.', 409);
    }
    if (!Array.isArray(route.polyline) || route.polyline.length < 2 || route.polyline.some((point) =>
      point.length !== 2 || !Number.isFinite(point[0]) || !Number.isFinite(point[1]) ||
      point[0] < -90 || point[0] > 90 || point[1] < -180 || point[1] > 180
    )) {
      throw new AppError(ErrorCode.CONFLICT, 'A valid persisted route geometry is required.', 409);
    }
  }
}

async function hasDispatchEvidence(events: EventQueryPort, emergencyId: string, ambulanceId: string): Promise<boolean> {
  let offset = 0;
  let total = 0;
  let latestAssignmentSequence = -1;
  let dispatchedSequence = -1;
  do {
    const page = await events.list({ emergencyId, types: ['AMBULANCE_ASSIGNED', 'AMBULANCE_DISPATCHED'], limit: 500, offset });
    total = page.total;
    for (const event of page.items) {
      const payload = event.payload as Record<string, unknown>;
      if (payload.ambulanceId !== ambulanceId) continue;
      if (event.type === 'AMBULANCE_ASSIGNED') latestAssignmentSequence = Math.max(latestAssignmentSequence, event.sequence);
      if (event.type === 'AMBULANCE_DISPATCHED') dispatchedSequence = Math.max(dispatchedSequence, event.sequence);
    }
    offset += page.items.length;
    if (page.items.length === 0) break;
  } while (offset < total);
  return latestAssignmentSequence >= 0 && dispatchedSequence > latestAssignmentSequence;
}
