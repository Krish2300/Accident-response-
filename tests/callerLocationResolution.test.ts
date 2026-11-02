import { describe, expect, it, vi } from 'vitest';
import { CallerLocationResolutionService, UnconfiguredCallerLocationResolver } from '../apps/server/src/conversation/callerLocationResolution.js';

const candidateEvent = (payload: Record<string, unknown>) => ({
  id: 'LOC-test', sequence: 1, type: 'EMERGENCY_LOCATION_CANDIDATE' as const, emergencyId: 'EMG-test',
  entityType: 'emergency_location_resolution', entityId: 'LOC-test', timestamp: new Date().toISOString(),
  actorType: 'SYSTEM', actorId: null, payload, metadata: null,
});

function harness(resolver?: ConstructorParameters<typeof CallerLocationResolutionService>[0]['resolver'], timeoutMs = 50) {
  const emergencies = {
    recordCallerLocationCandidate: vi.fn(async (input: Record<string, unknown>) => candidateEvent({
      resolutionId: 'LOC-test', callerLocationText: input.locationText, provider: input.provider,
      outcome: input.outcome, confidence: input.confidence, candidateLatitude: input.latitude,
      candidateLongitude: input.longitude, attempt: input.attempt, isSimulation: true,
    })),
  };
  const service = new CallerLocationResolutionService({ emergencies: emergencies as never, resolver, timeoutMs });
  return { service, emergencies };
}

describe('caller location resolution boundary', () => {
  it('uses an explicitly unconfigured default and persists no candidate coordinates', async () => {
    expect((await new UnconfiguredCallerLocationResolver().resolve('Synthetic Test Site Seven')).outcome).toBe('UNAVAILABLE');
    const { service, emergencies } = harness();
    await service.capture('EMG-test', 'Synthetic Test Site Seven');
    expect(emergencies.recordCallerLocationCandidate).toHaveBeenCalledWith(expect.objectContaining({
      emergencyId: 'EMG-test', outcome: 'UNAVAILABLE', provider: 'unconfigured', latitude: null, longitude: null, attempt: 1,
    }));
  });

  it('preserves explicit ambiguity and confidence from a deterministic provider double', async () => {
    const { service, emergencies } = harness({
      providerName: 'test-double',
      async resolve() { return { outcome: 'AMBIGUOUS', latitude: 10, longitude: 20, confidence: 0.42 }; },
    });
    await service.capture('EMG-test', 'Synthetic Test Site Seven');
    expect(emergencies.recordCallerLocationCandidate).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'AMBIGUOUS', confidence: 0.42, latitude: 10, longitude: 20, provider: 'test-double',
    }));
  });

  it('marks malformed coordinates or confidence as INVALID_RESULT', async () => {
    const { service, emergencies } = harness({
      providerName: 'malformed-test-double',
      async resolve() { return { outcome: 'CANDIDATE', latitude: 100, longitude: 20, confidence: 1.4 }; },
    });
    await service.capture('EMG-test', 'Synthetic Test Site Seven');
    expect(emergencies.recordCallerLocationCandidate).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'INVALID_RESULT', confidence: null, latitude: null, longitude: null,
    }));
  });

  it('records timeouts and provider errors as unavailable without exposing provider exception text', async () => {
    const timeout = harness({ providerName: 'slow-test-double', async resolve() { await new Promise((resolve) => setTimeout(resolve, 20)); return { outcome: 'NOT_FOUND' }; } }, 1);
    await timeout.service.capture('EMG-test', 'Synthetic Test Site Seven');
    expect(timeout.emergencies.recordCallerLocationCandidate).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'UNAVAILABLE' }));

    const failure = harness({ providerName: 'failing-test-double', async resolve() { throw new Error('private provider response'); } });
    await failure.service.capture('EMG-test', 'Synthetic Test Site Seven');
    expect(failure.emergencies.recordCallerLocationCandidate).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'UNAVAILABLE' }));
  });

  it('allows only bounded explicit retries for unavailable or ambiguous persisted candidates', async () => {
    const { service, emergencies } = harness({ providerName: 'retry-test-double', async resolve() { return { outcome: 'NOT_FOUND' }; } });
    const previous = candidateEvent({ callerLocationText: 'Synthetic Test Site Seven', outcome: 'UNAVAILABLE', attempt: 1 });
    await service.retry('EMG-test', previous.id, previous);
    expect(emergencies.recordCallerLocationCandidate).toHaveBeenCalledWith(expect.objectContaining({ attempt: 2 }));
    await expect(service.retry('EMG-test', previous.id, candidateEvent({ callerLocationText: 'site', outcome: 'NOT_FOUND', attempt: 3 }))).rejects.toMatchObject({ statusCode: 409 });
  });

  it('does not persist empty or oversized location text', async () => {
    const { service, emergencies } = harness();
    await service.capture('EMG-test', '   ');
    await service.capture('EMG-test', 'x'.repeat(201));
    expect(emergencies.recordCallerLocationCandidate).not.toHaveBeenCalled();
  });
});
