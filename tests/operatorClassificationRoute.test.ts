import { describe, expect, it, vi } from 'vitest';
import type { Emergency } from '@resus/core';
import type { Module11 } from '../modules/module_11_database_event_system/src/module.js';
import { createModule11Routes } from '../modules/module_11_database_event_system/src/api/routes.js';

function emergency(status: string): Emergency {
  return {
    id: 'EMG-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    status: status as Emergency['status'],
    incidentType: 'OTHER',
    severity: 'MEDIUM',
    latitude: 0,
    longitude: 0,
    description: null,
    callerId: null,
    assignedAmbulanceId: null,
    selectedHospitalId: null,
    isSimulation: true,
  };
}

function routeHarness(status = 'CREATED') {
  const updated = vi.fn(async (_id: string, _patch: unknown, _event: unknown, _actor: unknown) => emergency('CLASSIFIED'));
  const module11 = {
    emergencies: {
      requireById: vi.fn(async () => emergency(status)),
      update: updated,
    },
    events: {},
    calls: {},
  } as unknown as Module11;
  const route = createModule11Routes(module11).find((item) => item.method === 'PATCH' && item.url === '/api/emergencies/:id');
  if (!route) throw new Error('operator emergency update route was not registered');
  return { route, updated, module11 };
}

async function invoke(route: ReturnType<typeof routeHarness>['route'], body: unknown): Promise<unknown> {
  let response: unknown;
  const reply = { send(payload: unknown) { response = payload; return payload; } };
  await route.handler(
    {
      params: { id: 'EMG-1' },
      body,
      user: { userId: 'OP-1', role: 'OPERATOR', email: 'operator@example.test' },
    } as never,
    reply as never,
  );
  return response;
}

describe('PATCH /api/emergencies/:id operator classification contract', () => {
  it('records an explicit normalized operator decision on the same emergency id', async () => {
    const { route, updated } = routeHarness();

    await invoke(route, {
      normalizedClassification: {
        incidentType: 'CARDIAC_ARREST',
        severity: 'CRITICAL',
        confidence: 0.9,
      },
    });

    expect(route.auth).toMatchObject({ roles: expect.arrayContaining(['OPERATOR']) });
    expect(updated).toHaveBeenCalledWith(
      'EMG-1',
      { incidentType: 'CARDIAC_ARREST', severity: 'CRITICAL', status: 'CLASSIFIED', description: undefined, selectedHospitalId: undefined },
      {
        type: 'EMERGENCY_CLASSIFIED',
        payload: {
          incidentType: 'CARDIAC_ARREST',
          severity: 'CRITICAL',
          confidence: 0.9,
          source: 'OPERATOR',
        },
      },
      { actorType: 'OPERATOR', actorId: 'OP-1' },
    );
  });

  it('does not regress an emergency already beyond classification', async () => {
    const { route, updated } = routeHarness('ON_SCENE');

    await invoke(route, {
      normalizedClassification: { incidentType: 'TRAUMA', severity: 'HIGH' },
    });

    expect(updated.mock.calls[0]?.[1]).toMatchObject({ incidentType: 'TRAUMA', severity: 'HIGH' });
    expect(updated.mock.calls[0]?.[1]).not.toHaveProperty('status');
    expect(updated.mock.calls[0]?.[2]).toMatchObject({ type: 'EMERGENCY_CLASSIFIED' });
  });

  it('rejects Module 3 priority vocabulary as normalized emergency severity', async () => {
    const { route, updated } = routeHarness();

    await expect(
      invoke(route, {
        normalizedClassification: { incidentType: 'CARDIAC_ARREST', severity: 'P1' },
      }),
    ).rejects.toThrow();

    expect(updated).not.toHaveBeenCalled();
  });
});
