import {
  noopLogger,
  type DomainEventBusPort,
  type SystemEventRecord,
  type SystemEventType,
} from '@resus/core';
import { CorridorService } from '../src/corridorService.js';
import type { Module9Config } from '../src/config.js';
import { MockRoadUserProvider } from '../src/providers/roadUserProvider.js';
import { MockNotificationProvider } from '../src/providers/notificationProvider.js';
import type {
  CorridorActivationInput,
  CorridorActivationResult,
  CorridorRecord,
  CorridorReleaseResult,
  CorridorRoute,
  CorridorRouteReadPort,
  CorridorWriterPort,
  NotificationCreateInput,
  NotificationRecord,
  NotificationWriterPort,
} from '../src/ports.js';

export const TEST_CONFIG: Module9Config = {
  enabled: true,
  radiusM: 150,
  includeSimulation: false,
  maxSimulatedRoadUsers: 3,
};

export class FakeCorridorWriter implements CorridorWriterPort {
  readonly records = new Map<string, CorridorRecord>();
  readonly events: string[] = [];
  failActivation = false;

  async activateCorridor(input: CorridorActivationInput): Promise<CorridorActivationResult> {
    if (this.failActivation) throw new Error('database down');
    const existing = this.records.get(input.emergencyId);
    if (existing && existing.isActive && existing.status === 'ACTIVE') {
      return { id: existing.id, status: existing.status, isActive: true, activated: false };
    }
    const id = existing?.id ?? `COR-${this.records.size + 1}`;
    this.records.set(input.emergencyId, {
      id,
      emergencyId: input.emergencyId,
      ambulanceId: input.ambulanceId,
      hospitalId: input.hospitalId,
      fromLabel: input.fromLabel,
      toLabel: input.toLabel,
      estimatedMinutes: input.estimatedMinutes,
      isActive: true,
      activatedAt: new Date().toISOString(),
      releasedAt: null,
      isSimulation: input.isSimulation,
      status: 'ACTIVE',
      priorityMode: input.priorityMode,
      radiusM: input.radiusM,
      geofence: input.geofence.map((c) => [c.latitude, c.longitude] as [number, number]),
      roadUsers: Array.isArray(input.roadUsers) ? input.roadUsers : [input.roadUsers],
      signals: Array.isArray(input.signals) ? input.signals : [],
      renegotiationCount: 0,
    });
    this.events.push('CORRIDOR_ACTIVATED');
    return { id, status: 'ACTIVE', isActive: true, activated: true };
  }

  async releaseCorridor(emergencyId: string): Promise<CorridorReleaseResult> {
    const existing = this.records.get(emergencyId);
    if (!existing || !existing.isActive) return { released: false };
    this.records.set(emergencyId, {
      ...existing,
      isActive: false,
      status: 'RELEASED',
      releasedAt: new Date().toISOString(),
    });
    this.events.push('CORRIDOR_RELEASED');
    return { released: true };
  }

  async getCorridor(emergencyId: string): Promise<CorridorRecord | null> {
    return this.records.get(emergencyId) ?? null;
  }
}

export class FakeNotificationWriter implements NotificationWriterPort {
  readonly records: NotificationRecord[] = [];
  fail = false;

  async create(input: NotificationCreateInput): Promise<NotificationRecord> {
    if (this.fail) throw new Error('database down');
    const record: NotificationRecord = {
      id: `NTF-${this.records.length + 1}`,
      emergencyId: input.emergencyId,
      corridorId: input.corridorId ?? null,
      channel: input.channel,
      audience: input.audience,
      status: input.status,
      provider: input.provider,
      delivered: input.delivered,
      body: input.body,
      latitude: input.latitude ?? null,
      longitude: input.longitude ?? null,
      failureReason: input.failureReason ?? null,
      createdAt: new Date().toISOString(),
      sentAt: null,
    };
    this.records.push(record);
    return record;
  }

  async listForEmergency(emergencyId: string): Promise<NotificationRecord[]> {
    return this.records.filter((record) => record.emergencyId === emergencyId);
  }
}

export class FakeRouteRead implements CorridorRouteReadPort {
  readonly routes = new Map<string, CorridorRoute[]>();

  async routesForEmergency(emergencyId: string): Promise<CorridorRoute[]> {
    return this.routes.get(emergencyId) ?? [];
  }
}

export class FakeBus implements DomainEventBusPort {
  private handlers: Array<{
    types: SystemEventType[];
    handler: (event: SystemEventRecord) => void | Promise<void>;
  }> = [];

  subscribe<T extends SystemEventType>(
    types: T[],
    handler: (event: SystemEventRecord) => void | Promise<void>,
  ): () => void {
    const entry = { types: types as SystemEventType[], handler };
    this.handlers.push(entry);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== entry);
    };
  }

  publish(event: SystemEventRecord): void {
    for (const entry of this.handlers) {
      if (entry.types.includes(event.type)) void entry.handler(event);
    }
  }

  get subscriberCount(): number {
    return this.handlers.length;
  }
}

export function makeRoute(overrides: Partial<CorridorRoute> = {}): CorridorRoute {
  return {
    id: 'RTE-1',
    emergencyId: 'EMG-1',
    ambulanceId: 'AMB-1',
    hospitalId: 'HSP-1',
    originName: 'SCENE',
    destinationName: 'HOSPITAL',
    polyline: [
      [12.9716, 77.5946],
      [12.99, 77.6],
    ],
    estimatedMinutes: 12,
    isSimulation: false,
    ...overrides,
  };
}

export function buildService(config: Module9Config = TEST_CONFIG) {
  const corridors = new FakeCorridorWriter();
  const notifications = new FakeNotificationWriter();
  const service = new CorridorService({
    corridors,
    notifications,
    roadUsers: new MockRoadUserProvider({ maxUsers: config.maxSimulatedRoadUsers }),
    notificationProvider: new MockNotificationProvider(),
    config,
    logger: noopLogger,
  });
  return { corridors, notifications, service };
}

export function makeEvent(
  type: SystemEventType,
  payload: Record<string, unknown> = {},
  emergencyId: string | null = 'EMG-1',
): SystemEventRecord {
  return {
    id: `EVT-${Math.random().toString(36).slice(2, 8)}`,
    sequence: 1,
    type,
    emergencyId,
    entityType: 'emergency',
    entityId: emergencyId,
    timestamp: new Date().toISOString(),
    actorType: 'SYSTEM',
    actorId: null,
    payload,
    metadata: null,
  };
}
