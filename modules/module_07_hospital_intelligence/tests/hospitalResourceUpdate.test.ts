import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError, ErrorCode, RouteTable, type HttpRequest } from '@resus/core';
import { registerRoutes } from '../../../apps/server/src/http/routeAdapter.js';
import { createModule7Routes } from '../src/api/routes.js';

describe('Module 7 hospital resource update route', () => {
  let app: ReturnType<typeof Fastify> | undefined;
  afterEach(async () => { await app?.close(); app = undefined; });

  function mount(updateResourceAvailability = vi.fn(async () => ({ id: 'RSC-1', hospitalId: 'HSP-1', resourceType: 'ICU_BED', code: '', total: 10, available: 4, updatedAt: '2026-01-01T00:00:00.000Z' }) as never)) {
    const selection = { selectForEmergency: vi.fn() };
    const table = new RouteTable();
    table.addAll(createModule7Routes(selection as never, { updateResourceAvailability }));
    app = Fastify({ logger: false });
    registerRoutes(app as never, table.routes, {
      authenticate: async (request: HttpRequest) => {
        const token = request.headers.authorization;
        if (token === 'Bearer dispatcher') return { userId: 'U-D', role: 'DISPATCHER', email: 'dispatch@example.test' };
        if (token === 'Bearer operator') return { userId: 'U-O', role: 'OPERATOR', email: 'operator@example.test' };
        return null;
      },
    });
    return { updateResourceAvailability };
  }

  const url = '/api/hospitals/HSP-1/resources';
  const validBody = { resourceType: 'ICU_BED', total: 10, available: 4 };

  it('requires authentication and the dispatcher/admin action role', async () => {
    mount();
    expect((await app!.inject({ method: 'PATCH', url, payload: validBody })).statusCode).toBe(401);
    expect((await app!.inject({ method: 'PATCH', url, headers: { authorization: 'Bearer operator' }, payload: validBody })).statusCode).toBe(403);
  });

  it('validates the resource type and count invariants before invoking the writer', async () => {
    const { updateResourceAvailability } = mount();
    const badType = await app!.inject({ method: 'PATCH', url, headers: { authorization: 'Bearer dispatcher' }, payload: { ...validBody, resourceType: 'VENTILATOR' } });
    expect(badType.statusCode).toBe(422);
    const negative = await app!.inject({ method: 'PATCH', url, headers: { authorization: 'Bearer dispatcher' }, payload: { ...validBody, available: -1 } });
    expect(negative.statusCode).toBe(422);
    const overTotal = await app!.inject({ method: 'PATCH', url, headers: { authorization: 'Bearer dispatcher' }, payload: { ...validBody, total: 3, available: 4 } });
    expect(overTotal.statusCode).toBe(422);
    expect(updateResourceAvailability).not.toHaveBeenCalled();
  });

  it('passes the canonical hospital id, body values and actor through to the writer', async () => {
    const { updateResourceAvailability } = mount();
    const response = await app!.inject({
      method: 'PATCH',
      url,
      headers: { authorization: 'Bearer dispatcher' },
      payload: { ...validBody, code: 'DEFIBRILLATOR' },
    });
    expect(response.statusCode).toBe(200);
    expect(updateResourceAvailability).toHaveBeenCalledWith({
      hospitalId: 'HSP-1',
      resourceType: 'ICU_BED',
      code: 'DEFIBRILLATOR',
      total: 10,
      available: 4,
      actor: { actorType: 'DISPATCHER', actorId: 'U-D' },
    });
    expect(response.json().hospitalId).toBe('HSP-1');
    expect(response.json().resource).toMatchObject({ resourceType: 'ICU_BED', available: 4 });
  });

  it('maps a missing hospital resource to 404 without claiming success', async () => {
    mount(vi.fn(async () => { throw AppError.notFound('Hospital resource', 'HSP-1/ICU_BED/default'); }));
    const response = await app!.inject({ method: 'PATCH', url, headers: { authorization: 'Bearer dispatcher' }, payload: validBody });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toHaveProperty('error');
  });

  it('maps a failed persistence to an error response', async () => {
    mount(vi.fn(async () => { throw new AppError(ErrorCode.INTERNAL_ERROR, 'Failed to update hospital resource.', 500); }));
    const response = await app!.inject({ method: 'PATCH', url, headers: { authorization: 'Bearer dispatcher' }, payload: validBody });
    expect(response.statusCode).toBe(500);
  });
});
