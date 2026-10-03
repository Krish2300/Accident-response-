import { z } from 'zod';
import {
  SYSTEM_EVENT_TYPES,
  AppError,
  incidentTypeSchema,
  isSystemEventType,
  paginated,
  type RouteDefinition,
} from '@resus/core';
import type { Module11 } from '../module.js';

const listEventsQuery = z.object({
  emergencyId: z.string().optional(),
  entityId: z.string().optional(),
  types: z
    .string()
    .optional()
    .transform((value) =>
      value
        ? value
            .split(',')
            .map((item) => item.trim())
            .filter((item) => isSystemEventType(item))
        : undefined,
    ),
  sinceSequence: z.coerce.number().int().nonnegative().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const createEmergencyBody = z.object({
  incidentType: incidentTypeSchema,
  severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  description: z.string().max(2000).nullish(),
  callerId: z.string().max(64).nullish(),
  address: z.string().max(300).nullish(),
  isSimulation: z.boolean().default(false),
  /** Optional immediate classification. */
  classify: z.boolean().default(false),
  classificationConfidence: z.number().min(0).max(1).optional(),
});

const updateEmergencyBody = z.object({
  status: z
    .enum([
      'CREATED',
      'CALL_ACTIVE',
      'CLASSIFIED',
      'PROTOCOL_ACTIVE',
      'AWAITING_AMBULANCE',
      'AMBULANCE_ASSIGNED',
      'EN_ROUTE',
      'ON_SCENE',
      'PATIENT_ONBOARD',
      'TRANSPORTING',
      'AT_HOSPITAL',
      'COMPLETED',
      'CANCELLED',
    ])
    .optional(),
  severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']).optional(),
  description: z.string().max(2000).nullish(),
  selectedHospitalId: z.string().nullish(),
});

/**
 * Module 11 HTTP surface.
 *
 * `GET /api/events`, `GET /api/events/:id`, `GET /api/emergencies/:id/events`
 * are the event log endpoints. The emergency intake endpoints exist because
 * every workflow in the specification starts with a created emergency; in a
 * larger deployment this moves to the call-intake module unchanged.
 */
export function createModule11Routes(module11: Module11): RouteDefinition<any>[] {
  const { emergencies, events, calls } = module11;

  return [
    {
      method: 'GET',
      url: '/api/events',
      module: 'module_11',
      summary: 'Query the append-only system event log',
      auth: { roles: ['OPERATOR', 'DISPATCHER', 'CLINICAL_SUPERVISOR', 'ADMIN'] },
      query: listEventsQuery,
      handler: async (request, reply) => {
        const query = listEventsQuery.parse(request.query);
        const result = await events.list({
          emergencyId: query.emergencyId,
          entityId: query.entityId,
          types: query.types as never,
          sinceSequence: query.sinceSequence,
          since: query.since,
          until: query.until,
          limit: query.limit,
          offset: query.offset,
        });
        return reply.send({
          items: result.items,
          total: result.total,
          limit: query.limit ?? 100,
          offset: query.offset ?? 0,
          latestSequence: result.latestSequence,
        });
      },
    },
    {
      method: 'GET',
      url: '/api/events/types',
      module: 'module_11',
      summary: 'Event type vocabulary',
      auth: { public: true },
      handler: async (_request, reply) => reply.send({ types: SYSTEM_EVENT_TYPES }),
    },
    {
      method: 'GET',
      url: '/api/events/:id',
      module: 'module_11',
      summary: 'Fetch a single event by id',
      auth: { roles: ['OPERATOR', 'DISPATCHER', 'CLINICAL_SUPERVISOR', 'ADMIN'] },
      handler: async (request, reply) => {
        const id = String(request.params.id ?? '');
        const event = await events.getById(id);
        if (!event) throw AppError.notFound('Event', id);
        return reply.send(event);
      },
    },
    {
      method: 'GET',
      url: '/api/emergencies/:id/events',
      module: 'module_11',
      summary: 'Ordered timeline of one emergency (derived from the event log)',
      auth: { roles: ['OPERATOR', 'DISPATCHER', 'CLINICAL_SUPERVISOR', 'ADMIN'] },
      handler: async (request, reply) => {
        const id = String(request.params.id ?? '');
        await emergencies.requireById(id);
        return reply.send({ emergencyId: id, events: await events.timeline(id) });
      },
    },
    {
      method: 'GET',
      url: '/api/emergencies',
      module: 'module_11',
      summary: 'List emergencies',
      auth: { roles: ['OPERATOR', 'DISPATCHER', 'CLINICAL_SUPERVISOR', 'ADMIN'] },
      query: z.object({
        status: z.string().optional(),
        includeSimulation: z.coerce.boolean().default(false),
        limit: z.coerce.number().int().min(1).max(200).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      }),
      handler: async (request, reply) => {
        const query = request.query as { status?: string; includeSimulation?: boolean; limit?: number; offset?: number };
        const items = await emergencies.list({
          statuses: query.status ? query.status.split(',') : undefined,
          includeSimulation: query.includeSimulation,
          limit: query.limit,
          offset: query.offset,
        });
        return reply.send(
          paginated(items, items.length, query.limit ?? 100, query.offset ?? 0),
        );
      },
    },
    {
      method: 'GET',
      url: '/api/emergencies/:id',
      module: 'module_11',
      summary: 'Read one emergency',
      auth: { roles: ['OPERATOR', 'DISPATCHER', 'CLINICAL_SUPERVISOR', 'ADMIN'] },
      handler: async (request, reply) => reply.send(await emergencies.requireById(String(request.params.id ?? ''))),
    },
    {
      method: 'POST',
      url: '/api/emergencies',
      module: 'module_11',
      summary: 'Create an emergency (writes the row and the EMERGENCY_CREATED event in one transaction)',
      auth: { roles: ['OPERATOR', 'DISPATCHER', 'ADMIN'] },
      body: createEmergencyBody,
      handler: async (request, reply) => {
        const body = createEmergencyBody.parse(request.body);
        const emergency = await emergencies.create({
          incidentType: body.incidentType,
          severity: body.severity,
          latitude: body.latitude,
          longitude: body.longitude,
          description: body.description ?? null,
          callerId: body.callerId ?? null,
          address: body.address ?? null,
          isSimulation: body.isSimulation,
          actor: { actorType: 'OPERATOR', actorId: request.user?.userId ?? null },
        });

        // A call session is opened for every emergency so transcripts have a home.
        const call = await calls.startSession({
          emergencyId: emergency.id,
          callerId: body.callerId ?? null,
          isSimulation: body.isSimulation,
        });

        let classified = emergency;
        if (body.classify) {
          classified = await emergencies.setStatus(
            emergency.id,
            'CLASSIFIED',
            {
              type: 'EMERGENCY_CLASSIFIED',
              payload: {
                incidentType: body.incidentType,
                severity: body.severity,
                confidence: body.classificationConfidence ?? 1,
                source: 'OPERATOR',
              },
            },
            { actorType: 'OPERATOR', actorId: request.user?.userId ?? null },
          );
        }

        return reply.status(201).send({ emergency: classified, callSession: call });
      },
    },
    {
      method: 'PATCH',
      url: '/api/emergencies/:id',
      module: 'module_11',
      summary: 'Operator update of an emergency',
      auth: { roles: ['OPERATOR', 'DISPATCHER', 'ADMIN'] },
      body: updateEmergencyBody,
      handler: async (request, reply) => {
        const id = String(request.params.id ?? '');
        const body = updateEmergencyBody.parse(request.body);
        const emergency = await emergencies.update(
          id,
          {
            status: body.status,
            severity: body.severity,
            description: body.description,
            selectedHospitalId: body.selectedHospitalId,
          },
          body.status
            ? {
                type: 'EMERGENCY_STATUS_CHANGED',
                payload: { from: (await emergencies.requireById(id)).status, to: body.status, source: 'OPERATOR' },
              }
            : undefined,
          { actorType: 'OPERATOR', actorId: request.user?.userId ?? null },
        );
        return reply.send(emergency);
      },
    },
    {
      method: 'GET',
      url: '/api/emergencies/:id/transcripts',
      module: 'module_11',
      summary: 'Verbatim call transcript for an emergency',
      auth: { roles: ['OPERATOR', 'DISPATCHER', 'CLINICAL_SUPERVISOR', 'ADMIN'] },
      handler: async (request, reply) => {
        const id = String(request.params.id ?? '');
        await emergencies.requireById(id);
        return reply.send({ emergencyId: id, transcripts: await calls.transcriptsFor(id) });
      },
    },
  ];
}
