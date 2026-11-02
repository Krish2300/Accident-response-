import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

const approvedRoot = resolve(tmpdir(), 'resus-isolated-integration-tests');
const ownerMarkerName = '.resus-test-db-owner.json';
const sqliteSidecars = ['', '-journal', '-wal', '-shm'];
const safeAutomationEnvironment = {
  MODULE8_PROVIDER: 'mock',
  MODULE6_AUTO_DISPATCH_ENABLED: 'false',
  MODULE6_AUTO_DISPATCH_SIMULATION: 'false',
  MODULE7_AUTO_SELECT_ENABLED: 'false',
  MODULE7_AUTO_SELECT_SIMULATION: 'false',
  MODULE8_AUTO_ROUTE_ENABLED: 'false',
  MODULE8_AUTO_ROUTE_SIMULATION: 'false',
  MODULE9_CORRIDOR_ENABLED: 'false',
  MODULE9_CORRIDOR_SIMULATION: 'false',
} as const;

interface OwnerMarker {
  version: 1;
  ownerId: string;
  directory: string;
  databasePath: string;
  fileDevice: number | null;
  fileInode: number | null;
}

export interface IsolatedTestDatabase {
  readonly directory: string;
  readonly databasePath: string;
  readonly databaseUrl: string;
  readonly cleanup: () => void;
}

const cleanedOwners = new Set<string>();

/**
 * Creates, migrates, and owns one SQLite database under an approved OS-temp
 * root. No caller-provided database URL is accepted or used as a fallback.
 */
export async function createIsolatedTestDatabase(options: {
  repoRoot: string;
  schemaPath: string;
}): Promise<IsolatedTestDatabase> {
  const root = ensureApprovedRoot();
  const directory = realpathSync(mkdtempPath(root));
  const ownerId = randomUUID();
  const databasePath = resolve(directory, 'integration.sqlite');
  const markerPath = join(directory, ownerMarkerName);
  const previousEnvironment = captureEnvironment();
  let createdDb = false;
  let ownerMarker: OwnerMarker | undefined;
  let cleaned = false;

  const cleanup = () => {
    if (cleaned || cleanedOwners.has(ownerId)) return;
    verifyOwnedDatabase({ root, directory, markerPath, databasePath, ownerId, ownerMarker });
    const entries = readdirSync(directory);
    const permitted = new Set([ownerMarkerName, ...sqliteSidecars.map((suffix) => `integration.sqlite${suffix}`)]);
    const unexpected = entries.filter((entry) => !permitted.has(entry));
    if (unexpected.length > 0) {
      throw new Error(`Refusing isolated test database cleanup: unexpected files are present in the owned directory.`);
    }
    for (const suffix of sqliteSidecars) {
      const file = `${databasePath}${suffix}`;
      if (existsSync(file)) {
        const stat = lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink()) {
          throw new Error('Refusing isolated test database cleanup: a database artifact is not a regular file.');
        }
        unlinkSync(file);
      }
    }
    unlinkSync(markerPath);
    rmdirSync(directory);
    cleaned = true;
    cleanedOwners.add(ownerId);
    restoreEnvironment(previousEnvironment);
  };

  try {
    assertWithinRoot(root, directory);
    const markerFd = openSync(markerPath, 'wx');
    closeSync(markerFd);
    ownerMarker = {
      version: 1,
      ownerId,
      directory,
      databasePath,
      fileDevice: null,
      fileInode: null,
    };
    writeFileSync(markerPath, JSON.stringify(ownerMarker), { flag: 'w' });

    // Exclusive creation proves this harness created the exact target.
    const databaseFd = openSync(databasePath, 'wx');
    closeSync(databaseFd);
    createdDb = true;
    const initialIdentity = statSync(databasePath);
    ownerMarker = { ...ownerMarker, fileDevice: initialIdentity.dev, fileInode: initialIdentity.ino };
    writeFileSync(markerPath, JSON.stringify(ownerMarker), { flag: 'w' });
    initializeEmptySqlite(databasePath);
    const identity = statSync(databasePath);
    if (identity.dev !== ownerMarker.fileDevice || identity.ino !== ownerMarker.fileInode) {
      throw new Error('Refusing test migration: the SQLite initializer replaced the owned target file.');
    }

    const databaseUrl = sqliteUrl(databasePath);
    assertDatabaseUrlMatches(databaseUrl, databasePath);
    setTestEnvironment(databaseUrl);

    const prismaCli = resolve(options.repoRoot, 'node_modules/prisma/build/index.js');
    if (!existsSync(prismaCli) || !existsSync(options.schemaPath)) {
      throw new Error('Prisma CLI or schema is unavailable; isolated migrations were not run.');
    }
    execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy', '--schema', options.schemaPath], {
      cwd: options.repoRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl, ...safeAutomationEnvironment },
      stdio: 'pipe',
    });

    // Recheck that migration did not replace the owned file with another path.
    verifyOwnedDatabase({ root, directory, markerPath, databasePath, ownerId, ownerMarker });
    return Object.freeze({ directory, databasePath, databaseUrl, cleanup });
  } catch (error) {
    try {
      if (ownerMarker) {
        if (createdDb) cleanup();
        else {
          const onDisk = JSON.parse(readFileSync(markerPath, 'utf8')) as OwnerMarker;
          if (onDisk.ownerId === ownerId && onDisk.directory === directory) {
            unlinkSync(markerPath);
            rmdirSync(directory);
            restoreEnvironment(previousEnvironment);
          }
        }
      } else if (readdirSync(directory).length === 0) {
        rmdirSync(directory);
      }
    } catch {
      // Keep failed setup artifacts when their ownership cannot be proven.
    }
    throw error;
  }
}

/** Rejects any URL except the exact database path issued by this run's handle. */
export function assertDatabaseUrlMatches(databaseUrl: string, ownedDatabasePath: string): void {
  const requestedPath = sqlitePathFromUrl(databaseUrl);
  if (!isAbsolute(requestedPath) || resolve(requestedPath) !== resolve(ownedDatabasePath)) {
    throw new Error('Refusing test database URL that does not exactly match the owned disposable target.');
  }
  if (['dev.db', 'test-events.db', 'test-module12.db'].includes(basename(requestedPath).toLowerCase())) {
    throw new Error('Refusing a protected development or fixed-path test database.');
  }
}

/** Uses identity and marker checks before deleting any harness-owned artifacts. */
function verifyOwnedDatabase(args: {
  root: string;
  directory: string;
  markerPath: string;
  databasePath: string;
  ownerId: string;
  ownerMarker?: OwnerMarker;
}): void {
  const realDirectory = realpathSync(args.directory);
  assertWithinRoot(args.root, realDirectory);
  const onDisk = JSON.parse(readFileSync(args.markerPath, 'utf8')) as OwnerMarker;
  if (
    onDisk.version !== 1 || onDisk.ownerId !== args.ownerId ||
    onDisk.directory !== realDirectory || onDisk.databasePath !== args.databasePath ||
    args.ownerMarker?.ownerId !== args.ownerId ||
    args.ownerMarker.fileDevice !== onDisk.fileDevice || args.ownerMarker.fileInode !== onDisk.fileInode
  ) {
    throw new Error('Refusing isolated test database operation: ownership marker does not match this run.');
  }
  assertDatabaseUrlMatches(sqliteUrl(args.databasePath), args.databasePath);
  const dbStat = lstatSync(args.databasePath);
  if (!dbStat.isFile() || dbStat.isSymbolicLink() || dbStat.dev !== onDisk.fileDevice || dbStat.ino !== onDisk.fileInode) {
    throw new Error('Refusing isolated test database operation: database file identity changed.');
  }
}

function ensureApprovedRoot(): string {
  mkdirSync(approvedRoot, { recursive: true });
  const root = realpathSync(approvedRoot);
  if (root !== resolve(approvedRoot)) throw new Error('Refusing test setup: approved temporary directory resolved unexpectedly.');
  return root;
}

function mkdtempPath(root: string): string {
  return mkdtempSync(join(root, 'run-'));
}

function initializeEmptySqlite(databasePath: string): void {
  const script = [
    'import json, sqlite3, sys',
    'db = sqlite3.connect(sys.argv[1])',
    'integrity = db.execute("PRAGMA integrity_check").fetchone()[0]',
    'tables = db.execute("SELECT name FROM sqlite_master WHERE type = \'table\'").fetchall()',
    'print(json.dumps({"integrity": integrity, "tables": tables}))',
    'db.close()',
    'assert integrity == "ok" and len(tables) == 0',
  ].join('; ');
  const output = execFileSync('python', ['-c', script, databasePath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const result = JSON.parse(output.trim()) as { integrity?: string; tables?: unknown[] };
  if (result.integrity !== 'ok' || !Array.isArray(result.tables) || result.tables.length !== 0) {
    throw new Error('Refusing test migration: target was not verified as an empty SQLite database.');
  }
}

function sqliteUrl(databasePath: string): string {
  return `file:${databasePath.replace(/\\/g, '/')}`;
}

function sqlitePathFromUrl(databaseUrl: string): string {
  if (!databaseUrl.startsWith('file:') || databaseUrl.includes('?') || databaseUrl.includes('#')) {
    throw new Error('Refusing non-SQLite or ambiguous test database URL.');
  }
  return resolve(databaseUrl.slice('file:'.length).replace(/\//g, sep));
}

function assertWithinRoot(root: string, target: string): void {
  const relativePath = relative(root, target);
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error('Refusing test database path outside the approved temporary root.');
  }
}

const environmentKeys = ['DATABASE_URL', ...Object.keys(safeAutomationEnvironment)];
type CapturedEnvironment = Record<string, string | undefined>;

function captureEnvironment(): CapturedEnvironment {
  return Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
}

function setTestEnvironment(databaseUrl: string): void {
  process.env.DATABASE_URL = databaseUrl;
  Object.assign(process.env, safeAutomationEnvironment);
}

function restoreEnvironment(environment: CapturedEnvironment): void {
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
