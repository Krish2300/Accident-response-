import { z } from 'zod';
import { AppError, ErrorCode, type HttpRequest, type RouteDefinition } from '@resus/core';
import type { Module11 } from '@resus/data';

/**
 * Kerala Police control-room API.
 *
 * Officers (role POLICE_CONTROL_ROOM, or ADMIN) can list every call - live and
 * historical - and retrieve the complete record of any call at any time by its
 * case number: caller number, location and landmark, full transcript, every
 * system event, ambulance assignment and GPS, hospital, routes, corridor,
 * protocol steps and location candidates.
 *
 * Every request is written to the append-only access audit (who, what, when,
 * from which address) before the data is returned, so a read that cannot be
 * audited is refused rather than served.
 */
export const POLICE_ROLES = ['POLICE_CONTROL_ROOM', 'ADMIN'];

const ACTIVE = ['CREATED', 'CALL_ACTIVE', 'CLASSIFIED', 'PROTOCOL_ACTIVE', 'AWAITING_AMBULANCE', 'AMBULANCE_ASSIGNED', 'EN_ROUTE', 'ON_SCENE', 'PATIENT_ONBOARD', 'TRANSPORTING', 'AT_HOSPITAL'];

const listQuery = z.object({
  scope: z.enum(['active', 'all']).default('active'),
  q: z.string().max(100).optional(),
  since: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
  includeSimulation: z.enum(['true', 'false']).default('false'),
});
const caseParams = z.object({ caseNumber: z.string().min(3).max(40).regex(/^[A-Za-z0-9-]+$/) });

function actor(request: HttpRequest) {
  const user = request.user;
  if (!user) throw new AppError(ErrorCode.UNAUTHORIZED, 'Authentication required.', 401);
  return { userId: user.userId, userEmail: user.email, role: user.role, ipAddress: request.ip ?? null };
}

export function createPoliceRoutes(module11: Module11): RouteDefinition[] {
  async function summary(emergency: Awaited<ReturnType<Module11['emergencies']['requireById']>>) {
    const [sessions, ambulance, hospital] = await Promise.all([
      module11.calls.sessionsForEmergency(emergency.id),
      emergency.assignedAmbulanceId ? module11.ambulances.findById(emergency.assignedAmbulanceId) : null,
      emergency.selectedHospitalId ? module11.hospitals.findById(emergency.selectedHospitalId) : null,
    ]);
    const first = sessions[0];
    return {
      caseNumber: emergency.caseNumber ?? emergency.id,
      emergencyId: emergency.id,
      createdAt: emergency.createdAt,
      updatedAt: emergency.updatedAt,
      status: emergency.status,
      incidentType: emergency.incidentType,
      severity: emergency.severity,
      location: { latitude: emergency.latitude, longitude: emergency.longitude, description: emergency.address ?? null },
      caller: { number: first?.callerId ?? emergency.callerId ?? null, channel: first?.channel ?? null, language: first?.language ?? null },
      callActive: sessions.some((session) => session.status === 'ACTIVE'),
      ambulance: ambulance ? { vehicleNumber: ambulance.vehicleNumber, status: ambulance.status, station: ambulance.stationName, latitude: ambulance.latitude, longitude: ambulance.longitude } : null,
      hospital: hospital ? { name: hospital.name, latitude: hospital.latitude, longitude: hospital.longitude } : null,
      isSimulation: emergency.isSimulation,
    };
  }

  async function resolveCase(caseNumber: string) {
    const emergency = (await module11.emergencies.findByCaseNumber(caseNumber)) ?? (await module11.emergencies.findById(caseNumber));
    if (!emergency) throw AppError.notFound('Case', caseNumber);
    return emergency;
  }

  async function fullRecord(caseNumber: string) {
    const emergency = await resolveCase(caseNumber);
    const [head, sessions, transcripts, events, assignments, routes, corridor, protocolSessions, notifications] = await Promise.all([
      summary(emergency),
      module11.calls.sessionsForEmergency(emergency.id),
      module11.calls.transcriptsFor(emergency.id),
      module11.eventQuery.list({ emergencyId: emergency.id, limit: 1000 }),
      module11.ambulances.assignmentsForEmergency(emergency.id),
      module11.routes.routesForEmergency(emergency.id),
      module11.routes.getCorridor(emergency.id),
      module11.protocols.listSessionsForEmergency(emergency.id),
      module11.notifications.listForEmergency(emergency.id),
    ]);
    const trail = emergency.assignedAmbulanceId ? await module11.ambulances.locationTrail(emergency.assignedAmbulanceId, 500) : [];
    return {
      ...head,
      description: emergency.description,
      callSessions: sessions,
      transcript: transcripts.map((line) => ({ at: line.recordedAt, speaker: line.speaker, text: line.text, sequence: line.sequence })),
      events: events.items,
      assignments,
      routes,
      corridor,
      protocolSessions,
      notifications,
      ambulanceTrail: trail,
      generatedAt: new Date().toISOString(),
    };
  }

  return [
    {
      method: 'GET',
      url: '/api/police/calls',
      module: 'police',
      summary: 'List live (or all) emergency calls for the police control room',
      auth: { roles: POLICE_ROLES },
      handler: async (request, reply) => {
        const query = listQuery.parse(request.query ?? {});
        const includeSimulation = query.includeSimulation === 'true';
        await module11.accessAudit.record({ ...actor(request), action: 'LIST_CALLS', emergencyId: null, caseNumber: null, detail: JSON.stringify({ scope: query.scope, q: query.q ?? null }) });
        let rows = await module11.emergencies.list({
          statuses: query.scope === 'active' ? ACTIVE : undefined,
          includeSimulation,
          since: query.since,
          limit: query.q ? 500 : query.limit,
          offset: query.q ? 0 : query.offset,
        });
        if (query.q) {
          const needle = query.q.trim().toLowerCase();
          rows = rows.filter((row) => [row.caseNumber, row.id, row.callerId, row.address, row.description, row.incidentType]
            .some((value) => typeof value === 'string' && value.toLowerCase().includes(needle))).slice(0, query.limit);
        }
        return reply.send({ items: await Promise.all(rows.map(summary)), scope: query.scope });
      },
    },
    {
      method: 'GET',
      url: '/api/police/calls/:caseNumber',
      module: 'police',
      summary: 'Complete record of one call by case number (audited)',
      auth: { roles: POLICE_ROLES },
      params: caseParams,
      handler: async (request, reply) => {
        const { caseNumber } = caseParams.parse(request.params);
        const emergency = await resolveCase(caseNumber);
        await module11.accessAudit.record({ ...actor(request), action: 'VIEW_CALL', emergencyId: emergency.id, caseNumber: emergency.caseNumber ?? null, detail: null });
        return reply.send(await fullRecord(caseNumber));
      },
    },
    {
      method: 'GET',
      url: '/api/police/calls/:caseNumber/export',
      module: 'police',
      summary: 'Download the complete call record as a JSON file (audited)',
      auth: { roles: POLICE_ROLES },
      params: caseParams,
      handler: async (request, reply) => {
        const { caseNumber } = caseParams.parse(request.params);
        const emergency = await resolveCase(caseNumber);
        await module11.accessAudit.record({ ...actor(request), action: 'EXPORT_CALL', emergencyId: emergency.id, caseNumber: emergency.caseNumber ?? null, detail: null });
        reply.header('content-disposition', `attachment; filename="${(emergency.caseNumber ?? emergency.id).replace(/[^A-Za-z0-9-]/g, '')}.json"`);
        return reply.send(await fullRecord(caseNumber));
      },
    },
    {
      method: 'GET',
      url: '/api/police/calls/:caseNumber/access-log',
      module: 'police',
      summary: 'Who has accessed this call record (append-only audit)',
      auth: { roles: POLICE_ROLES },
      params: caseParams,
      handler: async (request, reply) => {
        const { caseNumber } = caseParams.parse(request.params);
        const emergency = await resolveCase(caseNumber);
        await module11.accessAudit.record({ ...actor(request), action: 'VIEW_ACCESS_LOG', emergencyId: emergency.id, caseNumber: emergency.caseNumber ?? null, detail: null });
        return reply.send({ items: await module11.accessAudit.list({ emergencyId: emergency.id }) });
      },
    },
    {
      method: 'GET',
      url: '/api/police/access-log',
      module: 'police',
      summary: 'Recent access audit across all calls (ADMIN only)',
      auth: { roles: ['ADMIN'] },
      handler: async (request, reply) => {
        await module11.accessAudit.record({ ...actor(request), action: 'VIEW_GLOBAL_ACCESS_LOG', emergencyId: null, caseNumber: null, detail: null });
        return reply.send({ items: await module11.accessAudit.list({ limit: 500 }) });
      },
    },
  ];
}
