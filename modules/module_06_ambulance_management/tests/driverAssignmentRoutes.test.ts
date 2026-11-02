import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError, ErrorCode, RouteTable, type HttpRequest } from '@resus/core';
import { registerRoutes } from '../../../apps/server/src/http/routeAdapter.js';
import { createModule6Routes } from '../src/api/routes.js';

describe('Module 6 authenticated driver assignment decisions', () => {
  let app: ReturnType<typeof Fastify> | undefined;
  afterEach(async () => { await app?.close(); app = undefined; });

  function mount() {
    let activeAssignment: unknown = null;
    const decisions = vi.fn(async (input: { assignmentId: string; driverId: string; decision: 'ACCEPT' | 'DECLINE' }) => {
      if (input.assignmentId !== `ASG-${input.driverId}`) throw new AppError(ErrorCode.FORBIDDEN, 'Assignment belongs to another driver.', 403);
      return { id: input.assignmentId, status: input.decision === 'ACCEPT' ? 'ACCEPTED' : 'DECLINED' };
    });
    const fleet = {
      respondToDriverAssignment: decisions,
      dispatchAmbulance: vi.fn(async () => undefined),
      getAssignedAmbulanceForDriver: vi.fn(async () => null),
      getDriverAssignment: vi.fn(async () => activeAssignment),
      getAmbulance: vi.fn(async () => ({ id: 'AMB-1', isSimulation: false })),
    };
    const tracking = { updateLocation: vi.fn(async (input: unknown) => input) };
    const table = new RouteTable();
    table.addAll(createModule6Routes(fleet as never, {} as never, tracking as never));
    app = Fastify({ logger: false });
    registerRoutes(app as never, table.routes, {
      authenticate: async (request: HttpRequest) => request.headers.authorization === 'Bearer driver-a'
        ? { userId: 'DRIVER-A', role: 'DRIVER', email: 'a@example.test' }
        : request.headers.authorization === 'Bearer driver-b'
          ? { userId: 'DRIVER-B', role: 'AMBULANCE_DRIVER', email: 'b@example.test' }
          : request.headers.authorization === 'Bearer dispatcher'
            ? { userId: 'DISPATCHER-1', role: 'DISPATCHER', email: 'd@example.test' }
            : null,
    });
    return { decisions, fleet, tracking, setActiveAssignment(value: unknown) { activeAssignment = value; } };
  }

  it('derives driver identity from authentication, permits only own decisions and rejects malformed payloads', async () => {
    const { decisions } = mount();
    const own = await app!.inject({ method: 'POST', url: '/api/drivers/me/assignment/ASG-DRIVER-A/accept', headers: { authorization: 'Bearer driver-a' }, payload: {} });
    expect(own.statusCode).toBe(200);
    expect(own.json().assignment.status).toBe('ACCEPTED');
    expect(decisions).toHaveBeenCalledWith({ assignmentId: 'ASG-DRIVER-A', driverId: 'DRIVER-A', decision: 'ACCEPT' });

    const foreign = await app!.inject({ method: 'POST', url: '/api/drivers/me/assignment/ASG-DRIVER-A/decline', headers: { authorization: 'Bearer driver-b' }, payload: { reason: 'not mine' } });
    expect(foreign.statusCode).toBe(403);
    expect(decisions).toHaveBeenLastCalledWith({ assignmentId: 'ASG-DRIVER-A', driverId: 'DRIVER-B', decision: 'DECLINE', reason: 'not mine' });
    expect((await app!.inject({ method: 'POST', url: '/api/drivers/me/assignment/ASG-DRIVER-A/accept', headers: { authorization: 'Bearer driver-a' }, payload: { reason: 'unexpected field' } })).statusCode).toBe(422);
  });

  it('keeps driver endpoints restricted to drivers and explicitly reports that decline needs reassignment', async () => {
    const { decisions } = mount();
    expect((await app!.inject({ method: 'POST', url: '/api/drivers/me/assignment/ASG-DRIVER-A/accept' })).statusCode).toBe(401);
    expect((await app!.inject({ method: 'POST', url: '/api/drivers/me/assignment/ASG-DRIVER-A/accept', headers: { authorization: 'Bearer dispatcher' }, payload: {} })).statusCode).toBe(403);
    const declined = await app!.inject({ method: 'POST', url: '/api/drivers/me/assignment/ASG-DRIVER-A/decline', headers: { authorization: 'Bearer driver-a' }, payload: {} });
    expect(declined.statusCode).toBe(200);
    expect(declined.json().reassignmentRequired).toBe(true);
    expect(decisions).toHaveBeenCalledTimes(1);
  });

  it('allows only dispatcher roles to invoke the separate explicit dispatch endpoint', async () => {
    const { fleet } = mount();
    expect((await app!.inject({ method: 'POST', url: '/api/ambulances/AMB-1/dispatch', payload: { emergencyId: 'EMG-1' } })).statusCode).toBe(401);
    expect((await app!.inject({ method: 'POST', url: '/api/ambulances/AMB-1/dispatch', headers: { authorization: 'Bearer driver-a' }, payload: { emergencyId: 'EMG-1' } })).statusCode).toBe(403);
    const result = await app!.inject({ method: 'POST', url: '/api/ambulances/AMB-1/dispatch', headers: { authorization: 'Bearer dispatcher' }, payload: { emergencyId: 'EMG-1' } });
    expect(result.statusCode).toBe(200);
    expect(fleet.dispatchAmbulance).toHaveBeenCalledWith('AMB-1', 'EMG-1', 'DISPATCHER-1');
  });

  it('requires an active driver assignment for GPS uploads and overrides client source/simulation claims', async () => {
    const { fleet, tracking, setActiveAssignment } = mount();
    const denied = await app!.inject({ method: 'POST', url: '/api/ambulances/AMB-1/location', headers: { authorization: 'Bearer driver-a' }, payload: { latitude: 12, longitude: 77 } });
    expect(denied.statusCode).toBe(403);
    expect(tracking.updateLocation).not.toHaveBeenCalled();

    vi.mocked(fleet.getAssignedAmbulanceForDriver).mockResolvedValue({ id: 'AMB-1' } as never);
    setActiveAssignment({ ambulance: { id: 'AMB-1' }, assignment: { status: 'ACCEPTED' } });
    const accepted = await app!.inject({ method: 'POST', url: '/api/ambulances/AMB-1/location', headers: { authorization: 'Bearer driver-a' }, payload: { latitude: 12, longitude: 77, source: 'GPS', isSimulation: true } });
    expect(accepted.statusCode).toBe(200);
    expect(fleet.getDriverAssignment).toHaveBeenCalledWith('DRIVER-A');
    expect(tracking.updateLocation).toHaveBeenCalledWith(expect.objectContaining({ ambulanceId: 'AMB-1', latitude: 12, longitude: 77, source: 'MOBILE', isSimulation: false }));
  });
});
