import { afterEach, describe, expect, it, vi } from 'vitest';
import { Module7 } from '../src/module.js';
import { loadModule7Config } from '../src/config.js';

describe('Module 7 automatic hospital-selection gate', () => {
  const original = process.env.MODULE7_AUTO_SELECT_ENABLED;

  afterEach(() => {
    vi.unstubAllEnvs();
    if (original === undefined) delete process.env.MODULE7_AUTO_SELECT_ENABLED;
    else process.env.MODULE7_AUTO_SELECT_ENABLED = original;
  });

  it.each([undefined, 'false', 'yes', '1', ''])('fails closed for %s', (value) => {
    if (value === undefined) delete process.env.MODULE7_AUTO_SELECT_ENABLED;
    else vi.stubEnv('MODULE7_AUTO_SELECT_ENABLED', value);
    expect(loadModule7Config().autoSelect.enabled).toBe(false);
  });

  it('enables only when explicitly true and leaves the manual selection service available when disabled', () => {
    vi.stubEnv('MODULE7_AUTO_SELECT_ENABLED', 'true');
    const enabled = new Module7({ hospitals: {} as never, emergencies: {} as never, events: {} as never, bus: { subscribe: vi.fn(() => () => {}) } as never });
    expect(enabled.autoSelect).toBeDefined();
    enabled.dispose();

    vi.stubEnv('MODULE7_AUTO_SELECT_ENABLED', 'false');
    const disabled = new Module7({ hospitals: {} as never, emergencies: {} as never, events: {} as never, bus: { subscribe: vi.fn() } as never });
    expect(disabled.autoSelect).toBeUndefined();
    expect(disabled.selection).toBeDefined();
  });

  it('fails closed when an injected config omits the automation subsection', () => {
    const config = { ...loadModule7Config(), autoSelect: undefined } as never;
    const module = new Module7({ hospitals: {} as never, emergencies: {} as never, events: {} as never, bus: { subscribe: vi.fn() } as never, config });
    expect(module.autoSelect).toBeUndefined();
  });
});
