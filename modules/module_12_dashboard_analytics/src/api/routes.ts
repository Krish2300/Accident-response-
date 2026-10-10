import { z } from 'zod';
import { type RouteDefinition } from '@resus/core';
import type { AnalyticsService } from '../analytics/analyticsService.js';
import type { DashboardService } from '../dashboard/dashboardService.js';
import type { LearningService } from '../learning/learningService.js';

export function createModule12Routes(
  analytics: AnalyticsService,
  dashboard: DashboardService,
  learning: LearningService,
): RouteDefinition<any>[] {
  const querySchema = z.object({
    windowDays: z.coerce.number().int().positive().optional(),
    includeSimulation: z.coerce.boolean().optional(),
  });

  return [
    {
      method: 'GET',
      url: '/api/dashboard/summary',
      module: 'module_12',
      summary: 'Get analytics summary',
      auth: { roles: ['OPERATOR', 'DISPATCHER', 'ADMIN'] },
      query: querySchema,
      handler: async (req, reply) => {
        const query = querySchema.parse(req.query);
        const summary = await analytics.getSummary(query.windowDays, query.includeSimulation);
        return reply.send({ summary });
      },
    },
    {
      method: 'GET',
      url: '/api/dashboard/live',
      module: 'module_12',
      summary: 'Get live state',
      auth: { roles: ['OPERATOR', 'DISPATCHER', 'ADMIN'] },
      query: z.object({ includeSimulation: z.coerce.boolean().optional() }),
      handler: async (req, reply) => {
        const query = z.object({ includeSimulation: z.coerce.boolean().optional() }).parse(req.query);
        const live = await dashboard.getLiveState(query.includeSimulation);
        return reply.send(live);
      },
    },
    {
      method: 'GET',
      url: '/api/dashboard/metrics',
      module: 'module_12',
      summary: 'Get system metrics',
      auth: { roles: ['OPERATOR', 'DISPATCHER', 'ADMIN'] },
      query: querySchema,
      handler: async (req, reply) => {
        const query = querySchema.parse(req.query);
        const metrics = await dashboard.getSystemMetrics(query.windowDays, query.includeSimulation);
        return reply.send(metrics);
      },
    },
    {
      method: 'GET',
      url: '/api/dashboard/emergencies',
      module: 'module_12',
      summary: 'Get emergency durations',
      auth: { roles: ['OPERATOR', 'DISPATCHER', 'ADMIN'] },
      query: querySchema,
      handler: async (req, reply) => {
        const query = querySchema.parse(req.query);
        const emergencies = await analytics.getEmergencyDurations(query.windowDays, query.includeSimulation);
        return reply.send({ emergencies });
      },
    },
    {
      method: 'GET',
      url: '/api/dashboard/ambulances',
      module: 'module_12',
      summary: 'Get ambulance status',
      auth: { roles: ['OPERATOR', 'DISPATCHER', 'ADMIN'] },
      query: z.object({ includeSimulation: z.coerce.boolean().optional() }),
      handler: async (req, reply) => {
        const query = z.object({ includeSimulation: z.coerce.boolean().optional() }).parse(req.query);
        const live = await dashboard.getLiveState(query.includeSimulation);
        return reply.send({ ambulances: live.ambulances });
      },
    },
    {
      method: 'GET',
      url: '/api/dashboard/events/breakdown',
      module: 'module_12',
      summary: 'Get event breakdown',
      auth: { roles: ['OPERATOR', 'DISPATCHER', 'ADMIN'] },
      query: querySchema,
      handler: async (req, reply) => {
        const query = querySchema.parse(req.query);
        const breakdown = await analytics.getEventBreakdown(query.windowDays, query.includeSimulation);
        return reply.send({ breakdown });
      },
    },
    {
      method: 'GET',
      url: '/api/dashboard/emergencies/:id/timeline',
      module: 'module_12',
      summary: 'Get event timeline for emergency',
      auth: { roles: ['OPERATOR', 'DISPATCHER', 'ADMIN'] },
      handler: async (req, reply) => {
        const id = String(req.params.id);
        const events = await dashboard.getTimeline(id);
        return reply.send({ emergencyId: id, events });
      },
    },
    {
      method: 'GET',
      url: '/api/analytics/learning/samples',
      module: 'module_12',
      summary: 'Get learning samples',
      auth: { roles: ['ADMIN'] },
      query: querySchema,
      handler: async (req, reply) => {
        const query = querySchema.parse(req.query);
        const samples = await learning.getSamples(query.windowDays, query.includeSimulation);
        return reply.send({ samples });
      },
    },
    {
      method: 'GET',
      url: '/api/analytics/learning/insights',
      module: 'module_12',
      summary: 'Get learning insights',
      auth: { roles: ['ADMIN'] },
      query: querySchema,
      handler: async (req, reply) => {
        const query = querySchema.parse(req.query);
        const insights = await learning.getInsights(query.windowDays, query.includeSimulation);
        return reply.send({ insights });
      },
    },
  ];
}
