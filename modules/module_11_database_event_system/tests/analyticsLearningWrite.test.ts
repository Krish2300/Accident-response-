import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { AnalyticsReadRepository } from '../src/repositories/analyticsRepository.js';

const input = {
  emergencyId: 'EMG-ABCDEF1234ABCD',
  emergencyType: 'TRAUMA',
  severity: 'HIGH',
  escalationRequired: false,
  outcomeStatus: 'SURVIVED_TO_DISCHARGE',
  survivalToDischarge: true,
  features: { version: 1, values: { responseTimeMin: 8 }, review: { status: 'VERIFIED' } },
  provenance: 'REAL_OBSERVED',
};

function repository(isSimulation: boolean | null) {
  const tx = {
    emergency: { findUnique: vi.fn().mockResolvedValue(isSimulation === null ? null : { isSimulation }) },
    outcomeAssertion: { findMany: vi.fn().mockResolvedValue([{
      id: 'OUTA-CURRENT-001',
      dataClassification: 'OPERATIONAL', provenance: 'REAL_OBSERVED', category: input.outcomeStatus,
      survivalToDischarge: input.survivalToDischarge,
      reviews: [{ decision: 'APPROVED', eligibleForLearning: true }],
    }]) },
    learningSample: { upsert: vi.fn().mockResolvedValue(undefined) },
  };
  const db = {
    $transaction: vi.fn(async (work: (transaction: typeof tx) => Promise<unknown>) => work(tx)),
  } as unknown as PrismaClient;
  return { repo: new AnalyticsReadRepository(db), tx, db };
}

describe('learning sample persistence eligibility', () => {
  it('verifies the canonical emergency is non-simulation before storing a real sample', async () => {
    const { repo, tx, db } = repository(false);
    await repo.insertLearningSample(input);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.emergency.findUnique).toHaveBeenCalledWith({
      where: { id: input.emergencyId }, select: { isSimulation: true },
    });
    expect(tx.learningSample.upsert).toHaveBeenCalledTimes(1);
    expect(tx.learningSample.upsert.mock.calls[0]?.[0]).toMatchObject({
      create: { outcomeAssertionId: 'OUTA-CURRENT-001' },
      update: { outcomeAssertionId: 'OUTA-CURRENT-001' },
    });
  });

  it('rejects a simulation emergency labelled as real before writing', async () => {
    const { repo, tx } = repository(true);
    await expect(repo.insertLearningSample(input)).rejects.toMatchObject({ statusCode: 422 });
    expect(tx.learningSample.upsert).not.toHaveBeenCalled();
  });

  it('rejects simulated provenance attached to a non-simulation emergency', async () => {
    const { repo, tx } = repository(false);
    await expect(repo.insertLearningSample({ ...input, provenance: 'SIMULATION' })).rejects.toMatchObject({ statusCode: 422 });
    expect(tx.outcomeAssertion.findMany).not.toHaveBeenCalled();
    expect(tx.learningSample.upsert).not.toHaveBeenCalled();
  });

  it('rejects a sample for a missing emergency before writing', async () => {
    const { repo, tx } = repository(null);
    await expect(repo.insertLearningSample(input)).rejects.toMatchObject({ statusCode: 422 });
    expect(tx.learningSample.upsert).not.toHaveBeenCalled();
  });

  it('rejects a test-classified outcome from operational learning', async () => {
    const { repo, tx } = repository(false);
    tx.outcomeAssertion.findMany.mockResolvedValue([{
      id: 'OUTA-TEST-001',
      dataClassification: 'TEST', provenance: 'SIMULATION', category: input.outcomeStatus,
      survivalToDischarge: input.survivalToDischarge,
      reviews: [{ decision: 'APPROVED', eligibleForLearning: true }],
    }]);
    await expect(repo.insertLearningSample(input)).rejects.toMatchObject({ statusCode: 422 });
    expect(tx.learningSample.upsert).not.toHaveBeenCalled();
  });
});
