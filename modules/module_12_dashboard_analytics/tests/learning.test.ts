import { describe, expect, it, vi } from 'vitest';
import { LearningService, learningSampleInputSchema } from '../src/learning/learningService.js';

const validSample = () => ({
  emergencyId: 'EMG-ABCDEF1234ABCD',
  emergencyType: 'TRAUMA',
  severity: 'HIGH',
  responseTimeMin: 8.5,
  dispatchTimeMin: 2,
  ambulanceDistanceKm: 4.2,
  hospitalDistanceKm: null,
  protocolUsed: 'general-triage',
  protocolVersion: '1.0',
  escalationRequired: false,
  routeDurationMin: 12,
  transportTimeMin: null,
  totalDurationMin: null,
  outcomeStatus: 'SURVIVED_TO_DISCHARGE' as const,
  survivalToDischarge: true,
  features: {
    version: 1 as const,
    values: { responseTimeMin: 8.5, escalated: false },
    review: {
      status: 'VERIFIED' as const,
      eligibility: 'ELIGIBLE' as const,
      reviewedByUserId: 'USR-ABCDEF1234ABCD',
      reviewedAt: '2026-10-17T10:00:00.000Z',
      outcomeObservedAt: '2026-10-16T10:00:00.000Z',
      evidenceRefs: ['EVT-ABC123'],
      isSimulation: false as const,
      isTestData: false as const,
    },
  },
  provenance: 'REAL_OBSERVED' as const,
});

function makeService(enabled: boolean) {
  const analyticsRead = {
    insertLearningSample: vi.fn().mockResolvedValue(undefined),
    insertModelVersion: vi.fn().mockResolvedValue(undefined),
    learningSamples: vi.fn().mockResolvedValue([]),
    modelVersions: vi.fn().mockResolvedValue([]),
  } as any;
  const service = new LearningService({
    analyticsRead,
    config: {
      analytics: { defaultWindowDays: 30, includeSimulationByDefault: false },
      learning: { enabled, minSamplesForUpdate: 10 },
    } as any,
  });
  return { service, analyticsRead };
}

describe('LearningService contracts and write gate', () => {
  it('does not write a valid sample when learning is disabled', async () => {
    const { service, analyticsRead } = makeService(false);
    await service.storeLearningSample(validSample());
    expect(analyticsRead.insertLearningSample).not.toHaveBeenCalled();
    expect(analyticsRead.insertModelVersion).not.toHaveBeenCalled();
  });

  it('does not turn an explicit simulation read into a sample or model-version write', async () => {
    const { service, analyticsRead } = makeService(false);
    await service.getSamples(30, true);
    expect(analyticsRead.learningSamples).toHaveBeenCalledWith({ windowDays: 30, includeSimulation: true });
    expect(analyticsRead.insertLearningSample).not.toHaveBeenCalled();
    expect(analyticsRead.insertModelVersion).not.toHaveBeenCalled();
  });

  it('allows a validated reviewed sample only after explicit opt-in', async () => {
    const { service, analyticsRead } = makeService(true);
    await service.storeLearningSample(validSample());
    expect(analyticsRead.insertLearningSample).toHaveBeenCalledTimes(1);
    expect(analyticsRead.insertLearningSample).toHaveBeenCalledWith(expect.objectContaining({
      emergencyId: 'EMG-ABCDEF1234ABCD',
      provenance: 'REAL_OBSERVED',
      features: expect.objectContaining({ version: 1, review: expect.objectContaining({ eligibility: 'ELIGIBLE' }) }),
    }));
    expect(analyticsRead.insertModelVersion).not.toHaveBeenCalled();
    expect((service as unknown as { trainModel?: unknown }).trainModel).toBeUndefined();
    expect((service as unknown as { activateModel?: unknown }).activateModel).toBeUndefined();
  });

  it('rejects noncanonical or missing emergency identity', () => {
    expect(learningSampleInputSchema.safeParse({ ...validSample(), emergencyId: '' }).success).toBe(false);
    expect(learningSampleInputSchema.safeParse({ ...validSample(), emergencyId: 'some-other-id' }).success).toBe(false);
    const missingIdentity: Record<string, unknown> = { ...validSample() };
    delete missingIdentity.emergencyId;
    expect(learningSampleInputSchema.safeParse(missingIdentity).success).toBe(false);
  });

  it('does not reach persistence when runtime sample validation fails', async () => {
    const { service, analyticsRead } = makeService(true);
    await expect(service.storeLearningSample({ ...validSample(), emergencyId: 'EMG-1' })).rejects.toThrow();
    expect(analyticsRead.insertLearningSample).not.toHaveBeenCalled();
  });

  it('rejects invalid feature versions, free-text feature values, invalid labels and provenance', () => {
    expect(learningSampleInputSchema.safeParse({
      ...validSample(), features: { ...validSample().features, version: 2 },
    }).success).toBe(false);
    expect(learningSampleInputSchema.safeParse({
      ...validSample(), features: { ...validSample().features, values: { transcript: 'caller text' } },
    }).success).toBe(false);
    expect(learningSampleInputSchema.safeParse({ ...validSample(), outcomeStatus: 'OTHER' }).success).toBe(false);
    expect(learningSampleInputSchema.safeParse({ ...validSample(), provenance: 'SIMULATION' }).success).toBe(false);
    expect(learningSampleInputSchema.safeParse({ ...validSample(), survivalToDischarge: false }).success).toBe(false);
  });

  it('rejects unreviewed, ineligible, simulated and test data', () => {
    const base = validSample();
    const review = base.features.review;
    expect(learningSampleInputSchema.safeParse({
      ...base, features: { ...base.features, review: { ...review, status: 'PENDING' } },
    }).success).toBe(false);
    expect(learningSampleInputSchema.safeParse({
      ...base, features: { ...base.features, review: { ...review, eligibility: 'INELIGIBLE' } },
    }).success).toBe(false);
    expect(learningSampleInputSchema.safeParse({
      ...base, features: { ...base.features, review: { ...review, isSimulation: true } },
    }).success).toBe(false);
    expect(learningSampleInputSchema.safeParse({
      ...base, features: { ...base.features, review: { ...review, isTestData: true } },
    }).success).toBe(false);
    expect(learningSampleInputSchema.safeParse({
      ...base, features: { ...base.features, review: { ...review, evidenceRefs: [] } },
    }).success).toBe(false);
  });

  it('retains unknown outcomes as null instead of converting them to a negative label', async () => {
    const unknown = { ...validSample(), outcomeStatus: 'UNKNOWN' as const, survivalToDischarge: null };
    expect(learningSampleInputSchema.parse(unknown).survivalToDischarge).toBeNull();
    const { service, analyticsRead } = makeService(true);
    await service.storeLearningSample(unknown);
    expect(analyticsRead.insertLearningSample).toHaveBeenCalledWith(expect.objectContaining({
      outcomeStatus: 'UNKNOWN', survivalToDischarge: null,
    }));
    expect(learningSampleInputSchema.safeParse({ ...unknown, survivalToDischarge: false }).success).toBe(false);
  });

  it('keeps a true zero survival rate distinct from unknown', async () => {
    const { service } = makeService(false);
    const serviceWithKnownDeaths = new LearningService({
      analyticsRead: {
        learningSamples: vi.fn().mockResolvedValue([{ survivalToDischarge: false }]),
        modelVersions: vi.fn().mockResolvedValue([]),
      } as any,
      config: { analytics: { defaultWindowDays: 30, includeSimulationByDefault: false }, learning: { enabled: false, minSamplesForUpdate: 10 } } as any,
    });
    expect((await serviceWithKnownDeaths.getInsights()).survivalRate).toBe(0);
    expect((await service.getInsights()).survivalRate).toBeNull();
  });
});
