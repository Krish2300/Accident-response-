import { z } from 'zod';
import { AppError, ErrorCode, type HttpReply, type HttpRequest, type RouteDefinition } from '@resus/core';
import type { CorridorService } from '../corridorService.js';
import type { CorridorIntegrationAdapter } from '../corridorIntegration.js';
import type { SimulatedPoliceNotificationService } from '../policeNotificationService.js';

const emergencyParams = z.object({ id: z.string().min(1).max(128) });

/** Read-only corridor inspection plus an explicit simulated activation operation. */
export function createModule9Routes(
  corridors: CorridorService,
  integration: CorridorIntegrationAdapter,
  policeNotifications?: SimulatedPoliceNotificationService,
): RouteDefinition<Record<string, unknown>>[] {
  const readRoles = ['OPERATOR', 'DISPATCHER', 'CLINICAL_SUPERVISOR', 'ADMIN'];
  const actionRoles = ['DISPATCHER', 'ADMIN'];
  const routes: RouteDefinition<Record<string, unknown>>[] = [
    {
      method: 'POST',
      url: '/api/emergencies/:id/corridor',
      module: 'module_09',
      summary: 'Activate a simulated corridor from a persisted transport route',
      auth: { roles: actionRoles },
      params: emergencyParams,
      body: z.object({}).strict(),
      handler: async (request: HttpRequest<Record<string, unknown>>, reply: HttpReply) => {
        const emergencyId = emergencyParams.parse(request.params).id;
        const result = await integration.activateForEmergency(emergencyId);
        if (result.outcome === 'NO_TRANSPORT_ROUTE') {
          throw new AppError(ErrorCode.NO_ROUTE_AVAILABLE, 'A persisted hospital transport route is required before corridor activation.', 409);
        }
        if (result.outcome === 'SKIPPED') {
          throw new AppError(ErrorCode.CONFLICT, result.activation.reason ?? 'Corridor activation prerequisites were not met.', 409, {
            routeId: result.routeId,
          });
        }
        if (result.outcome === 'FAILED') {
          throw new AppError(ErrorCode.INTERNAL_ERROR, 'Corridor activation failed.', 500, { routeId: result.routeId });
        }

        reply.send({
          emergencyId,
          outcome: result.outcome,
          routeId: result.routeId,
          corridor: result.activation,
          simulation: {
            priorityMode: 'SIMULATED',
            isLive: false,
            signalsControlled: false,
            notificationsDelivered: false,
          },
        });
      },
    },
    {
      method: 'GET',
      url: '/api/emergencies/:id/corridor',
      module: 'module_09',
      summary: 'Simulated corridor state for an emergency',
      auth: { roles: readRoles },
      params: emergencyParams,
      handler: async (request: HttpRequest<Record<string, unknown>>, reply: HttpReply) => {
        const id = emergencyParams.parse(request.params).id;
        const state = await corridors.getState(id);
        reply.send({
          emergencyId: id,
          corridor: state.corridor,
          simulation: {
            priorityMode: 'SIMULATED',
            isLive: state.isLive,
            signalsControlled: state.signalsControlled,
            notificationsDelivered: false,
          },
        });
      },
    },
  ];

  if (policeNotifications) {
    routes.push(
      {
        method: 'GET',
        url: '/api/emergencies/:id/police-notifications',
        module: 'module_09',
        summary: 'List simulated mock police control-room notices',
        auth: { roles: ['OPERATOR', 'DISPATCHER', 'ADMIN'] },
        params: emergencyParams,
        handler: async (request, reply) => {
          const emergencyId = emergencyParams.parse(request.params).id;
          const notifications = await policeNotifications.list(emergencyId);
          reply.send({ emergencyId, notifications, simulation: true, realPoliceContacted: false });
        },
      },
      {
        method: 'POST',
        url: '/api/emergencies/:id/police-notifications',
        module: 'module_09',
        summary: 'Record a simulated notice to the mock police control room for a dispatched response route',
        auth: { roles: actionRoles },
        params: emergencyParams,
        body: z.object({ routeId: z.string().min(1).max(128) }).strict(),
        handler: async (request, reply) => {
          const emergencyId = emergencyParams.parse(request.params).id;
          const { routeId } = z.object({ routeId: z.string().min(1).max(128) }).parse(request.body);
          if (!request.user?.userId) throw new AppError(ErrorCode.UNAUTHORIZED, 'Authentication is required.', 401);
          const notification = await policeNotifications.create(emergencyId, routeId, request.user.userId);
          reply.status(201).send({
            emergencyId,
            notification,
            simulation: true,
            recipient: 'MOCK_POLICE_CONTROL_ROOM',
            realPoliceContacted: false,
            trafficCleared: false,
            signalPriorityGranted: false,
          });
        },
      },
      {
        method: 'POST',
        url: '/api/emergencies/:id/police-notifications/:notificationId/acknowledge',
        module: 'module_09',
        summary: 'Record an explicit simulated acknowledgement for a mock control-room notice',
        auth: { roles: actionRoles },
        params: z.object({ id: z.string().min(1).max(128), notificationId: z.string().min(1).max(128) }).strict(),
        body: z.object({}).strict(),
        handler: async (request, reply) => {
          const { id, notificationId } = z.object({ id: z.string().min(1).max(128), notificationId: z.string().min(1).max(128) }).parse(request.params);
          if (!request.user?.userId) throw new AppError(ErrorCode.UNAUTHORIZED, 'Authentication is required.', 401);
          const notification = await policeNotifications.acknowledge(id, notificationId, request.user.userId);
          reply.send({ emergencyId: id, notification, simulation: true, acknowledgedBy: 'SIMULATED_OPERATOR', realPoliceAcknowledged: false });
        },
      },
    );
  }
  return routes;
}
