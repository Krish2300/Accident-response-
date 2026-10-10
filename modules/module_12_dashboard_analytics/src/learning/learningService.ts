import type { AnalyticsReadRepository, LearningSampleRow } from '@resus/module_11_database_event_system';
import { type Logger, noopLogger } from '@resus/core';
import type { Module12Config } from '../config.js';

export interface LearningServiceDeps {
  analyticsRead: AnalyticsReadRepository;
  config: Module12Config;
  logger?: Logger;
}

export interface LearningInsight {
  modelVersion: number;
  samples: number;
  survivalRate: number | null;
  topFactors: Array<{ factor: string; importance: number }>;
  recommendations: string[];
}

export class LearningService {
  private readonly analyticsRead: AnalyticsReadRepository;
  private readonly config: Module12Config;
  private readonly logger: Logger;

  constructor(deps: LearningServiceDeps) {
    this.analyticsRead = deps.analyticsRead;
    this.config = deps.config;
    this.logger = deps.logger ?? noopLogger;
  }

  async getInsights(windowDays?: number, includeSimulation?: boolean): Promise<LearningInsight> {
    const days = windowDays ?? this.config.analytics.defaultWindowDays;
    const sim = includeSimulation ?? this.config.analytics.includeSimulationByDefault;
    const samples = await this.analyticsRead.learningSamples({ windowDays: days, includeSimulation: sim });
    const modelVersions = await this.analyticsRead.modelVersions(1);

    const survivalCases = samples.filter((s) => s.survivalToDischarge === true).length;
    const totalKnown = samples.filter((s) => s.survivalToDischarge !== null).length;
    const survivalRate = totalKnown > 0 ? survivalCases / totalKnown : null;

    return {
      modelVersion: modelVersions[0]?.version ?? 0,
      samples: samples.length,
      survivalRate: survivalRate ? Math.round(survivalRate * 100) / 100 : null,
      topFactors: [],
      recommendations: [],
    };
  }

  async storeLearningSample(input: any): Promise<void> {
    if (!this.config.learning.enabled) return;
    await this.analyticsRead.insertLearningSample(input);
  }

  async getSamples(windowDays?: number, includeSimulation?: boolean): Promise<LearningSampleRow[]> {
    const days = windowDays ?? this.config.analytics.defaultWindowDays;
    const sim = includeSimulation ?? this.config.analytics.includeSimulationByDefault;
    return this.analyticsRead.learningSamples({ windowDays: days, includeSimulation: sim });
  }

  // Learning layer is isolated - never overrides protocol logic
  isSafetyCritical(): boolean {
    return false;
  }
}
