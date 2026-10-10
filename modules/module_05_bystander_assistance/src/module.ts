import { RouteTable, noopLogger, type Logger, type ProtocolSessionPort, type RouteDefinition } from '@resus/core';
import { loadModule5Config, type Module5Config } from './config.js';
import { createModule5Routes } from './api/routes.js';
import { LlmGateway, createDefaultRegistry } from './llm/llmService.js';
import { closedFactValues, type LLMService } from './llm/contracts.js';
import { ProtocolLoader } from './protocol_engine/protocolLoader.js';
import { ProtocolEngine } from './protocol_engine/engine.js';
import { ProtocolSessionService } from './session/sessionService.js';

export interface Module5Deps {
  /** Implemented by Module 11. */
  sessions: ProtocolSessionPort;
  config?: Module5Config;
  logger?: Logger;
  /**
   * Additional providers registered after the configured one.
   *
   * Used by tests to substitute a deterministic stub. Production wiring passes
   * nothing: the provider is chosen by configuration, never by injection, so a
   * deployed build cannot be silently pointed at a different model.
   */
  providers?: LLMService[];
}

/**
 * Module 5 composition root.
 *
 * Wires the catalogue loader, the deterministic engine, the LLM gateway and the
 * session persistence port together. No framework, no database client and no
 * HTTP server is referenced here — the ports come in from outside.
 */
export class Module5 {
  readonly engine: ProtocolEngine;
  readonly loader: ProtocolLoader;
  readonly llm: LlmGateway;
  readonly sessions: ProtocolSessionService;
  readonly config: Module5Config;
  private readonly logger: Logger;

  constructor(deps: Module5Deps) {
    this.config = deps.config ?? loadModule5Config();
    this.logger = deps.logger ?? noopLogger;

    this.loader = new ProtocolLoader(this.config.protocol.directory);
    this.engine = new ProtocolEngine(
      this.loader,
      undefined,
      this.config.clarificationLimit,
      closedFactValues(),
    );
    const registry = createDefaultRegistry(this.config.llm, deps.providers ?? []);
    this.llm = new LlmGateway(registry, this.config.llm, this.logger);
    this.sessions = new ProtocolSessionService(this.engine, this.llm, deps.sessions, this.logger);
  }

  /** Fail fast on a malformed catalogue rather than at first call. */
  async preload(): Promise<{ protocols: number; steps: number }> {
    const protocols = this.loader.list();
    const steps = protocols.reduce((total, p) => total + this.loader.get(p.protocolId, p.version).steps.length, 0);
    return { protocols: protocols.length, steps };
  }

  routes(): RouteDefinition<any>[] {
    return createModule5Routes(this);
  }

  register(table: RouteTable): void {
    table.addAll(this.routes());
  }
}
