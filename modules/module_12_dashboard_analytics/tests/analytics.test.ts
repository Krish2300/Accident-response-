import { describe, expect, it, vi } from 'vitest';
import { AnalyticsService } from '../src/analytics/analyticsService.js';

describe('AnalyticsService', () => {
  it('calculates summary', async () => {
    const analyticsRead = {
      emergencyDurations: vi.fn().mockResolvedValue([
        { status: 'COMPLETED', responseTimeMin: 10, totalDurationMin: 60 },
        { status: 'COMPLETED', responseTimeMin: 20, totalDurationMin: 80 },
      ]),
      liveState: vi.fn().mockResolvedValue({ ambulances: [{ status: 'EN_ROUTE' }, { status: 'AVAILABLE' }] }),
      eventBreakdown: vi.fn(),
      learningSamples: vi.fn(),
      snapshotSeries: vi.fn(),
      modelVersions: vi.fn(),
      insertLearningSample: vi.fn(),
      insertModelVersion: vi.fn(),
      saveSnapshot: vi.fn(),
    } as any;
    const service = new AnalyticsService({
      analyticsRead,
      config: { analytics: { defaultWindowDays: 30, maxWindowDays: 365, includeSimulationByDefault: true }, dashboard: {} as any, learning: {} as any } as any,
    });
    const summary = await service.getSummary();
    expect(summary.totalEmergencies).toBe(2);
    expect(summary.completedEmergencies).toBe(2);
    expect(summary.averageResponseTimeMin).toBe(15);
    expect(summary.ambulanceUtilizationRate).toBe(0.5);
  });
});
