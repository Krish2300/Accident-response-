import Fastify, { type FastifyInstance } from 'fastify';
import type { AuthContext, RouteDefinition } from '@resus/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerRoutes } from '../../../../apps/server/src/http/routeAdapter';
import { createModule10LifecycleRoutes } from '../src/lifecycle/routes';
import type { Module10LifecycleProjection } from '../src/lifecycle/types';

const projection: Module10LifecycleProjection = {
  emergencyId: 'EMG-lifecycle-route-test',
  state: 'EMERGENCY_CREATED',
  facts: {},
  processedEventIds: ['EVT-created'],
  lastEventId: 'EVT-created',
  lastSequence: 1,
  anomalies: [],
};

describe('GET /api/emergencies/:id/lifecycle HTTP behavior', () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function makeApp(
    getProjection: (id: string) => Module10LifecycleProjection | null,
    authenticate: (authorization: unknown) => Promise<AuthContext | null> = async (authorization) =>
      authorization === 'Bearer test-token'
        ? { userId: 'test-user', role: 'OPERATOR', email: 'test@local' }
        : null,
  ): Promise<FastifyInstance> {
    const app = Fastify({ logger: false });
    apps.push(app);
    const routes = createModule10LifecycleRoutes({ getProjection });
    registerRoutes(app as never, routes as RouteDefinition<never>[], {
      authenticate: async (request) => authenticate(request.headers.authorization),
    });
    await app.ready();
    return app;
  }

  const url = '/api/emergencies/EMG-lifecycle-route-test/lifecycle';
  const authorized = { authorization: 'Bearer test-token' };

  it('returns 200 with the existing lifecycle projection', async () => {
    const app = await makeApp(() => projection);
    const response = await app.inject({ method: 'GET', url, headers: authorized });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ projection });
  });

  it('returns 404 only when the requested projection is absent', async () => {
    const app = await makeApp(() => null);
    const response = await app.inject({ method: 'GET', url, headers: authorized });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: "Lifecycle projection 'EMG-lifecycle-route-test' was not found.",
        details: null,
      },
    });
  });

  it('returns 401 before querying the projection when unauthenticated', async () => {
    const getProjection = vi.fn(() => projection);
    const app = await makeApp(getProjection);
    const response = await app.inject({ method: 'GET', url });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHORIZED');
    expect(getProjection).not.toHaveBeenCalled();
  });

  it('keeps genuine observer failures on the 5xx path', async () => {
    const app = await makeApp(() => { throw new Error('observer lookup failed'); });
    const response = await app.inject({ method: 'GET', url, headers: authorized });

    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe('INTERNAL_ERROR');
    expect(response.json().error.message).toBe('Unexpected server error.');
  });
});
