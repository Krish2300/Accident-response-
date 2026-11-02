/**
 * Module 10 – Unit Tests
 * Tests FSM transitions, guards, and priority scoring.
 */

import {
  EmergencyStateMachine,
} from '../src/state/machine';
import { describe, expect, it } from 'vitest';
import {
  IncidentState,
  IncidentType,
  IncidentSeverity,
  TransitionTrigger,
  CallerInfo,
  GeoLocation,
  PatientInfo,
} from '../src/types';
import { computePriority } from '../src/state/transitions';

// ─────────────────────────────────────────────
// TEST FIXTURES
// ─────────────────────────────────────────────

const TEST_CALLER: CallerInfo = {
  callSessionId: 'test-session-001',
  language:      'en-IN',
  channel:       'WEBRTC',
};

const TEST_LOCATION: GeoLocation = {
  latitude:  9.9312,
  longitude: 76.2673,
  address:   'MG Road, Kochi, Kerala',
};

const TEST_PATIENT: PatientInfo = {
  consciousnessLevel: 'UNCONSCIOUS',
  breathingNormally:  false,
};

const STATE_ORDER = [
  IncidentState.NEW,
  IncidentState.CALL_ACTIVE,
  IncidentState.ANALYZING,
  IncidentState.CLASSIFIED,
  IncidentState.RESPONSE_INITIATED,
  IncidentState.AMBULANCE_ASSIGNED,
  IncidentState.ROUTE_GENERATED,
  IncidentState.CORRIDOR_ACTIVE,
  IncidentState.HOSPITAL_ARRIVAL,
  IncidentState.COMPLETED,
];

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function createFSM() {
  return new EmergencyStateMachine(TEST_CALLER);
}

async function advanceTo(
  fsm: EmergencyStateMachine,
  target: IncidentState,
): Promise<void> {
  // Helper to walk through happy path
  const targetIndex = STATE_ORDER.indexOf(target);
  if (targetIndex >= STATE_ORDER.indexOf(IncidentState.CALL_ACTIVE)) {
    await fsm.send(TransitionTrigger.CALL_RECEIVED, 'MODULE_1');
  }
  if (targetIndex >= STATE_ORDER.indexOf(IncidentState.ANALYZING)) {
    await fsm.send(TransitionTrigger.SPEECH_TRANSCRIBED, 'MODULE_2');
  }
  if (targetIndex >= STATE_ORDER.indexOf(IncidentState.CLASSIFIED)) {
    fsm.applyNLPClassification({
      incidentType: IncidentType.CARDIAC_ARREST,
      severity:     IncidentSeverity.CRITICAL,
      confidence:   0.95,
      location:     TEST_LOCATION,
      patient:      TEST_PATIENT,
      transcript:   'My father collapsed',
    });
    await fsm.send(TransitionTrigger.NLP_CLASSIFICATION_DONE, 'MODULE_3');
  }
  if (targetIndex >= STATE_ORDER.indexOf(IncidentState.RESPONSE_INITIATED)) {
    await fsm.send(TransitionTrigger.RESPONSE_DECISION_MADE, 'MODULE_10');
  }
  if (targetIndex >= STATE_ORDER.indexOf(IncidentState.AMBULANCE_ASSIGNED)) {
    fsm.applyAmbulanceAssignment({
      ambulance: {
        ambulanceId: 'AMB01',
        unitCallSign: 'ALPHA-1',
        driverId: 'DRV42',
        etaMinutes: 4,
        location: TEST_LOCATION,
      },
    });
    await fsm.send(TransitionTrigger.AMBULANCE_DISPATCHED, 'MODULE_6');
  }
}

// ─────────────────────────────────────────────
// TESTS (using Jest / Vitest)
// ─────────────────────────────────────────────

describe('EmergencyStateMachine – happy path', () => {
  it('starts in NEW state', () => {
    const fsm = createFSM();
    expect(fsm.state).toBe(IncidentState.NEW);
    expect(fsm.snapshot.incidentId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    fsm.destroy();
  });

  it('transitions NEW → CALL_ACTIVE on CALL_RECEIVED', async () => {
    const fsm = createFSM();
    const ok = await fsm.send(TransitionTrigger.CALL_RECEIVED, 'MODULE_1');
    expect(ok).toBe(true);
    expect(fsm.state).toBe(IncidentState.CALL_ACTIVE);
    fsm.destroy();
  });

  it('walks full happy path to AMBULANCE_ASSIGNED', async () => {
    const fsm = createFSM();
    await advanceTo(fsm, IncidentState.AMBULANCE_ASSIGNED);
    expect(fsm.state).toBe(IncidentState.AMBULANCE_ASSIGNED);
    fsm.destroy();
  });

  it('reaches COMPLETED after all transitions', async () => {
    const fsm = createFSM();
    await advanceTo(fsm, IncidentState.AMBULANCE_ASSIGNED);

    // Route + corridor
    fsm.applyHospitalSelection({ hospital: { hospitalId: 'H1', hospitalName: 'City Hospital', distanceKm: 4.2, hasICU: true, specialty: ['cardiology'], bedsAvailable: 3 } });
    fsm.applyRouteInfo({ route: { routePolyline: 'encodedPoly', distanceKm: 4.2, etaMinutes: 8, provider: 'OSRM' } });
    await fsm.send(TransitionTrigger.ROUTE_CALCULATED, 'MODULE_8');
    expect(fsm.state).toBe(IncidentState.ROUTE_GENERATED);

    fsm.applyCorridorInfo({ corridor: { corridorId: 'COR1', geofencePolygon: [], affectedSignalIds: [], notifiedCount: 5, activatedAt: new Date().toISOString() } });
    await fsm.send(TransitionTrigger.CORRIDOR_ACTIVATED, 'MODULE_9');
    expect(fsm.state).toBe(IncidentState.CORRIDOR_ACTIVE);

    await fsm.send(TransitionTrigger.PATIENT_ARRIVED, 'MODULE_6');
    expect(fsm.state).toBe(IncidentState.HOSPITAL_ARRIVAL);

    await fsm.send(TransitionTrigger.INCIDENT_RESOLVED, 'MODULE_7');
    expect(fsm.state).toBe(IncidentState.COMPLETED);
    fsm.destroy();
  });
});

describe('EmergencyStateMachine – invalid transitions', () => {
  it('rejects unknown trigger in current state', async () => {
    const fsm = createFSM();
    const ok = await fsm.send(TransitionTrigger.AMBULANCE_DISPATCHED, 'MODULE_6');
    expect(ok).toBe(false);
    expect(fsm.state).toBe(IncidentState.NEW);
    fsm.destroy();
  });

  it('rejects transition if location guard fails (no location set)', async () => {
    const fsm = createFSM();
    await fsm.send(TransitionTrigger.CALL_RECEIVED, 'MODULE_1');
    await fsm.send(TransitionTrigger.SPEECH_TRANSCRIBED, 'MODULE_2');

    // Apply NLP but WITHOUT location
    fsm.applyNLPClassification({
      incidentType: IncidentType.CARDIAC_ARREST,
      severity:     IncidentSeverity.CRITICAL,
      confidence:   0.9,
      location:     null,             // ← no location
      patient:      TEST_PATIENT,
      transcript:   'test',
    });
    await fsm.send(TransitionTrigger.NLP_CLASSIFICATION_DONE, 'MODULE_3');

    // Should be CLASSIFIED, but RESPONSE_DECISION_MADE guard must block
    expect(fsm.state).toBe(IncidentState.CLASSIFIED);
    const ok = await fsm.send(TransitionTrigger.RESPONSE_DECISION_MADE, 'MODULE_10');
    expect(ok).toBe(false);
    fsm.destroy();
  });

  it('rejects low-confidence auto-dispatch', async () => {
    const fsm = createFSM();
    await fsm.send(TransitionTrigger.CALL_RECEIVED, 'MODULE_1');
    await fsm.send(TransitionTrigger.SPEECH_TRANSCRIBED, 'MODULE_2');
    fsm.applyNLPClassification({
      incidentType: IncidentType.UNKNOWN,
      severity:     IncidentSeverity.MEDIUM,
      confidence:   0.2,            // ← below 0.4 threshold
      location:     TEST_LOCATION,
      patient:      TEST_PATIENT,
      transcript:   'mumbled',
    });
    await fsm.send(TransitionTrigger.NLP_CLASSIFICATION_DONE, 'MODULE_3');
    const ok = await fsm.send(TransitionTrigger.RESPONSE_DECISION_MADE, 'MODULE_10');
    expect(ok).toBe(false);
    fsm.destroy();
  });
});

describe('EmergencyStateMachine – cancellation', () => {
  it('cancels from any non-terminal state', async () => {
    const fsm = createFSM();
    await advanceTo(fsm, IncidentState.AMBULANCE_ASSIGNED);
    await fsm.send(TransitionTrigger.CANCEL_INCIDENT, 'MODULE_10_OPERATOR');
    expect(fsm.state).toBe(IncidentState.CANCELLED);
    fsm.destroy();
  });
});

describe('Priority scoring', () => {
  it('assigns maximum priority to CRITICAL + unconscious + no breathing', () => {
    const fsm = createFSM();
    fsm.applyNLPClassification({
      incidentType: IncidentType.CARDIAC_ARREST,
      severity:     IncidentSeverity.CRITICAL,
      confidence:   1.0,
      location:     TEST_LOCATION,
      patient:      TEST_PATIENT,
      transcript:   '',
    });
    const ctx = fsm.snapshot;
    const priority = computePriority(ctx);
    expect(priority).toBeGreaterThan(100);
    fsm.destroy();
  });

  it('assigns lower priority to LOW severity + conscious', () => {
    const fsm = createFSM();
    fsm.applyNLPClassification({
      incidentType: IncidentType.GENERAL_MEDICAL,
      severity:     IncidentSeverity.LOW,
      confidence:   0.8,
      location:     TEST_LOCATION,
      patient:      { consciousnessLevel: 'CONSCIOUS', breathingNormally: true },
      transcript:   '',
    });
    const ctx = fsm.snapshot;
    const priority = computePriority(ctx);
    expect(priority).toBeLessThan(60);
    fsm.destroy();
  });
});

describe('StateChangeEvent format', () => {
  it('emits correct event on state change', async () => {
    const fsm = createFSM();
    const events: any[] = [];
    fsm.on('state:changed', (e) => events.push(e));
    await fsm.send(TransitionTrigger.CALL_RECEIVED, 'MODULE_1');

    expect(events).toHaveLength(1);
    expect(events[0].fromState).toBe(IncidentState.NEW);
    expect(events[0].toState).toBe(IncidentState.CALL_ACTIVE);
    expect(events[0].trigger).toBe(TransitionTrigger.CALL_RECEIVED);
    expect(events[0].actorModule).toBe('MODULE_1');
    expect(events[0].eventId).toBeDefined();
    expect(events[0].meta.durationMs).toBeGreaterThanOrEqual(0);
    fsm.destroy();
  });
});
