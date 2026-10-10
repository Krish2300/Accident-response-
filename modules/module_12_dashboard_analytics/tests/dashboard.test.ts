import { describe, expect, it, vi } from 'vitest';
import { DashboardService } from '../src/dashboard/dashboardService.js';

describe('DashboardService', () => {
  it('gets live state', async () => {
    const analyticsRead = {
      liveState: vi.fn().mockResolvedValue({ emergencies: [], ambulances: [], corridors: [] }),
    } as any;
    const events = {
      timeline: vi.fn().mockResolvedValue([]),
    } as any;
    const service = new DashboardService({
      analyticsRead,
      events,
      config: { analytics: {}, dashboard: { refreshIntervalMs: 5000, maxEventsInTimeline: 100 }, learning: {} } as any,
    });
    const live = await service.getLiveState();
    expect(live.ambulances).toEqual([]);
  });
});
