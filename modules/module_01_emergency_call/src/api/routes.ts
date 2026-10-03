import { z } from 'zod';
import {
  RouteTable,
  incidentTypeSchema,
  emergencySeveritySchema,
  type RouteDefinition,
} from '@resus/core';
import type { CallService } from '../callService.js';

/**
 * HTTP surface for Module 1.
 *
 * Public reachability
 * -------------------
 * `POST /calls` is public. A bystander dialling an emergency number has no
 * account and no token, so requiring authentication here would make the system
 * unusable in its primary scenario. Everything else requires an authenticated
 * caller and is restricted to call-centre roles.
 *
 * The remaining routes read and manage an *already established* call on behalf of
 * staff; none of them may pick or change which guidance a caller receives.
 */
const openCallSchema = z
  .object({
    emergencyId: z.string().min(1).optional(),
    incidentType: incidentTypeSchema.optional(),
    severity: emergencySeveritySchema.optional(),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    description: z.string().max(4000).nullish(),
    callerId: z.string().max(64).nullish(),
    channel: z.string().max(32).optional(),
    language: z.string().max(8).optional(),
    isSimulation: z.boolean().optional(),
  })
  .refine(
    (value) => value.emergencyId !== undefined || (value.latitude !== undefined && value.longitude !== undefined),
    {
      message:
        'Supply `emergencyId` to attach to an existing emergency, or both `latitude` and `longitude` to create one.',
      path: ['latitude'],
    },
  )
  .refine((value) => (value.latitude === undefined) === (value.longitude === undefined), {
    message: '`latitude` and `longitude` must be supplied together.',
    path: ['longitude'],
  });

const utteranceSchema = z.object({
  speaker: z.enum(['CALLER', 'SYSTEM', 'OPERATOR']),
  text: z.string().min(1).max(4000),
  isFinal: z.boolean().optional(),
});

const paramsSchema = z.object({ id: z.string().min(1) });

// The transport is reported via `service.transportStatus()` rather than injected
// here, so the route table cannot be built for a transport other than the one the
// service is actually using.
export function createModule1Routes(service: CallService): RouteDefinition<any>[] {
  return [
    {
      method: 'POST',
      url: '/calls',
      module: 'module_01',
      summary: 'Open an emergency call, creating the emergency if one is not supplied',
      // Public: a bystander calling for help has no credentials.
      auth: { public: true },
      body: openCallSchema,
      handler: async (request, reply) => {
        const result = await service.open(request.body as z.infer<typeof openCallSchema>);
        reply.status(result.reused ? 200 : 201).send(result);
      },
    },
    {
      method: 'POST',
      url: '/calls/:id/hangup',
      module: 'module_01',
      summary: 'End a call and record its duration',
      auth: { roles: ['CALL_CENTRE', 'OPERATOR', 'ADMIN'] },
      params: paramsSchema,
      body: z.object({ reason: z.string().max(500).optional() }).optional(),
      handler: async (request, reply) => {
        const { id } = request.params as { id: string };
        const reason = (request.body as { reason?: string } | undefined)?.reason;
        reply.send(await service.close(id, reason ?? 'Call ended.'));
      },
    },
    {
      method: 'POST',
      url: '/calls/:id/utterances',
      module: 'module_01',
      summary: 'Append an utterance to a live call transcript',
      auth: { roles: ['CALL_CENTRE', 'OPERATOR', 'ADMIN'] },
      params: paramsSchema,
      body: utteranceSchema,
      handler: async (request, reply) => {
        const { id } = request.params as { id: string };
        reply.status(201).send(
          await service.recordUtterance({
            callSessionId: id,
            ...(request.body as z.infer<typeof utteranceSchema>),
          }),
        );
      },
    },
    {
      method: 'GET',
      url: '/emergencies/:id/transcript',
      module: 'module_01',
      summary: 'Read the ordered transcript for an emergency',
      auth: { roles: ['CALL_CENTRE', 'OPERATOR', 'ADMIN', 'PARAMEDIC', 'DOCTOR'] },
      params: paramsSchema,
      handler: async (request, reply) => {
        const { id } = request.params as { id: string };
        reply.send({ emergencyId: id, transcripts: await service.transcript(id) });
      },
    },
    {
      method: 'GET',
      url: '/calls/:id',
      module: 'module_01',
      summary: 'Read the current call session for an emergency',
      auth: { roles: ['CALL_CENTRE', 'OPERATOR', 'ADMIN'] },
      params: paramsSchema,
      handler: async (request, reply) => {
        const { id } = request.params as { id: string };
        reply.send(await service.currentSession(id));
      },
    },
    {
      method: 'GET',
      url: '/calls/transport/status',
      module: 'module_01',
      summary: 'Report the telephony transport and whether it is live',
      auth: { public: true },
      handler: async (_request, reply) => {
        const status = await service.transportStatus();
        // 503 when the configured transport cannot be reached: an operator must
        // be able to alert on this rather than discover it from a missed call.
        reply.status(status.reachable ? 200 : 503).send(status);
      },
    },
  ];
}

export function registerModule1Routes(table: RouteTable, service: CallService): void {
  table.addAll(createModule1Routes(service));
}