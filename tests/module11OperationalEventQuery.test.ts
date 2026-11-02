import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '@resus/core';
import type { Module11 } from '../modules/module_11_database_event_system/src/module.js';
import { createModule11Routes } from '../modules/module_11_database_event_system/src/api/routes.js';
import { registerRoutes } from '../apps/server/src/http/routeAdapter.js';

function buildApp(role: string | null) {
  const list = vi.fn(async () => ({ items: [], total: 0, latestSequence: 0 }));
  const module11 = {
    events: { list },
    emergencies: {},
    calls: {},
  } as unknown as Module11;
  const app = Fastify({ logger: false });
  registerRoutes(app as never, createModule11Routes(module11), {
    authenticate: async () =>
      role
        ? ({ userId: 'USR-STAGE423', email: `${role.toLowerCase()}@stage423.test`, role } satisfies AuthContext)
        : null,
  });
  return { app, list };
}

describe('GET /api/events durable operational event history', () => {
  it('passes HOSPITAL_RESOURCE_UPDATED and ROUTE_RECALCULATED through the type filter with entityId scoping', async () => {
    const { app, list } = buildApp('OPERATOR');
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/events?types=HOSPITAL_RESOURCE_UPDATED%2CROUTE_RECALCULATED&entityId=HSP-STAGE423&limit=50',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ items: [], total: 0 });
      expect(list).toHaveBeenCalledWith(expect.objectContaining({
        types: ['HOSPITAL_RESOURCE_UPDATED', 'ROUTE_RECALCULATED'],
        entityId: 'HSP-STAGE423',
        limit: 50,
      }));
    } finally {
      await app.close();
    }
  });

  it('requires authentication (401) and refuses roles outside the event-read list (403) without querying', async () => {
    const anonymous = buildApp(null);
    try {
      const denied = await anonymous.app.inject({ method: 'GET', url: '/api/events' });
      expect(denied.statusCode).toBe(401);
      expect(denied.json().error).toMatchObject({ code: 'UNAUTHORIZED' });
      expect(anonymous.list).not.toHaveBeenCalled();
    } finally {
      await anonymous.app.close();
    }

    const driver = buildApp('DRIVER');
    try {
      const forbidden = await driver.app.inject({ method: 'GET', url: '/api/events' });
      expect(forbidden.statusCode).toBe(403);
      expect(forbidden.json().error).toMatchObject({
        code: 'FORBIDDEN',
        allowedRoles: ['OPERATOR', 'DISPATCHER', 'CLINICAL_SUPERVISOR', 'ADMIN'],
      });
      expect(driver.list).not.toHaveBeenCalled();
    } finally {
      await driver.app.close();
    }
  });
});
