import { z } from 'zod';
import { type HttpRequest, type RouteDefinition, AppError, ErrorCode } from '@resus/core';
import type { FleetService } from '../fleetService.js';
import type { AssignmentService } from '../assignment/assignmentService.js';
import type { TrackingService } from '../tracking/trackingService.js';

export function createModule6Routes(
  fleet: FleetService,
  assignment: AssignmentService,
  tracking: TrackingService,
): RouteDefinition<any>[] {
  const createAmbulanceBody = z.object({
    vehicleNumber: z.string().min(1).max(50),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    equipment: z.array(z.string()).optional(),
    stationName: z.string().optional(),
    isSimulation: z.boolean().optional(),
    status: z.string().optional(),
  });

  const locationUpdateBody = z.object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    speedKmh: z.number().optional(),
    headingDeg: z.number().optional(),
    accuracyM: z.number().optional(),
    source: z.string().optional(),
    isSimulation: z.boolean().optional(),
  });

  const assignBody = z.object({
    emergencyId: z.string().min(1),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    maxDistanceKm: z.number().positive().optional(),
  });

  const dispatchBody = z.object({
    emergencyId: z.string().min(1),
  });

  /**
   * A driver may only report the position of the ambulance assigned to them.
   *
   * The ambulance id arrives in the URL, so it is caller-controlled and cannot be
   * trusted on its own. Dispatchers and admins keep their existing blanket access;
   * for a driver the assignment is resolved from the authenticated user and
   * compared against the id in the path.
   */
  const assertMayUpdateLocation = async (req: HttpRequest<any>, ambulanceId: string): Promise<void> => {
    const user = req.user;
    if (!user || (user.role !== 'DRIVER' && user.role !== 'AMBULANCE_DRIVER')) return;
    const assigned = await fleet.getAssignedAmbulanceForDriver(user.userId);
    if (!assigned || assigned.id !== ambulanceId) {
      throw new AppError(
        ErrorCode.FORBIDDEN,
        'This driver is not assigned to the ambulance being updated.',
        403,
      );
    }
  };

  return [
    {
      method: 'GET',
      url: '/api/ambulances',
      module: 'module_06',
      summary: 'List ambulances',
      auth: { roles: ['OPERATOR', 'DISPATCHER', 'ADMIN'] },
      handler: async (_req, reply) => {
        const ambulances = await fleet.listAmbulances({ includeSimulation: true });
        return reply.send({ ambulances });
      },
    },
    {
      method: 'POST',
      url: '/api/ambulances',
      module: 'module_06',
      summary: 'Register ambulance',
      auth: { roles: ['DISPATCHER', 'ADMIN'] },
      body: createAmbulanceBody,
      handler: async (req, reply) => {
        const body = createAmbulanceBody.parse(req.body);
        const ambulance = await fleet.registerAmbulance(body as any);
        return reply.status(201).send({ ambulance });
      },
    },
    {
      method: 'GET',
      url: '/api/ambulances/:id',
      module: 'module_06',
      summary: 'Get ambulance',
      auth: { roles: ['OPERATOR', 'DISPATCHER', 'ADMIN'] },
      handler: async (req, reply) => {
        const id = String(req.params.id);
        const ambulance = await fleet.getAmbulance(id);
        const location = await fleet.getLatestLocation(id);
        return reply.send({ ambulance, location });
      },
    },
    {
      method: 'PATCH',
      url: '/api/ambulances/:id',
      module: 'module_06',
      summary: 'Update ambulance',
      auth: { roles: ['DISPATCHER', 'ADMIN'] },
      handler: async (req, reply) => {
        const id = String(req.params.id);
        const ambulance = await fleet.updateAmbulance(id, req.body as any);
        return reply.send({ ambulance });
      },
    },
    {
      method: 'POST',
      url: '/api/ambulances/:id/location',
      module: 'module_06',
      summary: 'Update ambulance location',
      auth: { roles: ['DISPATCHER', 'ADMIN', 'DRIVER', 'AMBULANCE_DRIVER'], public: false },
      body: locationUpdateBody,
      handler: async (req, reply) => {
        const id = String(req.params.id);
        const body = locationUpdateBody.parse(req.body);
        await assertMayUpdateLocation(req, id);
        const location = await tracking.updateLocation({ ambulanceId: id, ...body });
        return reply.send({ location });
      },
    },
    {
      method: 'POST',
      url: '/api/ambulances/assign',
      module: 'module_06',
      summary: 'Assign nearest ambulance',
      auth: { roles: ['DISPATCHER', 'ADMIN'] },
      body: assignBody,
      handler: async (req, reply) => {
        const body = assignBody.parse(req.body);
        const result = await assignment.selectAndAssign({
          emergencyId: body.emergencyId,
          latitude: body.latitude,
          longitude: body.longitude,
          maxDistanceKm: body.maxDistanceKm,
        });
        return reply.send(result);
      },
    },
    {
      method: 'POST',
      url: '/api/ambulances/:id/dispatch',
      module: 'module_06',
      summary: 'Dispatch ambulance',
      auth: { roles: ['DISPATCHER', 'ADMIN'] },
      body: dispatchBody,
      handler: async (req, reply) => {
        const id = String(req.params.id);
        const body = dispatchBody.parse(req.body);
        await fleet.dispatchAmbulance(id, body.emergencyId);
        return reply.send({ ok: true });
      },
    },
    {
      method: 'GET',
      url: '/api/ambulances/nearest',
      module: 'module_06',
      summary: 'Find nearest available ambulance',
      auth: { roles: ['OPERATOR', 'DISPATCHER', 'ADMIN'] },
      query: z.object({
        latitude: z.coerce.number().min(-90).max(90),
        longitude: z.coerce.number().min(-180).max(180),
      }),
      handler: async (req, reply) => {
        const query = req.query as any;
        const candidate = await fleet.findNearestAvailable({
          latitude: query.latitude,
          longitude: query.longitude,
        });
        if (!candidate) return reply.send({ candidate: null });
        return reply.send({ candidate });
      },
    },
    {
      method: 'GET',
      url: '/api/drivers/me/assignment',
      module: 'module_06',
      summary: 'Get current driver assignment',
      auth: { roles: ['DRIVER', 'AMBULANCE_DRIVER', 'DISPATCHER', 'ADMIN'] },
      handler: async (req, reply) => {
        const user = req.user;
        if (!user) {
          return reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
        }
        const ambulance = await fleet.getAssignedAmbulanceForDriver(user.userId);
        if (!ambulance) {
          return reply.send({ assigned: false, ambulance: null });
        }
        return reply.send({ assigned: true, ambulance });
      },
    },
  ];
}
