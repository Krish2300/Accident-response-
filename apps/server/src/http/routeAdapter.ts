import {
  isAppError,
  type AuthContext,
  type HttpReply,
  type HttpRequest,
  type RouteDefinition,
} from '@resus/core';

/**
 * Adapts the framework-agnostic `RouteDefinition` contract onto Fastify.
 *
 * This is the only file in the repository that knows both `@resus/core`'s route
 * shape and Fastify's. Modules declare routes as plain data; the composition root
 * performs validation, authentication and error serialisation uniformly, so no
 * module has to remember to do it.
 */

export interface RouteAdapterOptions {
  /** Returns the authenticated user, or null when the token is absent/invalid. */
  authenticate: (request: HttpRequest) => Promise<AuthContext | null>;
}

export interface RegisteredRoutes {
  count: number;
  modules: string[];
}

/** The minimal Fastify surface the adapter needs; declared for testability. */
export interface RouteRegistrar {
  route(config: {
    method: RouteDefinition['method'];
    url: string;
    params?: unknown;
    querystring?: unknown;
    body?: unknown;
    handler: (request: unknown, reply: unknown) => Promise<void>;
  }): void;
}

export function registerRoutes(
  fastify: RouteRegistrar,
  routes: RouteDefinition<any>[],
  options: RouteAdapterOptions,
): RegisteredRoutes {
  const modules = new Set<string>();

  for (const route of routes) {
    modules.add(route.module);
    // Every schema lives on the framework-agnostic route, so validation is
    // declared once and reused by tests and the generated API index.
    fastify.route({
      method: route.method,
      url: route.url,
      ...(route.params ? { params: route.params } : {}),
      ...(route.query ? { querystring: route.query } : {}),
      ...(route.body ? { body: route.body } : {}),
      handler: buildHandler(route, options) as (request: unknown, reply: unknown) => Promise<void>,
    });
  }

  return { count: routes.length, modules: [...modules].sort() };
}

function buildHandler(route: RouteDefinition<any>, options: RouteAdapterOptions) {
  const isPublic = route.auth?.public === true;
  const allowedRoles = route.auth?.roles ?? [];

  return async (raw: any, reply: any): Promise<void> => {
    try {
      const user = isPublic ? null : await options.authenticate(toHttpRequest(raw));

      // A public route may still accept a valid token; it just does not require one.
      if (!isPublic && !user) {
        return reply.status(401).send({
          error: { code: 'UNAUTHORIZED', message: 'Authentication is required for this endpoint.' },
        });
      }
      if (user && allowedRoles.length > 0 && !allowedRoles.includes(user.role)) {
        return reply.status(403).send({
          error: {
            code: 'FORBIDDEN',
            message: `Role '${user.role}' may not call this endpoint.`,
            allowedRoles,
          },
        });
      }

      const httpReply = toHttpReply(reply);
      await route.handler(
        { ...toHttpRequest(raw), user: user ?? undefined },
        httpReply,
      );
    } catch (error) {
      // Modules throw `AppError`; the framework never sees a raw exception.
      if (isAppError(error)) {
        return reply.status(error.statusCode).send({
          error: { code: error.code, message: error.message, details: error.details ?? null },
        });
      }
      const message = error instanceof Error ? error.message : String(error);
      (raw.log ?? console).error?.({ err: error }, `unhandled error on ${route.method} ${route.url}`);
      return reply.status(500).send({
        error: { code: 'INTERNAL_ERROR', message: 'Unexpected server error.', details: { message } },
      });
    }
  };
}

function toHttpRequest(raw: any): HttpRequest<any> {
  return {
    params: raw.params ?? {},
    query: raw.query ?? {},
    body: raw.body,
    headers: raw.headers ?? {},
    server: { now: () => new Date() },
  };
}

function toHttpReply(reply: any): HttpReply<any> {
  return {
    status(code: number) {
      reply.status(code);
      return this;
    },
    header(name: string, value: string) {
      reply.header(name, value);
      return this;
    },
    send(payload: unknown) {
      reply.send(payload);
    },
  };
}