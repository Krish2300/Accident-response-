import { describe, expect, it, vi } from 'vitest';
import type { SystemEventRecord, SystemEventType } from '@resus/core';
import { mapLifecycleEvent } from '../src/lifecycle/mapper';
import { reduceLifecycleProjection } from '../src/lifecycle/reducer';

function record(
  type: SystemEventType,
  payload: Record<string, unknown>,
  overrides: Partial<SystemEventRecord> = {},
): SystemEventRecord {
  return {
    id: `EVT-${type}`,
    sequence: 1,
    type,
    emergencyId: 'EMG-canonical',
    entityType: 'EMERGENCY',
    entityId: 'EMG-canonical',
    timestamp: '2026-10-17T10:00:00.000Z',
    actorType: 'SYSTEM',
    actorId: null,
    payload,
    metadata: null,
    ...overrides,
  };
}

describe('Module 10 lifecycle projection mapper and reducer', () => {
  it('maps emergency creation as a starting observation', () => {
    const event = record('EMERGENCY_CREATED', {
      incidentType: 'TRAUMA', severity: 'HIGH', latitude: 10, longitude: 20,
      isSimulation: true,
    });
    const result = reduceLifecycleProjection(undefined, event);
    expect(result?.state).toBe('EMERGENCY_CREATED');
    expect(result?.facts.emergencyCreated).toMatchObject({ incidentType: 'TRAUMA', isSimulation: true });
  });

  it('keys projection by the canonical emergencyId and maps real CALL_CONNECTED', () => {
    const event = record('CALL_CONNECTED', {
      callSessionId: 'CALL-1', emergencyId: 'EMG-canonical', channel: 'SIP',
      provider: 'test', transport: 'test', isLiveTransport: false,
    });

    const result = reduceLifecycleProjection(undefined, event);

    expect(result?.emergencyId).toBe('EMG-canonical');
    expect(result?.state).toBe('CALL_CONNECTED');
    expect(result?.facts.callConnected).toMatchObject({ callSessionId: 'CALL-1', isLiveTransport: false });
    expect(result).not.toHaveProperty('incidentId');
  });

  it('ignores events without a valid canonical emergencyId and logs a structured warning', () => {
    const warn = vi.fn();
    const event = record('CALL_CONNECTED', { callSessionId: 'CALL-1', isLiveTransport: false }, { emergencyId: null });

    expect(mapLifecycleEvent(event, { warn })).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: event.id, eventType: event.type, sequence: event.sequence }),
      expect.stringContaining('without canonical emergencyId'),
    );
  });

  it('rejects a payload emergencyId that conflicts with the persisted canonical ID', () => {
    const event = record('CALL_CONNECTED', {
      callSessionId: 'CALL-1', emergencyId: 'EMG-other', isLiveTransport: false,
    });
    expect(mapLifecycleEvent(event)).toBeNull();
    expect(mapLifecycleEvent(record('CALL_CONNECTED', {
      callSessionId: 'CALL-1', channel: 'SIP', provider: 'test', transport: 'test', isLiveTransport: false,
    }))).toBeNull();
  });

  it('advances only for final transcripts and does not retain transcript text', () => {
    const partial = record('TRANSCRIPT_UPDATED', {
      transcriptId: 'TR-1', speaker: 'CALLER', text: 'partial secret', isFinal: false, sequence: 1,
    });
    const final = record('TRANSCRIPT_UPDATED', {
      transcriptId: 'TR-2', speaker: 'CALLER', text: 'final secret', isFinal: true, sequence: 2,
    }, { id: 'EVT-final', sequence: 2 });

    const connected = reduceLifecycleProjection(undefined, record('CALL_CONNECTED', {
      callSessionId: 'CALL-1', emergencyId: 'EMG-canonical', channel: 'SIP',
      provider: 'test', transport: 'test', isLiveTransport: false,
    }))!;
    expect(reduceLifecycleProjection(connected, partial)?.state).toBe('CALL_CONNECTED');
    const result = reduceLifecycleProjection(undefined, final);
    expect(result?.state).toBe('TRANSCRIPT_FINAL');
    expect(result?.facts.finalTranscript).toMatchObject({ transcriptId: 'TR-2', sequence: 2 });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('keeps NLP extraction separate from normalized classification', () => {
    const extraction = record('NLP_EXTRACTION_COMPLETED', {
      emergencyId: 'EMG-canonical',
      provider: 'model', model: 'v1', incidentType: 'CARDIAC', severity: 'P1',
      confidence: 0.91, latencyMs: 10, degraded: false,
    });
    const result = reduceLifecycleProjection(undefined, extraction);

    expect(result?.state).toBe('NO_LIFECYCLE_EVENT');
    expect(result?.facts.nlpExtraction?.event.eventId).toBe(extraction.id);
    expect(result?.facts.classification).toBeUndefined();
  });

  it('maps only EMERGENCY_CLASSIFIED to confirmed normalized classification', () => {
    const event = record('EMERGENCY_CLASSIFIED', {
      incidentType: 'CARDIAC_ARREST', severity: 'CRITICAL', confidence: 0.9, source: 'OPERATOR',
    });
    const result = reduceLifecycleProjection(undefined, event);
    expect(result?.state).toBe('CLASSIFICATION_CONFIRMED');
    expect(result?.facts.classification).toMatchObject({ incidentType: 'CARDIAC_ARREST', source: 'OPERATOR' });
  });

  it('keeps ambulance assignment distinct from dispatch', () => {
    const assigned = record('AMBULANCE_ASSIGNED', {
      ambulanceId: 'AMB-1', assignmentId: 'ASG-1', emergencyId: 'EMG-canonical',
      distanceKm: 2, estimatedResponseTimeMin: 5, matchingFactors: [], score: 1,
      source: 'MANUAL_OVERRIDE', consideredCandidates: 1,
    });
    const dispatched = record('AMBULANCE_DISPATCHED', {
      ambulanceId: 'AMB-1', emergencyId: 'EMG-canonical',
    }, { id: 'EVT-dispatched', sequence: 2 });

    const afterAssignment = reduceLifecycleProjection(undefined, assigned)!;
    expect(afterAssignment.state).toBe('AMBULANCE_ASSIGNED');
    expect(afterAssignment.facts.ambulanceDispatch).toBeUndefined();
    const afterDispatch = reduceLifecycleProjection(afterAssignment, dispatched)!;
    expect(afterDispatch.state).toBe('AMBULANCE_DISPATCHED');
    expect(afterDispatch.facts.ambulanceDispatch?.ambulanceId).toBe('AMB-1');
  });

  it('retains route traffic provenance and does not infer live traffic', () => {
    const event = record('ROUTE_GENERATED', {
      routeId: 'RTE-1', emergencyId: 'EMG-canonical', ambulanceId: 'AMB-1', hospitalId: null,
      distanceKm: 3, estimatedMinutes: 8, provider: 'deterministic', isLiveTraffic: false,
    });
    const result = reduceLifecycleProjection(undefined, event);
    expect(result?.facts.route).toMatchObject({ routeId: 'RTE-1', isLiveTraffic: false });
  });

  it('records hospital selection without inferring dispatch or arrival', () => {
    const event = record('HOSPITAL_SELECTED', {
      hospitalId: 'HSP-1', emergencyId: 'EMG-canonical', distanceKm: 4, reason: 'suitability',
    });
    const result = reduceLifecycleProjection(undefined, event);
    expect(result?.state).toBe('HOSPITAL_SELECTED');
    expect(result?.facts.hospitalSelection?.hospitalId).toBe('HSP-1');
    expect(result?.facts.ambulanceDispatch).toBeUndefined();
    expect(result?.facts.corridor).toBeUndefined();
  });

  it('marks missing route evidence for a corridor and makes no signal/simulation claim', () => {
    const event = record('CORRIDOR_ACTIVATED', {
      emergencyId: 'EMG-canonical', ambulanceId: 'AMB-1', hospitalId: 'HSP-1',
      from: 'A', to: 'B', estimatedMinutes: 8,
    });
    const result = reduceLifecycleProjection(undefined, event);
    expect(result?.state).toBe('CORRIDOR_ACTIVATED');
    expect(result?.anomalies).toEqual([{ code: 'MISSING_PREDECESSOR', eventId: event.id, missingFact: 'route' }]);
    expect(result?.facts.corridor).toMatchObject({
      simulationStatus: 'NOT_REPORTED_BY_EVENT', signalControlStatus: 'NOT_REPORTED_BY_EVENT',
    });
  });

  it('maps operator-reported arrival, onboarding, hospital arrival and operational completion', () => {
    const events = [
      record('AMBULANCE_ARRIVED_SCENE', {
        emergencyId: 'EMG-canonical', ambulanceId: 'AMB-1', responseTimeMin: 4,
        evidenceSource: 'OPERATOR_REPORTED', dataClassification: 'TEST', observedAt: '2026-10-17T10:10:00.000Z',
      }, { id: 'EVT-scene', sequence: 10, actorType: 'DISPATCHER', actorId: 'USR-1' }),
      record('PATIENT_ONBOARD', {
        emergencyId: 'EMG-canonical', ambulanceId: 'AMB-1', hospitalId: 'HSP-1',
        evidenceSource: 'OPERATOR_REPORTED', dataClassification: 'TEST', observedAt: '2026-10-17T10:15:00.000Z',
      }, { id: 'EVT-onboard', sequence: 11, actorType: 'DISPATCHER', actorId: 'USR-1' }),
      record('AMBULANCE_ARRIVED_HOSPITAL', {
        emergencyId: 'EMG-canonical', ambulanceId: 'AMB-1', hospitalId: 'HSP-1',
        evidenceSource: 'OPERATOR_REPORTED', dataClassification: 'TEST', observedAt: '2026-10-17T10:30:00.000Z',
      }, { id: 'EVT-hospital', sequence: 12, actorType: 'DISPATCHER', actorId: 'USR-1' }),
      record('EMERGENCY_COMPLETED', {
        emergencyId: 'EMG-canonical', status: 'COMPLETED', totalDurationMin: 35, isSimulation: true,
        evidenceSource: 'OPERATOR_REPORTED', dataClassification: 'TEST', observedAt: '2026-10-17T10:35:00.000Z',
      }, { id: 'EVT-complete', sequence: 13, actorType: 'DISPATCHER', actorId: 'USR-1' }),
    ];

    let projection = undefined as ReturnType<typeof reduceLifecycleProjection>;
    for (const event of events) projection = reduceLifecycleProjection(projection, event);

    expect(projection?.state).toBe('OPERATIONAL_COMPLETION_RECORDED');
    expect(projection?.facts.sceneArrival).toMatchObject({ ambulanceId: 'AMB-1', evidenceSource: 'OPERATOR_REPORTED', responseTimeMin: 4 });
    expect(projection?.facts.patientOnboard).toMatchObject({ hospitalId: 'HSP-1', evidenceSource: 'OPERATOR_REPORTED' });
    expect(projection?.facts.hospitalArrival?.hospitalId).toBe('HSP-1');
    expect(projection?.facts.operationalCompletion).toMatchObject({ status: 'COMPLETED', isSimulation: true });
    expect(JSON.stringify(projection)).not.toMatch(/survival|stabilized|handover/i);
  });

  it('ignores milestones without explicit operator provenance and records missing-predecessor anomalies', () => {
    const unsupported = record('PATIENT_ONBOARD', {
      emergencyId: 'EMG-canonical', ambulanceId: 'AMB-1', hospitalId: null,
      observedAt: '2026-10-17T10:15:00.000Z',
    });
    expect(mapLifecycleEvent(unsupported)).toBeNull();
    const reported = record('PATIENT_ONBOARD', {
      emergencyId: 'EMG-canonical', ambulanceId: 'AMB-1', hospitalId: null,
      evidenceSource: 'OPERATOR_REPORTED', dataClassification: 'TEST', observedAt: '2026-10-17T10:15:00.000Z',
    });
    expect(reduceLifecycleProjection(undefined, reported)?.anomalies).toEqual([
      { code: 'MISSING_PREDECESSOR', eventId: reported.id, missingFact: 'sceneArrival' },
    ]);
  });

  it('deduplicates by event ID and applies late facts without state regression', () => {
    const route = record('ROUTE_GENERATED', {
      routeId: 'RTE-1', emergencyId: 'EMG-canonical', ambulanceId: 'AMB-1', hospitalId: null,
      distanceKm: 3, estimatedMinutes: 8, provider: 'deterministic', isLiveTraffic: false,
    }, { id: 'EVT-route', sequence: 20 });
    const duplicate = {
      ...route,
      payload: { ...(route.payload as Record<string, unknown>), routeId: 'RTE-duplicate' },
    };
    const lateAssignment = record('AMBULANCE_ASSIGNED', {
      ambulanceId: 'AMB-1', assignmentId: 'ASG-1', emergencyId: 'EMG-canonical',
      distanceKm: 2, estimatedResponseTimeMin: 5, matchingFactors: [], score: 1,
      source: 'AUTOMATIC', consideredCandidates: 1,
    }, { id: 'EVT-assigned', sequence: 10 });

    const first = reduceLifecycleProjection(undefined, route)!;
    expect(reduceLifecycleProjection(first, duplicate)).toBe(first);
    const afterLate = reduceLifecycleProjection(first, lateAssignment)!;
    expect(afterLate.state).toBe('ROUTE_GENERATED');
    expect(afterLate.facts.ambulanceAssignment?.assignmentId).toBe('ASG-1');
    expect(afterLate.lastSequence).toBe(20);
  });

  it('does not map unsupported cancellation or failure into lifecycle states', () => {
    const unsupported = [
      record('CALL_FAILED', { emergencyId: 'EMG-canonical', provider: 'test', reason: 'failure' }),
      record('PROTOCOL_ESCALATED', { protocolSessionId: 'PS-1', reason: 'protocol rule', rules: ['rule-1'] }),
    ];

    for (const event of unsupported) {
      expect(mapLifecycleEvent(event)).toBeNull();
      expect(reduceLifecycleProjection(undefined, event)).toBeUndefined();
    }
  });
});
