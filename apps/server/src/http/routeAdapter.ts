import {
  AppError,
  ErrorCode,
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
  setValidatorCompiler?<T>(
    compiler: (opts: { schema: unknown; method?: string; url?: string }) => ValidatorHandler<T>,
  ): void;
  route(config: {
    method: RouteDefinition['method'];
    url: string;
    schema?: Record<string, unknown>;
    handler: (request: unknown, reply: unknown) => Promise<void>;
  }): void;
}

type ValidatorHandler<T> = (data: unknown) => { value: T } | { error: Error };

/**
 * Compiles the zod schemas that modules declare into Fastify validators.
 *
 * Without this, Fastify's default AJV compiler receives a `ZodObject`, which is
 * not a JSON Schema: the declared validation would never run, and a route would
 * accept whatever it was sent. That is not hypothetical — before this compiler
 * existed, every `body`, `params` and `query` schema in the system was inert, and
 * the only validation actually happening was whatever a service threw as an
 * `AppError` from inside its handler.
 *
 * Errors are raised as `AppError` so they pass through the server's error
 * handler and come back in the same `{ error: { code, message, details } }`
 * envelope as every other failure, rather than Fastify's own validation shape.
 */
function zodValidatorCompiler<T>(opts: { schema: unknown }): ValidatorHandler<T> {
  const schema = opts.schema as { safeParse?: (data: unknown) => unknown } | undefined;

  // Fastify also compiles schemas of its own (for the websocket route's
  // querystring). Anything that is not a zod schema is passed through untouched
  // rather than rejected, so those keep working.
  if (!schema || typeof schema.safeParse !== 'function') {
    return (data: unknown) => ({ value: data as T });
  }

  return (data: unknown) => {
    const result = (
      schema.safeParse as (input: unknown) => { success: true; data: unknown } | { success: false; error: { issues: unknown[] } }
    )(data);

    if (result.success) return { value: result.data as T };

    return {
      error: AppError.validation('The request did not match the expected shape.', {
        issues: result.error.issues,
      }),
    };
  };
}

export function registerRoutes(
  fastify: RouteRegistrar,
  routes: RouteDefinition<any>[],
  options: RouteAdapterOptions,
): RegisteredRoutes {
  const modules = new Set<string>();

  // Registered before any route so every schema below is compiled by zod.
  fastify.setValidatorCompiler?.(zodValidatorCompiler);

  for (const route of routes) {
    modules.add(route.module);
    // Every schema lives on the framework-agnostic route, so validation is
    // declared once and reused by tests and the generated API index.
    //
    // They must be nested under `schema`, not passed as the `body` / `params` /
    // `querystring` shorthands. In Fastify 5 those shorthands are accepted but do
    // NOT register a validation schema, so a request was validated by nothing at
    // all: an obviously invalid body returned 200. Nesting under `schema` is what
    // actually causes the zod compiler above to run.
    const schema: Record<string, unknown> = {};
    if (route.params) schema.params = route.params;
    if (route.query) schema.querystring = route.query;
    if (route.body) schema.body = route.body;

    fastify.route({
      method: route.method,
      url: route.url,
      ...(Object.keys(schema).length > 0 ? { schema } : {}),
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