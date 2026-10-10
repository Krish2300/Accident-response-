import { describe, expect, it, vi } from 'vitest';
import { AssignmentService } from '../src/assignment/assignmentService.js';

describe('AssignmentService', () => {
  it('selects nearest available ambulance', async () => {
    const fleet = {
      findNearestAmbulances: vi.fn().mockResolvedValue([
        {
          ambulance: { id: 'AMB-1', vehicleNumber: 'AMB001', status: 'AVAILABLE' },
          distanceKm: 5.2,
          isStale: false,
          location: { latitude: 1, longitude: 1, recordedAt: new Date().toISOString() },
        },
      ]),
      assignAmbulance: vi.fn().mockResolvedValue({
        id: 'ASG-1',
        estimatedResponseTimeMin: 10,
        distanceKm: 5.2,
        matchingFactors: ['nearest'],
      }),
    } as any;
    const service = new AssignmentService({
      fleet,
      config: {
        fleet: { maxStaleLocationMinutes: 10, maxAmbulances: 50, defaultAverageSpeedKmh: 40, trafficFactor: 1.25 },
        assignment: { timeoutMs: 5000, maxRetries: 3, minConfidenceScore: 0.3, enableManualOverride: true },
        dispatch: { timeoutMs: 5000, requireValidLocation: true },
        simulation: { enabled: false, updateIntervalMs: 2000 },
      } as any,
    });
    const result = await service.selectAndAssign({
      emergencyId: 'EMG-1',
      latitude: 0,
      longitude: 0,
    });
    expect(result.ambulanceId).toBe('AMB-1');
    expect(result.consideredCandidates).toBe(1);
  });
});
