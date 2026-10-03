/**
 * Framework-agnostic HTTP contract.
 *
 * Modules declare routes as data. `apps/server` adapts them to Fastify and
 * performs schema validation, authentication and error serialisation. This is
 * what lets four modules share exactly one HTTP server without any of them
 * importing the web framework.
 */
import type { ZodTypeAny } from 'zod';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface AuthContext {
  userId: string;
  role: string;
  email: string;
}

export interface HttpRequest<C = unknown> {
  params: Record<string, string>;
  query: Record<string, unknown>;
  body: C;
  headers: Record<string, unknown>;
  /** Present when the route is authenticated. */
  user?: AuthContext;
  server: { now(): Date };
}

export interface HttpReply<T = unknown> {
  status(code: number): HttpReply<T>;
  header(name: string, value: string): HttpReply<T>;
  send(payload: T): void;
}

export interface RouteAuth {
  /** Route is reachable without a token (health, public caller APIs). */
  public?: boolean;
  /** Roles allowed to call it. Empty/absent means "any authenticated user". */
  roles?: string[];
}

export interface RouteDefinition<Body = unknown> {
  method: HttpMethod;
  url: string;
  /** Short description used by the generated API index. */
  summary: string;
  /** Owning module, e.g. `module_06`. Surfaced in the API index. */
  module: string;
  auth?: RouteAuth;
  body?: ZodTypeAny;
  params?: ZodTypeAny;
  query?: ZodTypeAny;
  handler(request: HttpRequest<Body>, reply: HttpReply): Promise<void> | void;
}

export interface RouteRegistrar {
  register(route: RouteDefinition<never> | RouteDefinition<any>): void;
}

export class RouteTable implements RouteRegistrar {
  readonly routes: RouteDefinition<any>[] = [];

  register(route: RouteDefinition<any>): void {
    this.routes.push(route);
  }

  addAll(routes: RouteDefinition<any>[]): void {
    routes.forEach((route) => this.register(route));
  }
}

/** Standard pagination envelope returned by every list endpoint. */
export interface Paginated<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export function paginated<T>(items: T[], total: number, limit: number, offset: number): Paginated<T> {
  return { items, total, limit, offset };
}
