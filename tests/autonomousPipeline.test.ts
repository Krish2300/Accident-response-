import { describe, expect, it, vi } from 'vitest';
import { classifyTranscript } from '../apps/server/src/orchestrator/triageClassifier.js';
import { AutonomousOrchestrator, loadAutonomousConfig, pointAlong } from '../apps/server/src/orchestrator/autonomousOrchestrator.js';
import { WebCallService } from '../apps/server/src/webcall/webCallService.js';
import { requiredEquipmentFor } from '../modules/module_06_ambulance_management/src/assignment/assignmentService.js';

describe('rule triage (Module 3 offline fallback)', () => {
  it.each([
    ['My father collapsed and is not breathing', 'CARDIAC_ARREST', 'CRITICAL'],
    ['she is choking on food', 'CHOKING', 'CRITICAL'],
    ['there is a lot of blood from his leg', 'SEVERE_BLEEDING', 'CRITICAL'],
    ['bike accident on the highway', 'TRAUMA', 'HIGH'],
    ['he has chest pain and is sweating', 'CHEST_PAIN', 'HIGH'],
    ['my son is having a seizure', 'SEIZURE', 'HIGH'],
    ['her face is drooping and speech is slurred', 'STROKE', 'CRITICAL'],
    ['he took too many pills', 'OVERDOSE', 'HIGH'],
    ['അച്ഛന് ബോധമില്ല', 'UNCONSCIOUS', 'CRITICAL'],
  ])('%s -> %s', (text, incidentType, severity) => {
    const result = classifyTranscript(text);
    expect(result.incidentType).toBe(incidentType);
    expect(result.severity).toBe(severity);
    expect(result.matched.length).toBeGreaterThan(0);
  });

  it('never under-triages an unknown call', () => {
    expect(classifyTranscript('please send someone quickly')).toMatchObject({ incidentType: 'OTHER', severity: 'HIGH' });
  });
});

describe('Module 6 equipment preference', () => {
  it('asks for a defibrillator for cardiac arrest and nothing for unknown incidents', () => {
    expect(requiredEquipmentFor('CARDIAC_ARREST')).toEqual(['DEFIBRILLATOR']);
    expect(requiredEquipmentFor('OTHER')).toEqual([]);
    expect(requiredEquipmentFor(null)).toEqual([]);
  });
});

describe('Module 10 autonomous orchestrator', () => {
  it('is off unless explicitly enabled', () => {
    expect(loadAutonomousConfig({}).enabled).toBe(false);
    expect(loadAutonomousConfig({ MODULE10_AUTONOMOUS_ENABLED: 'true' }).enabled).toBe(true);
  });

  it('interpolates along a route polyline', () => {
    const path: Array<[number, number]> = [[0, 0], [0, 1], [1, 1]];
    expect(pointAlong(path, 0).point).toEqual([0, 0]);
    expect(pointAlong(path, 1).point[0]).toBeCloseTo(1);
    const mid = pointAlong(path, 0.5).point;
    expect(mid[0]).toBeCloseTo(0, 2);
    expect(mid[1]).toBeCloseTo(1, 2);
  });

  it('keeps a rule hit on a life threat when the LLM answers OTHER', async () => {
    const orchestrator = new AutonomousOrchestrator({
      config: loadAutonomousConfig({}),
      llm: { resolve: async () => ({ degraded: false, service: { providerName: 'ollama', classify: async () => ({ incident_type: 'OTHER', severity: 'LOW', confidence: 0.4 }) } }) },
    } as never);
    const result = await orchestrator.classify('he is not breathing');
    expect(result).toMatchObject({ incidentType: 'CARDIAC_ARREST', source: 'RULE' });
  });

  it('accepts an offer only for a crew without a driver account, then dispatches', async () => {
    const handlers = new Map<string, (event: unknown) => Promise<void> | void>();
    const accept = vi.fn(async () => ({}));
    const dispatch = vi.fn(async () => undefined);
    const driverOf = vi.fn(async (id: string) => (id === 'AMB-STAFFED' ? 'USR-1' : null));
    const orchestrator = new AutonomousOrchestrator({
      bus: { subscribe: (types: string[], handler: (event: unknown) => void) => { for (const t of types) handlers.set(t, handler); return () => undefined; }, publish: () => undefined },
      ambulances: { acceptForUnstaffedCrew: accept, assignedDriverIdOf: driverOf, list: async () => [] },
      fleet: { dispatchAmbulance: dispatch, recordLocation: vi.fn() },
      emergencies: { findById: async () => null },
      config: { ...loadAutonomousConfig({ MODULE10_AUTONOMOUS_ENABLED: 'true' }), simulateMovement: false },
    } as never);
    orchestrator.start();
    handlers.get('AMBULANCE_ASSIGNMENT_OFFERED')!({ type: 'AMBULANCE_ASSIGNMENT_OFFERED', payload: { assignmentId: 'ASG-1', ambulanceId: 'AMB-1' } });
    handlers.get('AMBULANCE_ASSIGNMENT_OFFERED')!({ type: 'AMBULANCE_ASSIGNMENT_OFFERED', payload: { assignmentId: 'ASG-2', ambulanceId: 'AMB-STAFFED' } });
    handlers.get('AMBULANCE_ASSIGNMENT_ACCEPTED')!({ type: 'AMBULANCE_ASSIGNMENT_ACCEPTED', payload: { ambulanceId: 'AMB-1', emergencyId: 'EMG-1' } });
    await orchestrator.idle();
    expect(accept).toHaveBeenCalledTimes(1);
    expect(accept).toHaveBeenCalledWith({ assignmentId: 'ASG-1', actorId: 'MODULE_10' });
    expect(dispatch).toHaveBeenCalledWith('AMB-1', 'EMG-1', null);
    await orchestrator.dispose();
  });
});

describe('Web Call service', () => {
  function service() {
    return new WebCallService({
      orchestrator: { enabled: false, classify: async () => ({ incidentType: 'OTHER', severity: 'HIGH', confidence: 0.3, source: 'RULE', provider: 'rule-triage', matched: [] }) },
      recognition: { isLive: false },
      synthesis: { isLive: false },
      defaultLocation: { latitude: 1, longitude: 2 },
    } as never);
  }

  it('falls back to the service-area location without browser GPS', () => {
    expect(service().start({}).locationSource).toBe('DEFAULT_SERVICE_AREA');
    expect(service().start({ latitude: 10, longitude: 20 }).locationSource).toBe('BROWSER_GPS');
  });

  it('refuses a call id with the wrong token', async () => {
    const calls = service();
    const { callId } = calls.start({});
    await expect(calls.status(callId, 'wrong-token')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('reports server speech recognition as unconfigured on loopback', async () => {
    const calls = service();
    const { callId, token } = calls.start({});
    await expect(calls.audio(callId, token, new Uint8Array([1]))).rejects.toMatchObject({ statusCode: 503 });
  });
});
