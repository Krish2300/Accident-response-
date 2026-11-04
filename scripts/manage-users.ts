/**
 * Account administration for control-room staff (no open registration exists).
 *
 *   npm run user:add -- --email si.pampa@keralapolice.gov.in --name "SI Pampa CR" --role POLICE_CONTROL_ROOM
 *   npm run user:add -- --email admin@... --name "System admin" --role ADMIN
 *   npm run user:disable -- --email si.pampa@keralapolice.gov.in
 *   npm run user:list
 *
 * A strong random password is generated and printed ONCE on this console
 * (or pass RESUS_NEW_PASSWORD, which must meet the policy: >= 14 characters
 * with upper, lower, digit and symbol). Hashes use bcrypt cost 12. Disabling
 * never deletes the account, so the access audit keeps its history.
 */
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { USER_ROLES } from '@resus/core';
import { createModule11 } from '../modules/module_11_database_event_system/src/module.js';
import { getPrismaClient } from '../modules/module_11_database_event_system/src/db/client.js';

const args = process.argv.slice(2);
const command = args[0];
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

export function passwordProblems(password: string): string[] {
  const problems: string[] = [];
  if (password.length < 14) problems.push('at least 14 characters');
  if (!/[a-z]/.test(password)) problems.push('a lowercase letter');
  if (!/[A-Z]/.test(password)) problems.push('an uppercase letter');
  if (!/[0-9]/.test(password)) problems.push('a digit');
  if (!/[^A-Za-z0-9]/.test(password)) problems.push('a symbol');
  return problems;
}

function generatePassword(): string {
  return `Kp-${randomBytes(15).toString('base64url')}-9!`;
}

async function main(): Promise<void> {
  const db = getPrismaClient();
  const module11 = createModule11({ db, ownsClient: false });
  try {
    if (command === 'add') {
      const email = flag('email')?.trim().toLowerCase();
      const name = flag('name')?.trim();
      const role = (flag('role') ?? 'POLICE_CONTROL_ROOM').toUpperCase();
      if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !name) throw new Error('usage: add --email <email> --name "<display name>" [--role POLICE_CONTROL_ROOM|DISPATCHER|OPERATOR|ADMIN|...]');
      if (!(USER_ROLES as readonly string[]).includes(role)) throw new Error(`unknown role ${role}. Allowed: ${USER_ROLES.join(', ')}`);
      if (await module11.users.findByEmail(email)) throw new Error(`an account for ${email} already exists`);
      const supplied = process.env.RESUS_NEW_PASSWORD;
      const password = supplied ?? generatePassword();
      const problems = passwordProblems(password);
      if (problems.length) throw new Error(`password must contain ${problems.join(', ')}`);
      await module11.users.create({ email, displayName: name, role, passwordHash: bcrypt.hashSync(password, 12) });
      console.log(`[users] created ${email} (${role})`);
      if (!supplied) console.log(`[users] one-time password (give it to the officer in person; it is not stored anywhere): ${password}`);
    } else if (command === 'disable') {
      const email = flag('email')?.trim().toLowerCase();
      if (!email) throw new Error('usage: disable --email <email>');
      const result = await db.user.updateMany({ where: { email }, data: { isActive: false } });
      console.log(result.count ? `[users] disabled ${email}` : `[users] no account ${email}`);
    } else if (command === 'list') {
      const users = await db.user.findMany({ select: { email: true, role: true, isActive: true, createdAt: true }, orderBy: { createdAt: 'asc' } });
      for (const u of users) console.log(`${u.isActive ? 'active  ' : 'disabled'}  ${u.role.padEnd(20)} ${u.email}  (since ${u.createdAt.toISOString().slice(0, 10)})`);
    } else {
      throw new Error('usage: manage-users.ts <add|disable|list> ...');
    }
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(`[users] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
