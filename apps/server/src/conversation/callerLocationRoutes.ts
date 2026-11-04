import { z } from 'zod';
import { AppError, ErrorCode, type RouteDefinition } from '@resus/core';
import type { Module11 } from '@resus/data';
import type { CallerLocationResolutionService } from './callerLocationResolution.js';

const locationConfirmationBody = z.object({
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
}).strict().refine((value) => (value.latitude === undefined) === (value.longitude === undefined), {
  message: 'Latitude and longitude must be supplied together.',
});

const LOCATION_OPERATORS = ['DISPATCHER', 'OPERATOR', 'POLICE_CONTROL_ROOM', 'ADMIN'];

export function createCallerLocationRoutes(module11: Module11, locationResolution: CallerLocationResolutionService): RouteDefinition[] {
  return [
    {
      method: 'GET',
      url: '/api/emergencies/:id/location-resolutions',
      module: 'location-resolution',
      summary: 'Read persisted caller-stated location candidates and confirmations',
      auth: { roles: LOCATION_OPERATORS },
      handler: async (request, reply) => {
        const emergencyId = String(request.params.id ?? '');
        await module11.emergencies.requireById(emergencyId);
        const result = await module11.eventQuery.list({
          emergencyId,
          types: ['EMERGENCY_LOCATION_CANDIDATE', 'EMERGENCY_LOCATION_CONFIRMED'],
          limit: 200,
        });
        return reply.send({ emergencyId, items: result.items });
      },
    },
    {
      method: 'POST',
      url: '/api/emergencies/:id/location-resolutions/:resolutionId/retry',
      module: 'location-resolution',
      summary: 'Retry an unavailable or ambiguous caller location lookup',
      auth: { roles: LOCATION_OPERATORS },
      params: z.object({ id: z.string().min(1).max(64), resolutionId: z.string().min(1).max(128) }).strict(),
      handler: async (request, reply) => {
        const params = request.params as { id: string; resolutionId: string };
        const previous = await module11.eventQuery.getById(params.resolutionId);
        if (!previous) throw AppError.notFound('Caller location candidate', params.resolutionId);
        const result = await locationResolution.retry(params.id, params.resolutionId, previous);
        if (!result) throw new AppError(ErrorCode.CONFLICT, 'This caller location candidate cannot be retried.', 409);
        return reply.send({ item: result });
      },
    },
    {
      method: 'POST',
      url: '/api/emergencies/:id/location-resolutions/:resolutionId/confirm',
      module: 'location-resolution',
      summary: 'Confirm caller-stated coordinates as an operator action',
      auth: { roles: LOCATION_OPERATORS },
      params: z.object({ id: z.string().min(1).max(64), resolutionId: z.string().min(1).max(128) }).strict(),
      body: locationConfirmationBody,
      handler: async (request, reply) => {
        const user = request.user;
        if (!user) throw new AppError(ErrorCode.UNAUTHORIZED, 'Authentication required.', 401);
        const params = request.params as { id: string; resolutionId: string };
        const body = locationConfirmationBody.parse(request.body ?? {});
        const result = await module11.emergencies.confirmCallerLocation({
          emergencyId: params.id,
          resolutionId: params.resolutionId,
          actorId: user.userId,
          ...(body.latitude !== undefined ? { latitude: body.latitude } : {}),
          ...(body.longitude !== undefined ? { longitude: body.longitude } : {}),
        });
        return reply.send(result);
      },
    },
  ];
}
