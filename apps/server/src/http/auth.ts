import bcrypt from 'bcryptjs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AuthContext } from '@resus/core';
import { AppError, ErrorCode } from '@resus/core';
import type { UserRepository } from '@resus/data';

/**
 * JWT issuing and verification.
 *
 * The auth path is deliberately small: bcrypt for password verification, JWT for
 * the token. There is no refresh-token machinery, because there is no production
 * deployment of this system yet and adding it would be speculative.
 */

/** Minimal identity fields needed to mint a token; avoids leaking record shape. */
interface AuthRecord {
  id: string;
  email: string;
  role: string;
  displayName?: string | null;
}

export class AuthService {
  private readonly secret: string;
  private readonly expiresIn: string;

  constructor(
    private readonly users: UserRepository,
    private readonly sign: (payload: Record<string, unknown>, secret: string, expiresIn: string) => Promise<string>,
    private readonly verify: (token: string, secret: string) => Promise<Record<string, unknown>>,
    secret: string,
    expiresIn: string,
    private readonly allowDevelopmentToken = false,
  ) {
    this.secret = secret;
    this.expiresIn = expiresIn;
  }

  /** True only when NODE_ENV=development; gates the dev-token route. */
  developmentTokenEnabled(): boolean {
    return this.allowDevelopmentToken;
  }

  async login(email: string, password: string): Promise<{ token: string; user: AuthContext }> {
    const record = await this.users.findByEmail(email);
    // Compare against a dummy hash when the user does not exist, so a missing
    // account and a wrong password take the same amount of time.
    const hash = record?.passwordHash ?? '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv';
    const valid = await bcrypt.compare(password, hash);

    if (!record || !valid || !record.isActive) {
      throw new AppError(ErrorCode.UNAUTHORIZED, 'Invalid email or password.', 401);
    }

    return this.issue(record);
  }

  /**
   * Development-only credential bootstrap.
   *
   * A fresh checkout has no users and no seed yet, so there would otherwise be
   * no way to reach any authenticated endpoint. This mints a local operator
   * token on request, without persisting an account. It is refused outright
   * unless NODE_ENV is development, so it can never be reachable in production.
   */
  async developmentToken(email: string): Promise<{ token: string; user: AuthContext }> {
    if (!this.allowDevelopmentToken) {
      throw new AppError(
        ErrorCode.FORBIDDEN,
        'Development tokens are only available when NODE_ENV=development.',
        403,
      );
    }

    const existing = await this.users.findByEmail(email);
    if (existing?.isActive) {
      return this.issue({
        id: existing.id,
        email: existing.email,
        role: existing.role,
        displayName: existing.displayName ?? undefined,
      });
    }

    return this.issue({
      id: `USR_DEV_${email.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
      email: email.toLowerCase(),
      role: 'ADMIN',
      displayName: 'Development Operator',
    });
  }

  private async issue(record: AuthRecord): Promise<{
    token: string;
    user: AuthContext;
  }> {
    const token = await this.sign(
      { sub: record.id, email: record.email, role: record.role, name: record.displayName },
      this.secret,
      this.expiresIn,
    );
    return { token, user: { userId: record.id, email: record.email, role: record.role } };
  }

  /** Resolves the bearer token on a request, or null when absent/invalid. */
  async authenticate(request: FastifyRequest): Promise<AuthContext | null> {
    const header = request.headers.authorization;
    if (!header || !header.toLowerCase().startsWith('bearer ')) return null;

    try {
      const claims = await this.verify(header.slice(7).trim(), this.secret);
      const userId = String(claims.sub ?? '');
      if (!userId) return null;
      return { userId, role: String(claims.role ?? 'OPERATOR'), email: String(claims.email ?? '') };
    } catch {
      return null;
    }
  }
}

export function registerAuthRoutes(fastify: FastifyInstance, auth: AuthService): void {
  fastify.post('/api/auth/login', async (request, reply) => {
    const body = (request.body ?? {}) as { email?: string; password?: string };
    if (!body.email || !body.password) {
      return reply.status(422).send({
        error: { code: 'VALIDATION_ERROR', message: 'email and password are required.' },
      });
    }
    return reply.send(await auth.login(body.email, body.password));
  });

  fastify.get('/api/auth/me', async (request, reply) => {
    const user = await auth.authenticate(request);
    if (!user) {
      return reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: 'No valid token.' } });
    }
    return reply.send(user);
  });

  /**
   * Development-only token mint. Returns 404 unless NODE_ENV=development, so the
   * endpoint does not merely fail auth — it is not there at all in production.
   */
  if (auth.developmentTokenEnabled()) {
    fastify.post('/api/auth/dev-token', async (request, reply) => {
      const body = (request.body ?? {}) as { email?: string };
      const email = body.email ?? 'operator@resus.local';
      return reply.send(await auth.developmentToken(email));
    });
  }
}