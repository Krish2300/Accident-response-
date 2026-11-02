import { existsSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertDatabaseUrlMatches, createIsolatedTestDatabase, type IsolatedTestDatabase } from './isolatedTestDatabase.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const schemaPath = resolve(repoRoot, 'modules/module_11_database_event_system/prisma/schema.prisma');
const prismaDir = dirname(schemaPath);
const autoSettingKeys = [
  'MODULE6_AUTO_DISPATCH_ENABLED', 'MODULE6_AUTO_DISPATCH_SIMULATION',
  'MODULE7_AUTO_SELECT_ENABLED', 'MODULE7_AUTO_SELECT_SIMULATION',
  'MODULE8_AUTO_ROUTE_ENABLED', 'MODULE8_AUTO_ROUTE_SIMULATION',
  'MODULE9_CORRIDOR_ENABLED', 'MODULE9_CORRIDOR_SIMULATION',
] as const;

describe('isolated integration database harness', () => {
  let database: IsolatedTestDatabase;

  beforeAll(async () => {
    database = await createIsolatedTestDatabase({ repoRoot, schemaPath });
  }, 180000);

  afterAll(() => database?.cleanup());

  it('creates a unique migrated target under the approved temporary directory', async () => {
    expect(database.directory.startsWith(join(tmpdir(), 'resus-isolated-integration-tests'))).toBe(true);
    expect(database.databasePath).toBe(join(database.directory, 'integration.sqlite'));
    expect(database.databaseUrl).toBe(`file:${database.databasePath.replace(/\\/g, '/')}`);
    expect(existsSync(database.databasePath)).toBe(true);
    expect(database.databasePath).not.toBe(resolve(prismaDir, 'dev.db'));
    const relativeToRepository = relative(repoRoot, database.databasePath);
    expect(isAbsolute(relativeToRepository) || relativeToRepository.startsWith('..')).toBe(true);

    const second = await createIsolatedTestDatabase({ repoRoot, schemaPath });
    try {
      expect(second.databasePath).not.toBe(database.databasePath);
      expect(second.directory).not.toBe(database.directory);
    } finally {
      second.cleanup();
      expect(existsSync(second.databasePath)).toBe(false);
      second.cleanup();
    }
  }, 180000);

  it('rejects pre-existing, repository and named development database paths', () => {
    const protectedPaths = [
      resolve(prismaDir, 'dev.db'),
      resolve(prismaDir, 'test-events.db'),
      resolve(prismaDir, 'test-module12.db'),
      resolve(repoRoot, 'outside-the-approved-temp-root.sqlite'),
    ];
    for (const path of protectedPaths) {
      expect(() => assertDatabaseUrlMatches(`file:${path.replace(/\\/g, '/')}`, database.databasePath)).toThrow();
    }
  });

  it('does not remove a sibling database file it does not own', async () => {
    const other = await createIsolatedTestDatabase({ repoRoot, schemaPath });
    const unownedPath = join(dirname(other.directory), `unowned-${Date.now()}.sqlite`);
    const fd = openSync(unownedPath, 'wx');
    closeSync(fd);
    try {
      other.cleanup();
      expect(existsSync(other.databasePath)).toBe(false);
      expect(existsSync(unownedPath)).toBe(true);
    } finally {
      if (existsSync(unownedPath)) unlinkSync(unownedPath);
      other.cleanup();
    }
  }, 180000);

  it('restores the configured database target and fails closed when setup cannot validate the schema', async () => {
    const before = process.env.DATABASE_URL;
    await expect(createIsolatedTestDatabase({
      repoRoot,
      schemaPath: resolve(repoRoot, 'missing-test-schema.prisma'),
    })).rejects.toThrow('Prisma CLI or schema is unavailable');
    expect(process.env.DATABASE_URL).toBe(before);
  });

  it('forces all automatic behaviors off in test configuration', () => {
    for (const key of autoSettingKeys) expect(process.env[key]).toBe('false');
    expect(process.env.MODULE8_PROVIDER).toBe('mock');
    // Confirm a test setup failure cannot fall back to this or any app default.
    expect(database.databaseUrl).toBe(process.env.DATABASE_URL);
  });
});
