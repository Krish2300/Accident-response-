import { describe, expect, it, vi } from 'vitest';
import { AmbulanceRepository } from '../src/repositories/ambulanceRepository.js';

function harness(assignedDriverId = 'DRIVER-1', initialStatus = 'ASSIGNED') {
  let status = initialStatus;
  let ambulanceStatus = 'ASSIGNED';
  const eventRows: Array<{ type: string; payload: unknown; actorId?: string | null }> = [];
  const current = () => ({
    id: 'ASG-1', emergencyId: 'EMG-1', ambulanceId: 'AMB-1', status,
    source: 'MANUAL_OVERRIDE', distanceKm: 1, estimatedResponseTimeMin: 2, score: 1,
    matchingFactorsJson: '[]', rejectedReasonsJson: '{}', overrideReason: null,
    decidedByUserId: 'OP-1', decidedAt: new Date('2026-01-01T00:00:00Z'), createdAt: new Date('2026-01-01T00:00:00Z'),
    offeredAt: null, expiresAt: null, consideredCandidates: 1,
  });
  const tx = {
    ambulanceAssignment: {
      findFirst: vi.fn(async ({ where }: { where: { status: { in?: string[]; equals?: string } } }) => {
        const allowed = where.status.in ?? (where.status.equals ? [where.status.equals] : []);
        return allowed.includes(status) ? current() : null;
      }),
      findUnique: vi.fn(async () => ({ ...current(), ambulance: { id: 'AMB-1', status: 'ASSIGNED', assignedDriverId } })),
      updateMany: vi.fn(async ({ data }: { data: { status: string } }) => { status = data.status; return { count: 1 }; }),
      findUniqueOrThrow: vi.fn(async () => current()),
    },
    ambulance: {
      findUnique: vi.fn(async () => ({ id: 'AMB-1', status: ambulanceStatus })),
      update: vi.fn(async ({ data }: { data: { status?: string } }) => { if (data.status) ambulanceStatus = data.status; return {}; }),
    },
    emergency: { updateMany: vi.fn(async () => ({ count: 1 })) },
  };
  const db = { ambulanceAssignment: { findMany: vi.fn(async () => []) }, $transaction: vi.fn(async (callback: (value: unknown) => Promise<unknown>) => callback(tx)) };
  const events = { recordInTransaction: vi.fn(async (_tx: unknown, event: { type: string; payload: unknown; actorId?: string | null }) => { eventRows.push(event); return {}; }) };
  return { repository: new AmbulanceRepository(db as never, events as never), tx, eventRows };
}

describe('Module 11 driver assignment decision persistence contract', () => {
  it('creates assignment state and assignment events in one transaction without a dispatch event', async () => {
    let insideTransaction = false;
    const row = {
      id: 'ASG-1', emergencyId: 'EMG-1', ambulanceId: 'AMB-1', status: 'OFFERED', source: 'MANUAL_OVERRIDE',
      distanceKm: 1, estimatedResponseTimeMin: 2, score: 1, matchingFactorsJson: '[]', rejectedReasonsJson: '{}',
      overrideReason: null, decidedByUserId: 'OP-1', decidedAt: new Date(), createdAt: new Date(), offeredAt: new Date(), expiresAt: new Date(Date.now() + 60000), consideredCandidates: 1,
    };
    const tx = {
      ambulanceAssignment: { findFirst: vi.fn(async () => null), create: vi.fn(async () => row) },
      ambulance: { findUnique: vi.fn(async () => ({ id: 'AMB-1', status: 'AVAILABLE' })), update: vi.fn(async () => ({})) },
      emergency: { findUniqueOrThrow: vi.fn(async () => ({ isSimulation: true })), update: vi.fn(async () => ({})) },
    };
    const db = { $transaction: vi.fn(async (callback: (value: unknown) => Promise<unknown>) => {
      insideTransaction = true;
      try { return await callback(tx); } finally { insideTransaction = false; }
    }) };
    const events = { recordInTransaction: vi.fn(async (_tx: unknown, event: { type: string; payload: unknown }) => {
      expect(insideTransaction).toBe(true);
      return event;
    }) };
    const repository = new AmbulanceRepository(db as never, events as never);
    const result = await repository.createAssignment({
      emergencyId: 'EMG-1', ambulanceId: 'AMB-1', source: 'MANUAL_OVERRIDE', distanceKm: 1,
      estimatedResponseTimeMin: 2, score: 1, matchingFactors: [], rejectedReasons: {}, consideredCandidates: 1,
      decidedByUserId: 'OP-1',
    });
    expect(result.status).toBe('OFFERED');
    expect(tx.ambulanceAssignment.create).toHaveBeenCalled();
    expect(tx.ambulance.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'ASSIGNED', currentEmergencyId: 'EMG-1' }) }));
    expect(tx.emergency.update).toHaveBeenCalledWith({ where: { id: 'EMG-1' }, data: { assignedAmbulanceId: 'AMB-1' } });
    expect(events.recordInTransaction.mock.calls.map((call) => (call[1] as { type: string }).type)).toEqual(['AMBULANCE_ASSIGNMENT_REQUESTED', 'AMBULANCE_ASSIGNMENT_OFFERED', 'AMBULANCE_ASSIGNED']);
  });

  it.each(['DECLINED', 'EXPIRED', 'CANCELLED'])(
    'transactionally rejects reuse of the same ambulance after %s for the same emergency',
    async (previousStatus) => {
      const tx = {
        ambulanceAssignment: {
          findFirst: vi.fn(async ({ where }: { where: { ambulanceId?: string; status?: { in?: string[] } } }) =>
            where.ambulanceId && where.status?.in?.includes(previousStatus)
              ? { id: 'ASG-OLD', status: previousStatus }
              : null),
          create: vi.fn(),
        },
        ambulance: { findUnique: vi.fn(), update: vi.fn() },
        emergency: { update: vi.fn(), findUniqueOrThrow: vi.fn() },
      };
      const db = { $transaction: vi.fn(async (callback: (value: unknown) => Promise<unknown>) => callback(tx)) };
      const events = { recordInTransaction: vi.fn() };
      const repository = new AmbulanceRepository(db as never, events as never);

      await expect(repository.createAssignment({
        emergencyId: 'EMG-1', ambulanceId: 'AMB-1', source: 'AUTOMATIC', distanceKm: 1,
        estimatedResponseTimeMin: 2, score: 1, matchingFactors: [], rejectedReasons: {}, consideredCandidates: 1,
      })).rejects.toMatchObject({ statusCode: 409 });
      expect(tx.ambulanceAssignment.findFirst).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ emergencyId: 'EMG-1', ambulanceId: 'AMB-1', status: { in: ['DECLINED', 'EXPIRED', 'CANCELLED'] } }),
      }));
      expect(tx.ambulanceAssignment.create).not.toHaveBeenCalled();
      expect(tx.ambulance.update).not.toHaveBeenCalled();
      expect(tx.emergency.update).not.toHaveBeenCalled();
      expect(events.recordInTransaction).not.toHaveBeenCalled();
    },
  );

  it('accepts only the assigned driver and writes an acceptance event without dispatch', async () => {
    const { repository, tx, eventRows } = harness();
    const assignment = await repository.respondToAssignment({ assignmentId: 'ASG-1', driverId: 'DRIVER-1', decision: 'ACCEPT' });
    expect(assignment.status).toBe('ACCEPTED');
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0]).toMatchObject({ type: 'AMBULANCE_ASSIGNMENT_ACCEPTED', payload: { assignmentId: 'ASG-1', ambulanceId: 'AMB-1', emergencyId: 'EMG-1', acceptedAt: expect.any(String) }, actorId: 'DRIVER-1' });
    expect(tx.ambulance.update).not.toHaveBeenCalled();
    expect(eventRows.map((event) => event.type)).not.toContain('AMBULANCE_DISPATCHED');
  });

  it('does not duplicate an already-recorded same-driver decision on retry', async () => {
    const accepted = harness('DRIVER-1', 'ACCEPTED');
    const result = await accepted.repository.respondToAssignment({ assignmentId: 'ASG-1', driverId: 'DRIVER-1', decision: 'ACCEPT' });
    expect(result.status).toBe('ACCEPTED');
    expect(accepted.tx.ambulanceAssignment.updateMany).not.toHaveBeenCalled();
    expect(accepted.eventRows).toHaveLength(0);
  });

  it('rejects foreign ownership and duplicate/conflicting decisions before writing events', async () => {
    const foreign = harness('DRIVER-OTHER');
    await expect(foreign.repository.respondToAssignment({ assignmentId: 'ASG-1', driverId: 'DRIVER-1', decision: 'ACCEPT' })).rejects.toMatchObject({ statusCode: 403 });
    expect(foreign.tx.ambulanceAssignment.updateMany).not.toHaveBeenCalled();
    expect(foreign.eventRows).toHaveLength(0);

    const alreadyAccepted = harness('DRIVER-1', 'ACCEPTED');
    await expect(alreadyAccepted.repository.respondToAssignment({ assignmentId: 'ASG-1', driverId: 'DRIVER-1', decision: 'DECLINE' })).rejects.toMatchObject({ statusCode: 409 });
    expect(alreadyAccepted.eventRows).toHaveLength(0);
  });

  it('records decline and releases only this assignment for explicit dispatcher reassignment', async () => {
    const { repository, tx, eventRows } = harness();
    const result = await repository.respondToAssignment({ assignmentId: 'ASG-1', driverId: 'DRIVER-1', decision: 'DECLINE', reason: 'crew unavailable' });
    expect(result.status).toBe('DECLINED');
    expect(tx.ambulance.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'AMB-1' }, data: expect.objectContaining({ status: 'AVAILABLE', currentEmergencyId: null }) }));
    expect(tx.emergency.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'EMG-1', assignedAmbulanceId: 'AMB-1' }, data: { assignedAmbulanceId: null } }));
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0]).toMatchObject({ type: 'AMBULANCE_ASSIGNMENT_DECLINED', actorId: 'DRIVER-1', payload: { reason: 'crew unavailable', declinedAt: expect.any(String) } });
    expect(eventRows.map((event) => event.type)).not.toContain('AMBULANCE_DISPATCHED');
  });

  it('marks the assignment dispatched and emits dispatch only through the explicit repository operation', async () => {
    const { repository, tx, eventRows } = harness();
    await repository.dispatchAssignment({ ambulanceId: 'AMB-1', emergencyId: 'EMG-1', dispatchedByUserId: 'DISPATCHER-1' });
    expect(tx.ambulanceAssignment.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'ASG-1', status: { in: ['ASSIGNED', 'ACCEPTED'] } }, data: { status: 'DISPATCHED' } }));
    expect(tx.ambulance.update).toHaveBeenCalledWith({ where: { id: 'AMB-1' }, data: { status: 'EN_ROUTE' } });
    expect(eventRows.map((event) => event.type)).toEqual(['AMBULANCE_DISPATCHED', 'AMBULANCE_STATUS_CHANGED']);
    expect(eventRows[0]).toMatchObject({ actorId: 'DISPATCHER-1', payload: { ambulanceId: 'AMB-1', emergencyId: 'EMG-1' } });
  });
});
