import type { PrismaClient } from '@prisma/client';
import { AppError, createId, userRoleSchema } from '@resus/core';
import { guardDatabase } from '../db/client.js';

export interface UserRecord {
  id: string;
  email: string;
  displayName: string;
  role: string;
  isActive: boolean;
}

export interface UserWithSecret extends UserRecord {
  passwordHash: string;
}

export class UserRepository {
  constructor(private readonly db: PrismaClient) {}

  async create(input: {
    email: string;
    displayName: string;
    passwordHash: string;
    role?: string;
  }): Promise<UserWithSecret> {
    const id = createId('USR');
    const row = await guardDatabase(
      async () =>
        this.db.user.create({
          data: {
            id,
            email: input.email.toLowerCase(),
            displayName: input.displayName,
            passwordHash: input.passwordHash,
            role: userRoleSchema.parse(input.role ?? 'OPERATOR'),
          },
        }),
      'Failed to create user',
    );
    return row as unknown as UserWithSecret;
  }

  async findByEmail(email: string): Promise<UserWithSecret | null> {
    return guardDatabase(async () => {
      const row = await this.db.user.findUnique({ where: { email: email.toLowerCase() } });
      return (row as unknown as UserWithSecret) ?? null;
    }, 'Failed to read user');
  }

  async findById(id: string): Promise<UserRecord | null> {
    return guardDatabase(async () => {
      const row = await this.db.user.findUnique({ where: { id } });
      if (!row) return null;
      const { passwordHash: _ignored, ...rest } = row;
      return rest as unknown as UserRecord;
    }, 'Failed to read user');
  }

  async list(): Promise<UserRecord[]> {
    return guardDatabase(async () => {
      const rows = await this.db.user.findMany({ orderBy: { createdAt: 'asc' } });
      return rows.map((row) => {
        const { passwordHash: _ignored, ...rest } = row;
        return rest as unknown as UserRecord;
      });
    }, 'Failed to list users');
  }

  async requireById(id: string): Promise<UserRecord> {
    const user = await this.findById(id);
    if (!user) throw AppError.notFound('User', id);
    return user;
  }
}
