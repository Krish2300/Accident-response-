import { describe, expect, it } from 'vitest';
import { loadModule12Config } from '../src/config.js';
import { includeSimulationQuerySchema } from '../src/api/routes.js';

const keys = ['MODULE12_LEARNING_ENABLED', 'MODULE12_INCLUDE_SIM'] as const;

function withCleanModule12Env(run: () => void): void {
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  try {
    run();
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('Module 12 learning and simulation configuration', () => {
  it('defaults learning and simulation inclusion to disabled', () => withCleanModule12Env(() => {
    const config = loadModule12Config();
    expect(config.learning.enabled).toBe(false);
    expect(config.analytics.includeSimulationByDefault).toBe(false);
  }));

  it('requires explicit true to enable learning and parses explicit simulation flags intuitively', () => withCleanModule12Env(() => {
    process.env.MODULE12_LEARNING_ENABLED = 'true';
    process.env.MODULE12_INCLUDE_SIM = 'true';
    expect(loadModule12Config()).toMatchObject({
      learning: { enabled: true },
      analytics: { includeSimulationByDefault: true },
    });

    process.env.MODULE12_LEARNING_ENABLED = 'false';
    process.env.MODULE12_INCLUDE_SIM = 'false';
    expect(loadModule12Config()).toMatchObject({
      learning: { enabled: false },
      analytics: { includeSimulationByDefault: false },
    });
  }));

  it('fails explicitly on malformed environment flags', () => withCleanModule12Env(() => {
    process.env.MODULE12_LEARNING_ENABLED = 'sometimes';
    expect(() => loadModule12Config()).toThrow('MODULE12_LEARNING_ENABLED');
    delete process.env.MODULE12_LEARNING_ENABLED;
    process.env.MODULE12_INCLUDE_SIM = 'yes';
    expect(() => loadModule12Config()).toThrow('MODULE12_INCLUDE_SIM');
  }));
});

describe('includeSimulation query parsing', () => {
  it('keeps omitted, true and false values explicit and rejects malformed values', () => {
    expect(includeSimulationQuerySchema.parse(undefined)).toBeUndefined();
    expect(includeSimulationQuerySchema.parse('true')).toBe(true);
    expect(includeSimulationQuerySchema.parse('false')).toBe(false);
    expect(includeSimulationQuerySchema.parse(' TRUE ')).toBe(true);
    expect(includeSimulationQuerySchema.safeParse('no').success).toBe(false);
    expect(includeSimulationQuerySchema.safeParse(['false']).success).toBe(false);
  });
});
