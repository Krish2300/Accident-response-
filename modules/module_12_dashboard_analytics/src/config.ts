/**
 * Module 12 - Dashboard & Learning / Analytics configuration
 */

export interface Module12Config {
  analytics: {
    defaultWindowDays: number;
    maxWindowDays: number;
    includeSimulationByDefault: boolean;
  };
  dashboard: {
    refreshIntervalMs: number;
    maxEventsInTimeline: number;
  };
  learning: {
    enabled: boolean;
    minSamplesForUpdate: number;
  };
}

export function loadModule12Config(): Module12Config {
  return {
    analytics: {
      defaultWindowDays: Number(process.env.MODULE12_DEFAULT_WINDOW_DAYS ?? 30),
      maxWindowDays: Number(process.env.MODULE12_MAX_WINDOW_DAYS ?? 365),
      includeSimulationByDefault: Boolean(process.env.MODULE12_INCLUDE_SIM === 'false'),
    },
    dashboard: {
      refreshIntervalMs: Number(process.env.MODULE12_REFRESH_INTERVAL_MS ?? 5000),
      maxEventsInTimeline: Number(process.env.MODULE12_MAX_TIMELINE ?? 100),
    },
    learning: {
      enabled: Boolean(process.env.MODULE12_LEARNING_ENABLED !== 'false'),
      minSamplesForUpdate: Number(process.env.MODULE12_LEARNING_MIN_SAMPLES ?? 10),
    },
  };
}
