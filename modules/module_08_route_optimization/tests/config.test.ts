import { afterEach, describe, expect, it, vi } from 'vitest';
import { Module8 } from '../src/module.js';
import { loadModule8Config } from '../src/config.js';

describe('Module 8 automatic route-generation gate', () => {
  const original = process.env.MODULE8_AUTO_ROUTE_ENABLED;

  afterEach(() => {
    vi.unstubAllEnvs();
    if (original === undefined) delete process.env.MODULE8_AUTO_ROUTE_ENABLED;
    else process.env.MODULE8_AUTO_ROUTE_ENABLED = original;
  });

  it.each([undefined, 'false', 'yes', '1', ''])('fails closed for %s', (value) => {
    if (value === undefined) delete process.env.MODULE8_AUTO_ROUTE_ENABLED;
    else vi.stubEnv('MODULE8_AUTO_ROUTE_ENABLED', value);
    expect(loadModule8Config().generation.enabled).toBe(false);
  });

  it('enables only when explicitly true and leaves route generation available when disabled', () => {
    vi.stubEnv('MODULE8_AUTO_ROUTE_ENABLED', 'true');
    const enabled = new Module8({ routes: {} as never, emergencies: {} as never, ambulances: {} as never, hospitals: {} as never, events: {} as never, bus: { subscribe: vi.fn(() => () => {}) } as never });
    expect(enabled.autoRoute).toBeDefined();
    enabled.dispose();

    vi.stubEnv('MODULE8_AUTO_ROUTE_ENABLED', 'false');
    const disabled = new Module8({ routes: {} as never, emergencies: {} as never, ambulances: {} as never, hospitals: {} as never, events: {} as never, bus: { subscribe: vi.fn() } as never });
    expect(disabled.autoRoute).toBeUndefined();
    expect(disabled.optimization).toBeDefined();
  });

  it('fails closed when an injected config omits the automation subsection', () => {
    const config = { ...loadModule8Config(), generation: undefined } as never;
    const module = new Module8({ routes: {} as never, emergencies: {} as never, ambulances: {} as never, hospitals: {} as never, events: {} as never, bus: { subscribe: vi.fn() } as never, config });
    expect(module.autoRoute).toBeUndefined();
  });
});

describe('Module 8 routing-provider selection', () => {
  it('keeps mock as the default and for malformed provider values', () => {
    expect(loadModule8Config({}).provider).toBe('mock');
    expect(loadModule8Config({ MODULE8_PROVIDER: 'Google' }).provider).toBe('mock');
  });

  it('preserves OSRM as an explicit provider', () => {
    expect(loadModule8Config({ MODULE8_PROVIDER: 'osrm' }).provider).toBe('osrm');
  });

  it('requires a server-side key before opting into Google Routes', () => {
    expect(() => loadModule8Config({ MODULE8_PROVIDER: 'google' })).toThrow(
      /MODULE8_GOOGLE_API_KEY is required/,
    );
  });

  it('loads Google only with an explicit provider and validates its timeout', () => {
    const config = loadModule8Config({
      MODULE8_PROVIDER: 'google',
      MODULE8_GOOGLE_API_KEY: '  test-server-key  ',
      MODULE8_GOOGLE_TIMEOUT_MS: '12000',
    });
    expect(config.provider).toBe('google');
    expect(config.google).toEqual({ apiKey: 'test-server-key', timeoutMs: 12000 });
    expect(() => loadModule8Config({
      MODULE8_PROVIDER: 'google',
      MODULE8_GOOGLE_API_KEY: 'test-server-key',
      MODULE8_GOOGLE_TIMEOUT_MS: '50',
    })).toThrow(/MODULE8_GOOGLE_TIMEOUT_MS/);
  });
});
