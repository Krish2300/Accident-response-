import { noopLogger, type Logger, type RouteDefinition, type RouteTable, type EventQueryPort } from '@resus/core';
import type { AnalyticsReadRepository } from '@resus/module_11_database_event_system';
import { loadModule12Config, type Module12Config } from './config.js';
import { AnalyticsService } from './analytics/analyticsService.js';
import { DashboardService } from './dashboard/dashboardService.js';
import { LearningService } from './learning/learningService.js';
import { createModule12Routes } from './api/routes.js';

export interface Module12Deps {
  analyticsRead: AnalyticsReadRepository;
  events: EventQueryPort;
  config?: Module12Config;
  logger?: Logger;
}

export class Module12 {
  readonly analytics: AnalyticsService;
  readonly dashboard: DashboardService;
  readonly learning: LearningService;
  readonly config: Module12Config;
  private readonly logger: Logger;

  constructor(deps: Module12Deps) {
    this.config = deps.config ?? loadModule12Config();
    this.logger = deps.logger ?? noopLogger;

    this.analytics = new AnalyticsService({
      analyticsRead: deps.analyticsRead,
      config: this.config,
      logger: this.logger,
    });
    this.dashboard = new DashboardService({
      analyticsRead: deps.analyticsRead,
      events: deps.events,
      config: this.config,
      logger: this.logger,
    });
    this.learning = new LearningService({
      analyticsRead: deps.analyticsRead,
      config: this.config,
      logger: this.logger,
    });
  }

  routes(): RouteDefinition<any>[] {
    return createModule12Routes(this.analytics, this.dashboard, this.learning);
  }

  register(table: RouteTable): void {
    table.addAll(this.routes());
  }
}
