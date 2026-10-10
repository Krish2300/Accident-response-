import type { EventQueryPort } from '@resus/core';
import type { AnalyticsReadRepository } from '@resus/module_11_database_event_system';
import { type Logger, noopLogger } from '@resus/core';
import type { Module12Config } from '../config.js';

export interface DashboardServiceDeps {
  analyticsRead: AnalyticsReadRepository;
  events: EventQueryPort;
  config: Module12Config;
  logger?: Logger;
}

export class DashboardService {
  private readonly analyticsRead: AnalyticsReadRepository;
  private readonly events: EventQueryPort;
  private readonly config: Module12Config;
  private readonly logger: Logger;

  constructor(deps: DashboardServiceDeps) {
    this.analyticsRead = deps.analyticsRead;
    this.events = deps.events;
    this.config = deps.config;
    this.logger = deps.logger ?? noopLogger;
  }

  async getLiveState(includeSimulation?: boolean) {
    const sim = includeSimulation ?? this.config.analytics.includeSimulationByDefault;
    return this.analyticsRead.liveState(sim);
  }

  async getTimeline(emergencyId: string, limit?: number) {
    const events = await this.events.timeline(emergencyId);
    const max = limit ?? this.config.dashboard.maxEventsInTimeline;
    return events.slice(0, max);
  }

  async getSystemMetrics(windowDays?: number, includeSimulation?: boolean) {
    const days = windowDays ?? this.config.analytics.defaultWindowDays;
    const sim = includeSimulation ?? this.config.analytics.includeSimulationByDefault;
    const [live, events, durations] = await Promise.all([
      this.analyticsRead.liveState(sim),
      this.analyticsRead.eventBreakdown(days, sim),
      this.analyticsRead.emergencyDurations(days, sim),
    ]);
    return {
      live,
      events,
      durations,
    };
  }
}
