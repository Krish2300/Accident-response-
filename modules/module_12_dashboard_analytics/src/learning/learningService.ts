import type { AnalyticsReadRepository, LearningSampleRow } from '@resus/module_11_database_event_system';
import { emergencySeveritySchema, incidentTypeSchema, type Logger, noopLogger } from '@resus/core';
import { z } from 'zod';
import type { Module12Config } from '../config.js';

const featureValueSchema = z.union([z.number().finite(), z.boolean(), z.null()]);
const featureKeySchema = z.string().regex(/^[a-z][a-zA-Z0-9_]{0,63}$/);
const timestampSchema = z.string().datetime({ offset: true });

/** Versioned and JSON-persistable feature envelope; feature values cannot carry free text. */
export const learningFeatureSetSchema = z.object({
  version: z.literal(1),
  values: z.record(featureKeySchema, featureValueSchema).refine((values) => Object.keys(values).length > 0, {
    message: 'At least one version 1 feature is required.',
  }),
  review: z.object({
    status: z.literal('VERIFIED'),
    eligibility: z.literal('ELIGIBLE'),
    reviewedByUserId: z.string().trim().min(1).max(128),
    reviewedAt: timestampSchema,
    outcomeObservedAt: timestampSchema,
    evidenceRefs: z.array(z.string().trim().min(1).max(256)).min(1),
    isSimulation: z.literal(false),
    isTestData: z.literal(false),
  }).strict(),
}).strict();

export const learningSampleInputSchema = z.object({
  emergencyId: z.string().regex(/^EMG-[A-Z0-9]{6,32}$/, 'A canonical Module 11 emergencyId is required.'),
  hospitalId: z.string().trim().min(1).max(128).nullable().optional(),
  emergencyType: incidentTypeSchema,
  severity: emergencySeveritySchema,
  responseTimeMin: z.number().finite().nonnegative().nullable().optional(),
  dispatchTimeMin: z.number().finite().nonnegative().nullable().optional(),
  ambulanceDistanceKm: z.number().finite().nonnegative().nullable().optional(),
  hospitalDistanceKm: z.number().finite().nonnegative().nullable().optional(),
  protocolUsed: z.string().trim().min(1).max(128).nullable().optional(),
  protocolVersion: z.string().trim().min(1).max(128).nullable().optional(),
  escalationRequired: z.boolean(),
  routeDurationMin: z.number().finite().nonnegative().nullable().optional(),
  transportTimeMin: z.number().finite().nonnegative().nullable().optional(),
  totalDurationMin: z.number().finite().nonnegative().nullable().optional(),
  outcomeStatus: z.enum(['SURVIVED_TO_DISCHARGE', 'DECEASED', 'UNKNOWN']),
  survivalToDischarge: z.boolean().nullable(),
  features: learningFeatureSetSchema,
  provenance: z.literal('REAL_OBSERVED'),
}).strict().superRefine((sample, context) => {
  const expectedSurvival = sample.outcomeStatus === 'SURVIVED_TO_DISCHARGE'
    ? true
    : sample.outcomeStatus === 'DECEASED'
      ? false
      : null;
  if (sample.survivalToDischarge !== expectedSurvival) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['survivalToDischarge'],
      message: 'Outcome status and survival label must agree; UNKNOWN must remain null.',
    });
  }
});

export type LearningSampleInput = z.infer<typeof learningSampleInputSchema>;

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
      survivalRate: survivalRate === null ? null : Math.round(survivalRate * 100) / 100,
      topFactors: [],
      recommendations: [],
    };
  }

  async storeLearningSample(input: unknown): Promise<void> {
    const sample = learningSampleInputSchema.parse(input);
    if (!this.config.learning.enabled) return;
    await this.analyticsRead.insertLearningSample({
      ...sample,
      features: {
        version: sample.features.version,
        values: sample.features.values,
        review: sample.features.review,
      },
    });
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
