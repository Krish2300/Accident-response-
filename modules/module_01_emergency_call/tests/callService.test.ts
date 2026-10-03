import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import {
  AppError,
  ErrorCode,
  type CallSession,
  type Database,
  type Emergency,
  type EventPublisherPort,
  type SystemEventEnvelope,
  type SystemEventRecord,
  type TelephonyProvider,
} from '@resus/core';
import { CallService, type CallSessionStore, type EmergencyStore } from '../src/callService.js';
import { loadModule1Config } from '../src/config.js';
import { LoopbackTelephonyProvider } from '../src/telephony/loopbackProvider.js';

/**
 * Module 1 call lifecycle tests.
 *
 * Persistence is faked rather than spied on with function mocks, because the
 * behaviour under test *is* the interaction with the store: idempotent reuse,
 * "close the row even when the carrier is gone", and the rule that a transport
 * failure must not leave a started session behind.
 */

const config = loadModule1Config();

// -- fakes -------------------------------------------------------------------

class FakeEvents implements EventPublisherPort {
  readonly recorded: SystemEventEnvelope[] = [];

  async record(event: SystemEventEnvelope): Promise<SystemEventRecord> {
    this.recorded.push(event);
    return { id: `EVT-${this.recorded.length}` } as SystemEventRecord;
  }

  async recordMany(events: SystemEventEnvelope[]): Promise<SystemEventRecord[]> {
    for (const event of events) this.recorded.push(event);
    return events.map((_, index) => ({ id: `EVT-${index}` }) as SystemEventRecord);
  }

  async recordInTransaction(_db: Database, event: SystemEventEnvelope): Promise<SystemEventRecord> {
    // Module 1 never records inside a caller-owned transaction: each of its
    // writes is a single row plus its own event, so honouring one here would
    // imply cross-module atomicity this module cannot provide.
    return this.record(event);
  }

  types(): string[] {
    return this.recorded.map((event) => event.type);
  }
}

class FakeEmergencies implements EmergencyStore {
  readonly rows = new Map<string, Emergency>();
  private sequence = 0;

  async create(input: {
    incidentType: string;
    severity: string;
    latitude: number;
    longitude: number;
    description?: string | null;
    callerId?: string | null;
    isSimulation?: boolean;
  }): Promise<Emergency> {
    this.sequence += 1;
    const emergency: Emergency = {
      id: `EMG-${this.sequence}`,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      status: 'CREATED',
      incidentType: input.incidentType as Emergency['incidentType'],
      severity: input.severity as Emergency['severity'],
      latitude: input.latitude,
      longitude: input.longitude,
      description: input.description ?? null,
      callerId: input.callerId ?? null,
      assignedAmbulanceId: null,
      selectedHospitalId: null,
      isSimulation: input.isSimulation ?? false,
    };
    this.rows.set(emergency.id, emergency);
    return emergency;
  }

  async requireById(id: string): Promise<Emergency> {
    const row = this.rows.get(id);
    if (!row) throw AppError.notFound('Emergency', id);
    return row;
  }
}

class FakeCalls implements CallSessionStore {
  readonly sessions: CallSession[] = [];
  readonly transcripts: Array<Record<string, unknown>> = [];
  private sequence = 0;

  async startSession(input: {
    emergencyId: string;
    channel?: string;
    callerId?: string | null;
    language?: string;
    isSimulation?: boolean;
  }): Promise<CallSession> {
    this.sequence += 1;
    const session: CallSession = {
      id: `CALL-${this.sequence}`,
      emergencyId: input.emergencyId,
      channel: input.channel ?? 'VOICE',
      callerId: input.callerId ?? null,
      status: 'ACTIVE',
      language: input.language ?? 'en',
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: null,
      isSimulation: input.isSimulation ?? false,
    };
    this.sessions.push(session);
    return session;
  }

  async sessionById(id: string): Promise<CallSession | null> {
    return this.sessions.find((session) => session.id === id) ?? null;
  }

  async requireSessionFor(emergencyId: string): Promise<CallSession> {
    const matches = this.sessions.filter((session) => session.emergencyId === emergencyId);
    const newest = matches.at(-1);
    if (!newest) throw AppError.notFound('Call session for emergency', emergencyId);
    return newest;
  }

  async activeSessions(): Promise<CallSession[]> {
    return this.sessions.filter((session) => session.status === 'ACTIVE');
  }

  async endSession(id: string): Promise<CallSession | null> {
    const session = await this.sessionById(id);
    if (!session) return null;
    session.status = 'ENDED';
    session.endedAt = '2026-01-01T00:05:30.000Z';
    return session;
  }

  async appendTranscript(input: {
    callSessionId: string;
    emergencyId: string;
    speaker: string;
    text: string;
    isFinal?: boolean;
    intent?: string | null;
    confidence?: number | null;
    isSimulation?: boolean;
  }) {
    this.transcripts.push(input as unknown as Record<string, unknown>);
    return input as never;
  }

  async transcriptsFor(): Promise<never[]> {
    return [];
  }
}

/** Transport whose behaviour each test dictates. */
class ScriptedTelephony implements TelephonyProvider {
  readonly providerName = 'scripted';
  readonly isLive = false;
  hangupCalls = 0;
  shouldFailOriginate = false;
  shouldFailHangup = false;

  async originate() {
    if (this.shouldFailOriginate) throw new Error('carrier rejected INVITE');
    return {
      callSessionId: 'h1',
      transport: 'LOOPBACK' as const,
      providerName: this.providerName,
      isLive: false,
      startedAt: '2026-01-01T00:00:00.000Z',
    };
  }

  async hangup(): Promise<void> {
    this.hangupCalls += 1;
    if (this.shouldFailHangup) throw new Error('carrier unreachable');
  }

  async probe() {
    return { reachable: true, detail: 'scripted' };
  }
}

function harness(telephony: TelephonyProvider = new ScriptedTelephony()) {
  const emergencies = new FakeEmergencies();
  const calls = new FakeCalls();
  const events = new FakeEvents();
  const service = new CallService({ config, telephony, emergencies, calls, events });
  return { service, emergencies, calls, events, telephony: telephony as ScriptedTelephony };
}

const location = { latitude: 12.9716, longitude: 77.5946 };

beforeEach(() => {
  vi.clearAllMocks();
});

// -- tests -------------------------------------------------------------------

describe('opening a call', () => {
  it('creates the emergency, the session and a CALL_CONNECTED event', async () => {
    const { service, events } = harness();

    const result = await service.open({ ...location, incidentType: 'CARDIAC_ARREST', severity: 'CRITICAL' });

    expect(result.emergency.id).toBe('EMG-1');
    expect(result.session.emergencyId).toBe('EMG-1');
    expect(result.session.status).toBe('ACTIVE');
    expect(result.reused).toBe(false);
    expect(result.isLiveTransport).toBe(false);
    // CALL_STARTED is emitted by the persistence layer inside its own
    // transaction; Module 1 must not add a second copy of it.
    expect(events.types()).toEqual(['CALL_CONNECTED']);
  });

  it('attaches to an existing emergency instead of creating a second one', async () => {
    const { service, emergencies } = harness();
    const first = await service.open({ ...location });

    const second = await service.open({ emergencyId: first.emergency.id, ...location });

    expect(second.reused).toBe(true);
    expect(second.session.id).toBe(first.session.id);
    expect(emergencies.rows.size).toBe(1);
  });

  it('requires a location when no emergency is supplied', async () => {
    const { service } = harness();

    await expect(service.open({ incidentType: 'CARDIAC_ARREST' })).rejects.toThrow(/latitude and longitude/);
  });

  it('normalises the language to its base code', async () => {
    const { service } = harness();

    const result = await service.open({ ...location, language: 'en-IN' });

    expect(result.session.language).toBe('en');
  });

  it('does not leave a started session when the carrier rejects the call', async () => {
    const telephony = new ScriptedTelephony();
    telephony.shouldFailOriginate = true;
    const { service, calls, events } = harness(telephony);

    await expect(service.open({ ...location })).rejects.toMatchObject({
      code: ErrorCode.PROVIDER_UNAVAILABLE,
      statusCode: 503,
    });

    // The point of ordering transport-before-persist: nothing claims a call is live.
    expect(calls.sessions).toHaveLength(0);
    expect(events.types()).not.toContain('CALL_CONNECTED');
  });

  it('reuses an active session without asking the carrier for another', async () => {
    const telephony = new ScriptedTelephony();
    const { service, calls } = harness(telephony);
    const opened = await service.open({ ...location });

    telephony.shouldFailOriginate = true;
    const retry = await service.open({ emergencyId: opened.emergency.id });

    // The retry never reaches the transport, so the injected failure cannot fire.
    expect(retry.reused).toBe(true);
    expect(calls.sessions).toHaveLength(1);
  });

  it('records CALL_FAILED when reconnecting to a closed emergency cannot connect', async () => {
    const telephony = new ScriptedTelephony();
    const { service, events } = harness(telephony);
    const opened = await service.open({ ...location });
    await service.close(opened.session.id);
    telephony.shouldFailOriginate = true;

    await expect(service.open({ emergencyId: opened.emergency.id })).rejects.toMatchObject({
      code: ErrorCode.PROVIDER_UNAVAILABLE,
    });

    // The failed attempt is in the timeline, not only in the server log.
    expect(events.types()).toContain('CALL_FAILED');
  });
});

describe('closing a call', () => {
  it('records the duration and emits CALL_DISCONNECTED once', async () => {
    const { service, events } = harness();
    const opened = await service.open({ ...location });

    const closed = await service.close(opened.session.id, 'Caller hung up.');

    expect(closed.closed).toBe(true);
    expect(closed.session.status).toBe('ENDED');
    expect(closed.durationMs).toBe(330_000);
    expect(events.types()).toEqual(['CALL_CONNECTED', 'CALL_DISCONNECTED']);
  });

  it('is idempotent: a second close reports it did not close anything', async () => {
    const { service, events } = harness();
    const opened = await service.open({ ...location });

    await service.close(opened.session.id);
    const again = await service.close(opened.session.id);

    expect(again.closed).toBe(false);
    expect(again.session.status).toBe('ENDED');
    expect(events.types().filter((type) => type === 'CALL_DISCONNECTED')).toHaveLength(1);
  });

  it('closes the local session even when the carrier is already gone', async () => {
    const telephony = new ScriptedTelephony();
    telephony.shouldFailHangup = true;
    const { service } = harness(telephony);
    const opened = await service.open({ ...location });

    const closed = await service.close(opened.session.id);

    // A dead carrier must never leave the row ACTIVE.
    expect(closed.closed).toBe(true);
    expect(closed.session.status).toBe('ENDED');
  });

  it('rejects an unknown call session', async () => {
    const { service } = harness();

    await expect(service.close('CALL-nope')).rejects.toMatchObject({ code: ErrorCode.CALL_NOT_FOUND });
  });

  it('closes the open call when an emergency terminates, and only once', async () => {
    const { service } = harness();
    const opened = await service.open({ ...location });

    const closed = await service.closeForEmergency(opened.emergency.id, 'Emergency closed.');

    expect(closed?.closed).toBe(true);
    expect(await service.closeForEmergency(opened.emergency.id, 'Emergency closed.')).toBeNull();
  });
});

describe('call duration limit', () => {
  it('closes only sessions that are genuinely over the limit', async () => {
    const { service, calls } = harness();
    await service.open({ ...location });
    const startedAt = new Date('2026-01-01T00:00:00.000Z').getTime();

    // 10 minutes in: under the limit, must be left alone.
    const early = await service.enforceMaxDuration(new Date(startedAt + 10 * 60_000));
    expect(early).toHaveLength(0);
    expect(calls.sessions.at(-1)?.status).toBe('ACTIVE');

    // 31 minutes in: over the limit.
    const late = await service.enforceMaxDuration(new Date(startedAt + 31 * 60_000));
    expect(late).toHaveLength(1);
    expect(calls.sessions.at(-1)?.status).toBe('ENDED');
  });
});

describe('transcripts', () => {
  it('refuses speech on a call that has ended', async () => {
    const { service } = harness();
    const opened = await service.open({ ...location });
    await service.close(opened.session.id);

    await expect(
      service.recordUtterance({ callSessionId: opened.session.id, speaker: 'CALLER', text: 'Are you there?' }),
    ).rejects.toMatchObject({ code: ErrorCode.CONVERSATION_CLOSED });
  });

  it('inherits the simulation flag from the session', async () => {
    const { service, calls } = harness();
    const opened = await service.open({ ...location, isSimulation: true });

    await service.recordUtterance({ callSessionId: opened.session.id, speaker: 'CALLER', text: 'Help!' });

    expect(calls.transcripts[0]).toMatchObject({ isSimulation: true, emergencyId: opened.emergency.id });
  });
});

describe('transport status', () => {
  it('never claims the loopback transport is live', async () => {
    const { service } = harness(new LoopbackTelephonyProvider());

    const status = await service.transportStatus();

    expect(status.isLive).toBe(false);
    expect(status.provider).toBe('loopback');
    expect(status.reachable).toBe(true);
  });

  it('reports an unreachable transport instead of throwing', async () => {
    const { service } = harness();
    vi.spyOn(service as never, 'transportStatus');
    const telephony = new ScriptedTelephony();
    vi.spyOn(telephony, 'probe').mockRejectedValue(new Error('carrier down'));
    const h = harness(telephony);

    const status = await h.service.transportStatus();

    expect(status.reachable).toBe(false);
    expect(status.detail).toBe('carrier down');
    void service;
  });
});

describe('configuration', () => {
  // The shared env readers consult `process.env`, so that is what a config test
  // must set. Keys are restored so one case cannot leak into the next.
  const keys = ['TRANSPORT_PROVIDER', 'TRANSPORT_SIGNALLING_URL', 'CALL_MAX_DURATION_MINUTES'] as const;
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

  afterEach(() => {
    for (const key of keys) {
      const value = original[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('refuses a configured carrier with no signalling URL', () => {
    delete process.env.TRANSPORT_SIGNALLING_URL;
    process.env.TRANSPORT_PROVIDER = 'sip';

    // Looks configured in review, would silently lose calls at runtime.
    expect(() => loadModule1Config()).toThrow(/TRANSPORT_SIGNALLING_URL/);
  });

  it('defaults to the loopback transport', () => {
    delete process.env.TRANSPORT_PROVIDER;
    delete process.env.TRANSPORT_SIGNALLING_URL;

    expect(loadModule1Config().telephony.provider).toBe('loopback');
  });

  it('rejects an unknown transport name outright', () => {
    process.env.TRANSPORT_PROVIDER = 'carrier-pigeon';

    expect(() => loadModule1Config()).toThrow(/must be one of/);
  });

  it('honours a configured maximum duration', () => {
    delete process.env.TRANSPORT_PROVIDER;
    process.env.CALL_MAX_DURATION_MINUTES = '45';

    expect(loadModule1Config().telephony.maxCallDurationMinutes).toBe(45);
  });
});