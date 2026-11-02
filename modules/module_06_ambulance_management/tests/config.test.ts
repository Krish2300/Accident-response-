import { afterEach, describe, expect, it, vi } from 'vitest';
import { Module6 } from '../src/module.js';
import { loadModule6Config } from '../src/config.js';

describe('Module 6 automatic-dispatch safety gate', () => {
  const originalDispatchSetting = process.env.MODULE6_AUTO_DISPATCH_ENABLED;

  afterEach(() => {
    vi.unstubAllEnvs();
    if (originalDispatchSetting === undefined) {
      delete process.env.MODULE6_AUTO_DISPATCH_ENABLED;
    } else {
      process.env.MODULE6_AUTO_DISPATCH_ENABLED = originalDispatchSetting;
    }
  });

  it('defaults to disabled when the environment variable is absent', () => {
    delete process.env.MODULE6_AUTO_DISPATCH_ENABLED;

    expect(loadModule6Config().autoDispatch.enabled).toBe(false);
  });

  it('uses a positive configurable offer expiry and fails back to the safe default for invalid values', () => {
    vi.stubEnv('MODULE6_OFFER_TTL_MS', '45000');
    expect(loadModule6Config().assignment.offerTtlMs).toBe(45000);
    vi.stubEnv('MODULE6_OFFER_TTL_MS', '-1');
    expect(loadModule6Config().assignment.offerTtlMs).toBe(60000);
  });

  it('keeps automatic dispatch disabled when explicitly configured false', () => {
    vi.stubEnv('MODULE6_AUTO_DISPATCH_ENABLED', 'false');

    expect(loadModule6Config().autoDispatch.enabled).toBe(false);
  });

  it('keeps automatic dispatch disabled for malformed values', () => {
    vi.stubEnv('MODULE6_AUTO_DISPATCH_ENABLED', 'sometimes');

    expect(loadModule6Config().autoDispatch.enabled).toBe(false);
  });

  it('enables the subscriber only when explicitly true', () => {
    vi.stubEnv('MODULE6_AUTO_DISPATCH_ENABLED', 'true');
    const module6 = new Module6({
      ambulances: {} as never,
      events: {} as never,
      bus: { subscribe: vi.fn(() => () => {}) } as never,
      emergencies: {} as never,
    });

    expect(module6.autoDispatch).toBeDefined();
    module6.autoDispatch?.dispose();
  });

  it('does not subscribe when explicitly disabled, even when event dependencies exist', () => {
    vi.stubEnv('MODULE6_AUTO_DISPATCH_ENABLED', 'false');
    const module6 = new Module6({
      ambulances: {} as never,
      events: {} as never,
      bus: { subscribe: vi.fn() } as never,
      emergencies: {} as never,
    });

    expect(module6.autoDispatch).toBeUndefined();
  });

  it('fails closed when a caller supplies a config without the auto-dispatch section', () => {
    const config = loadModule6Config();
    const incompleteConfig = { ...config, autoDispatch: undefined } as never;
    const module6 = new Module6({
      ambulances: {} as never,
      events: {} as never,
      bus: { subscribe: vi.fn() } as never,
      emergencies: {} as never,
      config: incompleteConfig,
    });

    expect(module6.autoDispatch).toBeUndefined();
  });
});
