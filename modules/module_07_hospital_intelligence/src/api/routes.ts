import { z } from 'zod';
import {
  AppError,
  ErrorCode,
  HOSPITAL_RESOURCE_TYPES,
  type HttpReply,
  type HttpRequest,
  type RouteDefinition,
} from '@resus/core';
import type { HospitalSelectionService } from '../hospitalSelectionService.js';
import type { HospitalResourceWriterPort } from '../hospitalResourceService.js';

const emergencyParams = z.object({ id: z.string().min(1).max(128) });
const hospitalParams = z.object({ hospitalId: z.string().min(1).max(128) });
const resourceUpdateBody = z
  .object({
    resourceType: z.enum(HOSPITAL_RESOURCE_TYPES),
    code: z.string().max(64).optional(),
    total: z.number().int().min(0),
    available: z.number().int().min(0),
  })
  .strict()
  .refine((body) => body.available <= body.total, {
    message: 'available cannot exceed total',
    path: ['available'],
  });

/** Explicit operator action. Automation remains controlled separately by Module 7 config. */
export function createModule7Routes(
  selection: HospitalSelectionService,
  hospitalResources?: HospitalResourceWriterPort,
): RouteDefinition<Record<string, unknown>>[] {
  const routes: RouteDefinition<Record<string, unknown>>[] = [
    {
      method: 'POST',
      url: '/api/emergencies/:id/hospital-selection',
      module: 'module_07',
      summary: 'Select a suitable hospital for an emergency',
      auth: { roles: ['DISPATCHER', 'ADMIN'] },
      params: emergencyParams,
      body: z.object({}).strict(),
      handler: async (request: HttpRequest<Record<string, never>>, reply: HttpReply) => {
        const emergencyId = emergencyParams.parse(request.params).id;
        const result = await selection.selectForEmergency(emergencyId);

        switch (result.outcome) {
          case 'SKIPPED_NOT_FOUND':
            throw AppError.notFound('Emergency', emergencyId);
          case 'SKIPPED_SIMULATION':
            throw new AppError(ErrorCode.CONFLICT, 'Hospital selection is not enabled for simulation emergencies.', 409);
          case 'SKIPPED_STATUS':
            throw new AppError(ErrorCode.CONFLICT, result.reason ?? 'Hospital selection is not available for this emergency state.', 409);
          case 'NO_CANDIDATE':
            throw new AppError(ErrorCode.HOSPITAL_NO_SUITABLE_CANDIDATE, 'No suitable hospital is available for this emergency.', 422, {
              consideredCandidates: result.consideredCandidates ?? 0,
            });
          case 'FAILED':
            throw new AppError(ErrorCode.INTERNAL_ERROR, 'Hospital selection failed.', 500);
          case 'SELECTED':
          case 'SKIPPED_ALREADY_SELECTED':
            reply.send({ emergencyId, result });
            return;
        }
      },
    },
  ];

  if (hospitalResources) {
    routes.push({
      method: 'PATCH',
      url: '/api/hospitals/:hospitalId/resources',
      module: 'module_07',
      summary: 'Update one hospital resource availability count and record HOSPITAL_RESOURCE_UPDATED',
      auth: { roles: ['DISPATCHER', 'ADMIN'] },
      params: hospitalParams,
      body: resourceUpdateBody,
      handler: async (request: HttpRequest<z.infer<typeof resourceUpdateBody>>, reply: HttpReply) => {
        const { hospitalId } = hospitalParams.parse(request.params);
        const body = resourceUpdateBody.parse(request.body);
        const resource = await hospitalResources.updateResourceAvailability({
          hospitalId,
          resourceType: body.resourceType,
          code: body.code ?? null,
          total: body.total,
          available: body.available,
          actor: {
            actorType: request.user?.role ?? 'OPERATOR',
            actorId: request.user?.userId ?? null,
          },
        });
        reply.send({ hospitalId, resource });
      },
    });
  }

  return routes;
}
