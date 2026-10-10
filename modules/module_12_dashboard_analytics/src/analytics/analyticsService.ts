import type { AnalyticsReadRepository, EmergencyDurationRow, LiveAmbulanceRow, LiveEmergencyRow, LearningSampleRow } from '@resus/module_11_database_event_system';
import { type Logger, noopLogger } from '@resus/core';
import type { Module12Config } from '../config.js';

export interface AnalyticsServiceDeps {
  analyticsRead: AnalyticsReadRepository;
  config: Module12Config;
  logger?: Logger;
}

export interface AnalyticsSummary {
  windowDays: number;
  totalEmergencies: number;
  completedEmergencies: number;
  averageResponseTimeMin: number | null;
  averageTotalDurationMin: number | null;
  ambulanceUtilizationRate: number;
}

export class AnalyticsService {
  private readonly analyticsRead: AnalyticsReadRepository;
  private readonly config: Module12Config;
  private readonly logger: Logger;

  constructor(deps: AnalyticsServiceDeps) {
    this.analyticsRead = deps.analyticsRead;
    this.config = deps.config;
    this.logger = deps.logger ?? noopLogger;
  }

  async getSummary(windowDays?: number, includeSimulation?: boolean): Promise<AnalyticsSummary> {
    const days = windowDays ?? this.config.analytics.defaultWindowDays;
    const sim = includeSimulation ?? this.config.analytics.includeSimulationByDefault;
    const durations = await this.analyticsRead.emergencyDurations(days, sim);

    const total = durations.length;
    const completed = durations.filter((d) => d.status === 'COMPLETED').length;

    const responseTimes = durations
      .map((d) => d.responseTimeMin)
      .filter((t): t is number => t !== null);
    const totalTimes = durations
      .map((d) => d.totalDurationMin)
      .filter((t): t is number => t !== null);

    const avgResponse = responseTimes.length > 0 ? responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length : null;
    const avgTotal = totalTimes.length > 0 ? totalTimes.reduce((a, b) => a + b, 0) / totalTimes.length : null;

    const live = await this.analyticsRead.liveState(sim);
    const utilization = live.ambulances.length > 0
      ? live.ambulances.filter((a) => a.status !== 'AVAILABLE').length / live.ambulances.length
      : 0;

    return {
      windowDays: days,
      totalEmergencies: total,
      completedEmergencies: completed,
      averageResponseTimeMin: avgResponse ? Math.round(avgResponse * 100) / 100 : null,
      averageTotalDurationMin: avgTotal ? Math.round(avgTotal * 100) / 100 : null,
      ambulanceUtilizationRate: Math.round(utilization * 100) / 100,
    };
  }

  async getEmergencyDurations(windowDays?: number, includeSimulation?: boolean): Promise<EmergencyDurationRow[]> {
    const days = windowDays ?? this.config.analytics.defaultWindowDays;
    const sim = includeSimulation ?? this.config.analytics.includeSimulationByDefault;
    return this.analyticsRead.emergencyDurations(days, sim);
  }

  async getLiveState(includeSimulation?: boolean): Promise<any> {
    const sim = includeSimulation ?? this.config.analytics.includeSimulationByDefault;
    return this.analyticsRead.liveState(sim);
  }

  async getEventBreakdown(windowDays?: number, includeSimulation?: boolean): Promise<any[]> {
    const days = windowDays ?? this.config.analytics.defaultWindowDays;
    const sim = includeSimulation ?? this.config.analytics.includeSimulationByDefault;
    return this.analyticsRead.eventBreakdown(days, sim);
  }

  async getLearningSamples(windowDays?: number, includeSimulation?: boolean): Promise<LearningSampleRow[]> {
    const days = windowDays ?? this.config.analytics.defaultWindowDays;
    const sim = includeSimulation ?? this.config.analytics.includeSimulationByDefault;
    return this.analyticsRead.learningSamples({ windowDays: days, includeSimulation: sim });
  }

  async getSnapshotSeries(days?: number): Promise<any[]> {
    return this.analyticsRead.snapshotSeries(days ?? 30);
  }
}
