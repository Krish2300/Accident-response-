import { z } from 'zod';
import { AppError, ErrorCode, type Ambulance, type EventQueryPort, type HttpReply, type HttpRequest, type RouteDefinition } from '@resus/core';
import type { AmbulanceRoutePort, RouteOptimizationService, RouteWriterPort } from '../routeOptimizationService.js';

const emergencyParams = z.object({ id: z.string().min(1).max(128) });
const routeParams = z.object({ id: z.string().min(1).max(128) });
const generateRouteBody = z.object({ leg: z.enum(['RESPONSE', 'TRANSPORT']) }).strict();
const recalculateRouteBody = z.object({ reason: z.string().min(1).max(500) }).strict();

/** Module 8 HTTP surface: explicit route generation and read-only route queries. */
export function createModule8Routes(
  optimization: RouteOptimizationService,
  routes: RouteWriterPort,
  driverAmbulances?: AmbulanceRoutePort,
  dispatchEvents?: EventQueryPort,
): RouteDefinition<Record<string, unknown>>[] {
  const readRoles = ['OPERATOR', 'DISPATCHER', 'CLINICAL_SUPERVISOR', 'ADMIN'];
  const actionRoles = ['DISPATCHER', 'ADMIN'];
  return [
    {
      method: 'POST',
      url: '/api/emergencies/:id/routes',
      module: 'module_08',
      summary: 'Generate one response or transport route for an emergency',
      auth: { roles: actionRoles },
      params: emergencyParams,
      body: generateRouteBody,
      handler: async (request: HttpRequest<Record<string, unknown>>, reply: HttpReply) => {
        const emergencyId = emergencyParams.parse(request.params).id;
        const { leg } = generateRouteBody.parse(request.body);
        if (leg === 'RESPONSE' && dispatchEvents) {
          const emergency = await optimization.getEmergencyForDispatchCheck?.(emergencyId);
          if (!emergency) throw AppError.notFound('Emergency', emergencyId);
          const ambulanceId = emergency?.assignedAmbulanceId;
          const relevant = await listDispatchEvidence(dispatchEvents, emergencyId, ambulanceId);
          const latestAssignment = relevant.filter((record) => record.type === 'AMBULANCE_ASSIGNED').at(-1);
          const dispatched = Boolean(latestAssignment && relevant.some((record) => record.type === 'AMBULANCE_DISPATCHED' && record.sequence > latestAssignment.sequence));
          if (!dispatched) throw new AppError(ErrorCode.CONFLICT, 'A persisted explicit ambulance dispatch is required before response route generation.', 409);
        }
        const result = await optimization.generateForEmergency(emergencyId, leg);

        switch (result.outcome) {
          case 'SKIPPED_NOT_FOUND':
            throw AppError.notFound('Emergency', emergencyId);
          case 'SKIPPED_SIMULATION':
            throw new AppError(ErrorCode.CONFLICT, 'Route generation is not enabled for simulation emergencies.', 409);
          case 'SKIPPED_STATUS':
            throw new AppError(ErrorCode.CONFLICT, result.reason ?? 'Route generation is not available for this emergency state.', 409);
          case 'SKIPPED_NO_AMBULANCE':
          case 'SKIPPED_NO_HOSPITAL':
          case 'SKIPPED_NO_POSITION':
          case 'SKIPPED_INVALID_LOCATION':
            throw new AppError(ErrorCode.CONFLICT, result.reason ?? `Route prerequisites are missing (${result.outcome}).`, 409);
          case 'FAILED':
            throw new AppError(ErrorCode.ROUTING_FAILED, 'Route generation failed.', 502, { reason: result.reason });
          case 'GENERATED':
          case 'SKIPPED_ALREADY_EXISTS': {
            const route = result.routeId ? await routes.findById(result.routeId) : null;
            if (!route) {
              throw new AppError(ErrorCode.INTERNAL_ERROR, 'Route operation completed without a readable persisted route.', 500);
            }
            reply.send({ emergencyId, outcome: result.outcome, route });
            return;
          }
        }
      },
    },
    {
      method: 'POST',
      url: '/api/routes/:id/recalculate',
      module: 'module_08',
      summary: 'Replace an established route with a newly computed one and record ROUTE_RECALCULATED',
      auth: { roles: actionRoles },
      params: routeParams,
      body: recalculateRouteBody,
      handler: async (request: HttpRequest<Record<string, unknown>>, reply: HttpReply) => {
        const routeId = routeParams.parse(request.params).id;
        const { reason } = recalculateRouteBody.parse(request.body);
        const result = await optimization.recalculateRoute(routeId, reason, {
          actorType: request.user?.role ?? 'SYSTEM',
          actorId: request.user?.userId ?? null,
        });

        switch (result.outcome) {
          case 'SKIPPED_NOT_FOUND':
            throw AppError.notFound('Route', routeId);
          case 'SKIPPED_SIMULATION':
            throw new AppError(ErrorCode.CONFLICT, 'Route recalculation is not enabled for simulation emergencies.', 409);
          case 'SKIPPED_STATUS':
            throw new AppError(ErrorCode.CONFLICT, result.reason ?? 'Route recalculation is not available for this route state.', 409);
          case 'SKIPPED_NO_AMBULANCE':
          case 'SKIPPED_NO_HOSPITAL':
          case 'SKIPPED_NO_POSITION':
          case 'SKIPPED_INVALID_LOCATION':
            throw new AppError(ErrorCode.CONFLICT, result.reason ?? `Route recalculation prerequisites are missing (${result.outcome}).`, 409);
          case 'UNSUPPORTED':
            throw new AppError(ErrorCode.INTERNAL_ERROR, result.reason ?? 'Route recalculation is not supported by this persistence layer.', 503);
          case 'FAILED':
            throw new AppError(ErrorCode.ROUTING_FAILED, 'Route recalculation failed.', 502, { reason: result.reason });
          case 'RECALCULATED': {
            const route = await routes.findById(routeId);
            if (!route) {
              throw new AppError(ErrorCode.INTERNAL_ERROR, 'Recalculation completed without a readable persisted route.', 500);
            }
            reply.send({ routeId, emergencyId: result.emergencyId, outcome: result.outcome, route });
            return;
          }
        }
      },
    },
    {
      method: 'GET',
      url: '/api/emergencies/:id/routes',
      module: 'module_08',
      summary: 'Planned routes for an emergency (response and transport legs)',
      auth: { roles: readRoles },
      params: emergencyParams,
      handler: async (request: HttpRequest<Record<string, unknown>>, reply: HttpReply) => {
        const id = emergencyParams.parse(request.params).id;
        reply.send({ emergencyId: id, routes: await routes.routesForEmergency(id) });
      },
    },
    {
      method: 'GET',
      url: '/api/routes/:id',
      module: 'module_08',
      summary: 'Read one planned route by id',
      auth: { roles: readRoles },
      params: z.object({ id: z.string().min(1).max(128) }),
      handler: async (request: HttpRequest<Record<string, unknown>>, reply: HttpReply) => {
        const id = String(request.params.id ?? '');
        const route = await routes.findById(id);
        if (!route) throw AppError.notFound('Route', id);
        reply.send(route);
      },
    },
    {
      method: 'GET',
      url: '/api/drivers/me/routes',
      module: 'module_08',
      summary: 'Read routes for the authenticated driver’s assigned emergency',
      auth: { roles: ['DRIVER', 'AMBULANCE_DRIVER'] },
      handler: async (request: HttpRequest<Record<string, unknown>>, reply: HttpReply) => {
        const driverId = request.user?.userId;
        if (!driverId) throw new AppError(ErrorCode.UNAUTHORIZED, 'Authentication is required.', 401);
        if (!driverAmbulances?.getAssignedAmbulanceForDriver) {
          throw new AppError(ErrorCode.INTERNAL_ERROR, 'Driver route lookup is unavailable.', 503);
        }
        const ambulance: Ambulance | null = await driverAmbulances.getAssignedAmbulanceForDriver(driverId);
        if (!ambulance?.currentEmergencyId || ambulance.status !== 'EN_ROUTE') {
          reply.send({ routes: [], reason: 'NO_DISPATCHED_ASSIGNMENT' });
          return;
        }
        const visible = (await routes.routesForEmergency(ambulance.currentEmergencyId))
          .filter((route) => route.ambulanceId === ambulance.id && route.originName === 'AMBULANCE' && route.destinationName === 'SCENE');
        reply.send({ emergencyId: ambulance.currentEmergencyId, ambulanceId: ambulance.id, routes: visible });
      },
    },
  ];
}

async function listDispatchEvidence(events: EventQueryPort, emergencyId: string, ambulanceId: string | null): Promise<Array<{ type: string; sequence: number }>> {
  if (!ambulanceId) return [];
  const matches: Array<{ type: string; sequence: number }> = [];
  let offset = 0;
  let total = 0;
  do {
    const page = await events.list({ emergencyId, types: ['AMBULANCE_ASSIGNED', 'AMBULANCE_DISPATCHED'], limit: 500, offset });
    total = page.total;
    for (const record of page.items) {
      const payload = record.payload as Record<string, unknown>;
      if (payload.ambulanceId === ambulanceId) matches.push({ type: record.type, sequence: record.sequence });
    }
    offset += page.items.length;
    if (page.items.length === 0) break;
  } while (offset < total);
  return matches;
}
