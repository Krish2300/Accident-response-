import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RouteTable, type HttpRequest } from '@resus/core';
import { registerRoutes } from '../../../apps/server/src/http/routeAdapter.js';
import { createModule7Routes } from '../src/api/routes.js';

describe('Module 7 explicit hospital selection route', () => {
  let app: ReturnType<typeof Fastify> | undefined;
  afterEach(async () => { await app?.close(); app = undefined; });

  function mount(outcome: string, override?: Record<string, unknown>) {
    const selectForEmergency = vi.fn(async (_id: string) => ({ emergencyId: 'EMG-1', outcome, hospitalId: 'HSP-1', ...override }) as never);
    const table = new RouteTable();
    table.addAll(createModule7Routes({ selectForEmergency } as never));
    app = Fastify({ logger: false });
    registerRoutes(app as never, table.routes, {
      authenticate: async (request: HttpRequest) => {
        const token = request.headers.authorization;
        if (token === 'Bearer dispatcher') return { userId: 'U-D', role: 'DISPATCHER', email: 'dispatch@example.test' };
        if (token === 'Bearer operator') return { userId: 'U-O', role: 'OPERATOR', email: 'operator@example.test' };
        return null;
      },
    });
    return { selectForEmergency };
  }

  it('requires authentication and the dispatcher/admin action role', async () => {
    mount('SELECTED');
    expect((await app!.inject({ method: 'POST', url: '/api/emergencies/EMG-1/hospital-selection', payload: {} })).statusCode).toBe(401);
    expect((await app!.inject({ method: 'POST', url: '/api/emergencies/EMG-1/hospital-selection', headers: { authorization: 'Bearer operator' }, payload: {} })).statusCode).toBe(403);
  });

  it('validates the body and invokes the existing selection service with the canonical emergency id', async () => {
    const { selectForEmergency } = mount('SELECTED');
    const invalid = await app!.inject({ method: 'POST', url: '/api/emergencies/EMG-1/hospital-selection', headers: { authorization: 'Bearer dispatcher' }, payload: { hospitalId: 'HSP-OTHER' } });
    expect(invalid.statusCode).toBe(422);
    const response = await app!.inject({ method: 'POST', url: '/api/emergencies/EMG-1/hospital-selection', headers: { authorization: 'Bearer dispatcher' }, payload: {} });
    expect(response.statusCode).toBe(200);
    expect(response.json().emergencyId).toBe('EMG-1');
    expect(selectForEmergency).toHaveBeenCalledWith('EMG-1');
  });

  it.each([
    ['SKIPPED_NOT_FOUND', 404],
    ['SKIPPED_SIMULATION', 409],
    ['SKIPPED_STATUS', 409],
    ['NO_CANDIDATE', 422],
    ['FAILED', 500],
  ])('does not report %s as success', async (outcome, expected) => {
    mount(outcome);
    const response = await app!.inject({ method: 'POST', url: '/api/emergencies/EMG-1/hospital-selection', headers: { authorization: 'Bearer dispatcher' }, payload: {} });
    expect(response.statusCode).toBe(expected);
    expect(response.json()).toHaveProperty('error');
  });

  it('returns the existing choice idempotently when the service reports one already selected', async () => {
    mount('SKIPPED_ALREADY_SELECTED', { hospitalId: 'HSP-EXISTING' });
    const response = await app!.inject({ method: 'POST', url: '/api/emergencies/EMG-1/hospital-selection', headers: { authorization: 'Bearer dispatcher' }, payload: {} });
    expect(response.statusCode).toBe(200);
    expect(response.json().result.hospitalId).toBe('HSP-EXISTING');
  });
});
