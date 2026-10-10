import { describe, expect, it, vi } from 'vitest';
import { FleetService } from '../src/fleetService.js';

describe('FleetService', () => {
  it('creates ambulance registration', async () => {
    const ambulances = {
      create: vi.fn().mockResolvedValue({ id: 'AMB-1', vehicleNumber: 'AMB001', status: 'AVAILABLE', isSimulation: false }),
      list: vi.fn(),
      requireById: vi.fn(),
      update: vi.fn(),
      appendLocation: vi.fn(),
      latestLocation: vi.fn(),
      locationTrail: vi.fn(),
      createAssignment: vi.fn(),
      assignmentsForEmergency: vi.fn(),
      activeAssignmentFor: vi.fn(),
      releaseAssignments: vi.fn(),
      utilization: vi.fn(),
    } as any;
    const events = {
      record: vi.fn(),
    } as any;
    const fleet = new FleetService({ ambulances, events, config: { fleet: { maxStaleLocationMinutes: 10, maxAmbulances: 50, defaultAverageSpeedKmh: 40, trafficFactor: 1.25 }, assignment: {} as any, dispatch: {} as any, simulation: {} as any } as any });
    const result = await fleet.registerAmbulance({ vehicleNumber: 'AMB001' });
    expect(result.vehicleNumber).toBe('AMB001');
    expect(events.record).toHaveBeenCalled();
  });
});
