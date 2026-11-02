import { describe, expect, it, vi } from 'vitest';
import { SimulatedPoliceNotificationService } from '../src/policeNotificationService.js';

const route = {
  id: 'RTE-1', emergencyId: 'EMG-1', ambulanceId: 'AMB-1', hospitalId: 'HSP-1',
  originName: 'AMBULANCE', destinationName: 'SCENE',
  polyline: [[12.9, 77.5], [12.91, 77.51]] as Array<[number, number]>,
  estimatedMinutes: 4, isSimulation: false, provider: 'deterministic', isLiveTraffic: false,
};

function harness(dispatched = true) {
  const createPoliceRouteNotification = vi.fn(async (input: unknown) => ({
    id: 'NTF-1', emergencyId: 'EMG-1', corridorId: null, channel: 'IN_APP', audience: 'MOCK_POLICE_CONTROL_ROOM',
    status: 'SIMULATED_SENT', provider: 'MOCK_POLICE_CONTROL_ROOM', delivered: false, body: JSON.stringify(input),
    latitude: null, longitude: null, failureReason: null, createdAt: new Date().toISOString(), sentAt: null,
  }));
  const service = new SimulatedPoliceNotificationService({
    routes: { routesForEmergency: vi.fn(async () => [route]) },
    dispatchEvents: { list: vi.fn(async () => ({ items: dispatched ? [
      { id: 'EVT-A', sequence: 1, type: 'AMBULANCE_ASSIGNED', payload: { ambulanceId: 'AMB-1' } },
      { id: 'EVT-D', sequence: 2, type: 'AMBULANCE_DISPATCHED', payload: { ambulanceId: 'AMB-1' } },
    ] : [], total: dispatched ? 2 : 0, latestSequence: 2 })) } as never,
    notifications: {
      create: vi.fn(), listForEmergency: vi.fn(async () => []), createPoliceRouteNotification,
      acknowledgePoliceRouteNotification: vi.fn(async () => ({ id: 'NTF-1', status: 'ACKNOWLEDGED_SIMULATED' } as never)),
    },
  });
  return { service, createPoliceRouteNotification };
}

describe('Module 9 simulated police route notice', () => {
  it('requires a persisted explicit dispatch for the route ambulance', async () => {
    const { service, createPoliceRouteNotification } = harness(false);
    await expect(service.create('EMG-1', 'RTE-1', 'DISPATCHER-1')).rejects.toMatchObject({ statusCode: 409 });
    expect(createPoliceRouteNotification).not.toHaveBeenCalled();
  });

  it('persists only a mock notice with route provenance and no delivery claim', async () => {
    const { service, createPoliceRouteNotification } = harness();
    await service.create('EMG-1', 'RTE-1', 'DISPATCHER-1');
    expect(createPoliceRouteNotification).toHaveBeenCalledWith(expect.objectContaining({
      emergencyId: 'EMG-1', createdByUserId: 'DISPATCHER-1', ambulanceId: 'AMB-1', routeId: 'RTE-1', provider: 'deterministic', isLiveTraffic: false, routeIsSimulation: false,
    }));
    expect(createPoliceRouteNotification.mock.calls[0]?.[0]).not.toHaveProperty('delivered', true);
  });

  it('records acknowledgement only through the simulated notification writer', async () => {
    const { service } = harness();
    const result = await service.acknowledge('EMG-1', 'NTF-1', 'USER-1');
    expect(result.status).toBe('ACKNOWLEDGED_SIMULATED');
  });
});
