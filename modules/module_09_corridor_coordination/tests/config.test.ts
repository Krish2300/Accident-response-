import { afterEach, describe, expect, it, vi } from 'vitest';
import { Module9 } from '../src/module.js';
import { loadModule9Config } from '../src/config.js';
import { FakeCorridorWriter, FakeNotificationWriter, makeRoute } from './support.js';

describe('Module 9 automatic corridor-coordination gate', () => {
  const original = process.env.MODULE9_CORRIDOR_ENABLED;

  afterEach(() => {
    vi.unstubAllEnvs();
    if (original === undefined) delete process.env.MODULE9_CORRIDOR_ENABLED;
    else process.env.MODULE9_CORRIDOR_ENABLED = original;
  });

  it.each([undefined, 'false', 'yes', '1', ''])('fails closed for %s', (value) => {
    if (value === undefined) delete process.env.MODULE9_CORRIDOR_ENABLED;
    else vi.stubEnv('MODULE9_CORRIDOR_ENABLED', value);
    expect(loadModule9Config().enabled).toBe(false);
  });

  it('enables only when explicitly true and leaves explicit corridor operations available when disabled', async () => {
    vi.stubEnv('MODULE9_CORRIDOR_ENABLED', 'true');
    const enabled = new Module9({ corridors: {} as never, notifications: {} as never, routes: {} as never, bus: { subscribe: vi.fn(() => () => {}) } as never });
    expect(enabled.autoCorridor).toBeDefined();
    enabled.dispose();

    vi.stubEnv('MODULE9_CORRIDOR_ENABLED', 'false');
    const disabled = new Module9({ corridors: {} as never, notifications: {} as never, routes: {} as never, bus: { subscribe: vi.fn() } as never });
    expect(disabled.autoCorridor).toBeUndefined();
    expect(disabled.service).toBeDefined();
    expect(disabled.integration).toBeDefined();

    const manual = new Module9({
      corridors: new FakeCorridorWriter(),
      notifications: new FakeNotificationWriter(),
      routes: { routesForEmergency: vi.fn().mockResolvedValue([]) } as never,
      config: loadModule9Config(),
    });
    expect((await manual.service.activateForRoute(makeRoute())).outcome).toBe('ACTIVATED');
  });

  it('fails closed when the injected enabled value is absent', () => {
    const config = { ...loadModule9Config(), enabled: undefined } as never;
    const module = new Module9({ corridors: {} as never, notifications: {} as never, routes: {} as never, bus: { subscribe: vi.fn() } as never, config });
    expect(module.autoCorridor).toBeUndefined();
  });
});
