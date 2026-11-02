/**
 * P2 live-deployment demo-account provisioning (least-privilege, idempotent).
 *
 * Uses the repository's supported account-provisioning path — the same
 * `module11.users.create` + bcrypt route that `db:seed` (seed.ts) and
 * `scripts/demo-server.ts` use. There is no open registration endpoint by
 * design; accounts are provisioned through the application's own repository.
 *
 * Usage (from the deployment root, where .env provides DATABASE_URL):
 *   DEMO_DISPATCHER_EMAIL=... DEMO_DRIVER_EMAIL=... \
 *     DEMO_DISPATCHER_PASSWORD=... DEMO_DRIVER_PASSWORD=... \
 *     npx tsx scripts/provision-demo-accounts.ts create
 *   npx tsx scripts/provision-demo-accounts.ts cleanup
 *
 * Contract:
 *   - `create` requires both *_PASSWORD environment variables (>= 12 chars).
 *     No password default exists; the script refuses weak/absent credentials
 *     and never prints a password, hash or token.
 *   - Optional email variables select new, dedicated identities; roles remain
 *     fixed to DISPATCHER and DRIVER. Defaults are retained for existing setups.
 *   - Emails/roles of created accounts are printed; that is all.
 *   - Idempotent by email: re-running never duplicates or overwrites an
 *     existing account and never modifies any other record.
 *   - `cleanup` deactivates exactly these two demo accounts (isActive=false),
 *     which the login path rejects with the same 401 as bad credentials.
 *     It never deletes rows, preserving referential history.
 */
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { createModule11 } from '../modules/module_11_database_event_system/src/module.js';
import { getPrismaClient } from '../modules/module_11_database_event_system/src/db/client.js';

type Mode = 'create' | 'cleanup';

const mode = process.argv[2] as Mode | undefined;
if (mode !== 'create' && mode !== 'cleanup') {
  console.error('[provision] usage: provision-demo-accounts.ts <create|cleanup>');
  process.exit(1);
}

function configuredEmail(key: string, fallback: string): string {
  const email = process.env[key]?.trim().toLowerCase() || fallback;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error(`${key} must be a valid email address.`);
  }
  return email;
}

const TARGETS = [
  { key: 'DEMO_DISPATCHER', email: configuredEmail('DEMO_DISPATCHER_EMAIL', 'dispatcher@resus.local'), displayName: 'Demo Dispatcher', role: 'DISPATCHER' },
  { key: 'DEMO_DRIVER', email: configuredEmail('DEMO_DRIVER_EMAIL', 'driver@resus.local'), displayName: 'Demo Driver', role: 'DRIVER' },
] as const;

const db = getPrismaClient();
const module11 = createModule11({ db, ownsClient: false });

async function main(): Promise<void> {
  if (mode === 'create') {
    for (const target of TARGETS) {
      const password = process.env[`${target.key}_PASSWORD`];
      if (!password || password.length < 12) {
        console.error(`[provision] ${target.key}_PASSWORD must be set with at least 12 characters; refusing to create ${target.email}.`);
        process.exit(1);
      }
      const existing = await module11.users.findByEmail(target.email);
      if (existing) {
        console.log(`[provision] ${target.role.padEnd(10)} ${target.email} already exists (idempotent skip)`);
        continue;
      }
      await module11.users.create({
        email: target.email,
        displayName: target.displayName,
        passwordHash: bcrypt.hashSync(password, 10),
        role: target.role,
      });
      console.log(`[provision] ${target.role.padEnd(10)} ${target.email} created`);
    }
    return;
  }

  for (const target of TARGETS) {
    const existing = await module11.users.findByEmail(target.email);
    if (!existing) {
      console.log(`[provision] ${target.email} not present (nothing to do)`);
      continue;
    }
    await db.user.update({ where: { id: existing.id }, data: { isActive: false } });
    console.log(`[provision] ${target.role.padEnd(10)} ${target.email} deactivated (login now rejected)`);
  }
}

main()
  .catch((error: unknown) => {
    console.error('[provision] failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
