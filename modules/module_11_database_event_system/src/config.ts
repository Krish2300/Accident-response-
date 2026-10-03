import { readBoolean, readNumber, readString } from '@resus/core';

/**
 * Module 11 configuration. Credentials are never hardcoded; every value comes
 * from the environment (see `.env.example`). `dotenv` is loaded by the
 * composition root before this is called.
 */
export interface Module11Config {
  databaseUrl: string;
  seedDemoData: boolean;
  maxEventPageSize: number;
}

export function loadModule11Config(): Module11Config {
  return {
    databaseUrl: readString('DATABASE_URL', 'file:./dev.db'),
    seedDemoData: readBoolean('SEED_DEMO_DATA', false),
    maxEventPageSize: readNumber('MAX_EVENT_PAGE_SIZE', 500),
  };
}
