import { describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '@resus/core';
import { AssignmentService } from '../src/assignment/assignmentService.js';

describe('AssignmentService', () => {
  it('selects nearest available ambulance', async () => {
    const fleet = {
      expireDueOffers: vi.fn().mockResolvedValue(0),
      getAssignmentsForEmergency: vi.fn().mockResolvedValue([]),
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
        ambulanceId: 'AMB-1',
        estimatedResponseTimeMin: 10,
        distanceKm: 5.2,
        score: 0.8,
        consideredCandidates: 1,
        matchingFactors: ['nearest'],
        offeredAt: '2026-10-27T12:00:00.000Z',
        expiresAt: '2026-10-27T12:01:00.000Z',
      }),
    } as any;
    const service = new AssignmentService({
      fleet,
      config: {
        fleet: { maxStaleLocationMinutes: 10, maxAmbulances: 50, defaultAverageSpeedKmh: 40, trafficFactor: 1.25 },
        assignment: { timeoutMs: 5000, offerTtlMs: 60000, maxRetries: 3, minConfidenceScore: 0.3, enableManualOverride: true },
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
    expect(result.expiresAt).toBe('2026-10-27T12:01:00.000Z');
  });

  it('rejects a repeated assignment when the emergency already has an active assignment', async () => {
    const fleet = {
      expireDueOffers: vi.fn().mockResolvedValue(0),
      getAssignmentsForEmergency: vi.fn().mockResolvedValue([{ id: 'ASG-1', status: 'ASSIGNED' }]),
      findNearestAmbulances: vi.fn(),
      assignAmbulance: vi.fn(),
    } as any;
    const service = new AssignmentService({ fleet, config: { fleet: {}, assignment: {} } as any });
    await expect(service.selectAndAssign({ emergencyId: 'EMG-1', latitude: 1, longitude: 1 })).rejects.toMatchObject({ statusCode: 409 });
    expect(fleet.findNearestAmbulances).not.toHaveBeenCalled();
    expect(fleet.assignAmbulance).not.toHaveBeenCalled();
  });

  it('returns the current pending offer for a duplicate assignment request', async () => {
    const fleet = {
      expireDueOffers: vi.fn().mockResolvedValue(0),
      getAssignmentsForEmergency: vi.fn().mockResolvedValue([{ id: 'ASG-1', status: 'OFFERED' }]),
      findNearestAmbulances: vi.fn(),
      assignAmbulance: vi.fn(),
    } as any;
    const service = new AssignmentService({ fleet, config: { fleet: {}, assignment: {} } as any });
    await expect(service.selectAndAssign({ emergencyId: 'EMG-1', latitude: 1, longitude: 1 })).resolves.toMatchObject({ assignmentId: 'ASG-1' });
    expect(fleet.findNearestAmbulances).not.toHaveBeenCalled();
    expect(fleet.assignAmbulance).not.toHaveBeenCalled();
  });

  it('excludes vehicles that previously declined or expired this emergency from reassignment', async () => {
    const fleet = {
      expireDueOffers: vi.fn().mockResolvedValue(0),
      getAssignmentsForEmergency: vi.fn().mockResolvedValue([
        { id: 'ASG-OLD', status: 'DECLINED', ambulanceId: 'AMB-OLD' },
        { id: 'ASG-EXPIRED', status: 'EXPIRED', ambulanceId: 'AMB-EXPIRED' },
      ]),
      findNearestAmbulances: vi.fn().mockResolvedValue([{
        ambulance: { id: 'AMB-NEW', vehicleNumber: 'NEW', status: 'AVAILABLE' },
        distanceKm: 1,
        isStale: false,
        location: { latitude: 1, longitude: 1, recordedAt: new Date().toISOString() },
      }]),
      assignAmbulance: vi.fn().mockResolvedValue({
        id: 'ASG-NEW', ambulanceId: 'AMB-NEW', estimatedResponseTimeMin: 2,
        distanceKm: 1, score: 0.9, consideredCandidates: 1, matchingFactors: [],
        offeredAt: '2026-10-27T12:00:00.000Z', expiresAt: '2026-10-27T12:01:00.000Z',
      }),
    } as any;
    const service = new AssignmentService({
      fleet,
      config: { fleet: { defaultAverageSpeedKmh: 40, trafficFactor: 1 }, assignment: { offerTtlMs: 60_000, minConfidenceScore: 0.3 } } as any,
    });

    await service.selectAndAssign({ emergencyId: 'EMG-1', latitude: 1, longitude: 1 });

    expect(fleet.findNearestAmbulances).toHaveBeenCalledWith(expect.objectContaining({
      excludeIds: ['AMB-OLD', 'AMB-EXPIRED'],
    }));
    expect(fleet.assignAmbulance).toHaveBeenCalledWith(expect.objectContaining({ ambulanceId: 'AMB-NEW' }));
  });

  it('returns an explicit conflict when no eligible ambulance remains', async () => {
    const fleet = {
      expireDueOffers: vi.fn().mockResolvedValue(0),
      getAssignmentsForEmergency: vi.fn().mockResolvedValue([{ id: 'ASG-1', status: 'EXPIRED', ambulanceId: 'AMB-1' }]),
      findNearestAmbulances: vi.fn().mockResolvedValue([]),
      assignAmbulance: vi.fn(),
    } as any;
    const service = new AssignmentService({ fleet, config: { fleet: {}, assignment: {} } as any });

    await expect(service.selectAndAssign({ emergencyId: 'EMG-1', latitude: 1, longitude: 1 }))
      .rejects.toMatchObject({ code: ErrorCode.AMBULANCE_NOT_AVAILABLE, statusCode: 409 });
    expect(fleet.assignAmbulance).not.toHaveBeenCalled();
  });
});
