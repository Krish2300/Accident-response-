import { describe, expect, it, vi } from 'vitest';
import { FleetService } from '../src/fleetService.js';

function buildFleet() {
  const records: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const updates: Array<Record<string, unknown>> = [];
  const ambulances = {
    requireById: vi.fn(async (id: string) => ({ id, status: 'AVAILABLE' })),
    activeAssignmentFor: vi.fn(async () => null),
    createAssignment: vi.fn(async () => ({
      id: 'ASG-1',
      emergencyId: 'EMG-1',
      ambulanceId: 'AMB-1',
      status: 'ASSIGNED',
      source: 'MANUAL_OVERRIDE',
      distanceKm: 2,
      estimatedResponseTimeMin: 3,
      score: 1,
      matchingFactors: ['manual'],
      rejectedReasons: {},
      overrideReason: null,
      consideredCandidates: 1,
      decidedByUserId: null,
      assignedAt: new Date().toISOString(),
      dispatchedAt: null,
      completedAt: null,
    })),
    update: vi.fn(async (_id: string, patch: Record<string, unknown>) => {
      updates.push(patch);
      return { id: _id, status: patch.status };
    }),
  };
  const events = {
    record: vi.fn(async (event: { type: string; payload?: Record<string, unknown> }) => {
      records.push(event);
      return {};
    }),
  };
  const fleet = new FleetService({
    ambulances: ambulances as never,
    events: events as never,
    config: { fleet: {}, assignment: {}, dispatch: {}, simulation: {} } as never,
  });
  return { fleet, records, updates, ambulances };
}

describe('Module 6 assignment and dispatch separation', () => {
  it.each(['DISPATCHED', 'EN_ROUTE'])('rejects status %s through general register/update APIs', async (status) => {
    const { fleet } = buildFleet();
    await expect(fleet.registerAmbulance({ vehicleNumber: 'AMB-1', status })).rejects.toThrow(
      'only be set through the explicit dispatch operation',
    );
    await expect(fleet.updateAmbulance('AMB-1', { status })).rejects.toThrow(
      'only be set through the explicit dispatch operation',
    );
  });

  it('records assignment without marking or emitting a dispatch', async () => {
    const { fleet, records, updates, ambulances } = buildFleet();

    const assignment = await fleet.assignAmbulance({
      emergencyId: 'EMG-1',
      ambulanceId: 'AMB-1',
      distanceKm: 2,
      estimatedResponseTimeMin: 3,
      score: 1,
      matchingFactors: ['manual'],
      rejectedReasons: {},
      source: 'MANUAL_OVERRIDE',
      consideredCandidates: 1,
    });

    expect(assignment.status).toBe('ASSIGNED');
    expect(ambulances.createAssignment).toHaveBeenCalledTimes(1);
    // The repository owns the atomic assignment + event write. FleetService
    // must not repeat those writes or claim a dispatch occurred.
    expect(updates).not.toContainEqual(expect.objectContaining({ status: 'ASSIGNED' }));
    expect(records.map((event) => event.type)).not.toContain('AMBULANCE_DISPATCHED');
  });

  it('emits dispatch and moves the ambulance en route only through explicit dispatch', async () => {
    const { fleet, records, updates } = buildFleet();

    await fleet.dispatchAmbulance('AMB-1', 'EMG-1');

    expect(updates).toContainEqual(expect.objectContaining({ status: 'EN_ROUTE' }));
    expect(records.map((event) => event.type)).toContain('AMBULANCE_DISPATCHED');
    expect(records.map((event) => event.type)).toContain('AMBULANCE_STATUS_CHANGED');
  });
});
