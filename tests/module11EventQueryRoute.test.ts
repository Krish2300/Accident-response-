import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '@resus/core';
import type { Module11 } from '../modules/module_11_database_event_system/src/module.js';
import { createModule11Routes } from '../modules/module_11_database_event_system/src/api/routes.js';
import { registerRoutes } from '../apps/server/src/http/routeAdapter.js';

describe('GET /api/events comma-separated type filter', () => {
  it('accepts the filtered query produced by the dashboard client', async () => {
    const list = vi.fn(async () => ({ items: [], total: 0, latestSequence: 0 }));
    const module11 = {
      events: { list },
      emergencies: {},
      calls: {},
    } as unknown as Module11;
    const app = Fastify({ logger: false });
    registerRoutes(app as never, createModule11Routes(module11), {
      authenticate: async () => ({
        userId: 'USR-TEST',
        email: 'dispatcher@example.test',
        role: 'DISPATCHER',
      } satisfies AuthContext),
    });

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/events?emergencyId=EMG-1&types=AMBULANCE_ASSIGNED%2CAMBULANCE_DISPATCHED&limit=500&offset=0',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ items: [], total: 0 });
      expect(list).toHaveBeenCalledWith(expect.objectContaining({
        emergencyId: 'EMG-1',
        types: ['AMBULANCE_ASSIGNED', 'AMBULANCE_DISPATCHED'],
        limit: 500,
        offset: 0,
      }));
    } finally {
      await app.close();
    }
  });
});
