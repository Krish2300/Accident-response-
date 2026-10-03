import {
  noopLogger,
  type Logger,
  type RouteTable,
  type SpeechProvider,
  type TextToSpeechProvider,
} from '@resus/core';
import { loadModule2Config, type Module2Config } from './config.js';
import { SpeechService, type CallSessionStore } from './speechService.js';
import { createModule2Routes } from './api/routes.js';
import { LoopbackSpeechProvider, LoopbackSynthesisProvider } from './providers/loopbackProviders.js';

export interface Module2Deps {
  /** Implemented by Module 11. Module 2 never sees a Prisma client. */
  calls: CallSessionStore;
  events: import('@resus/core').EventPublisherPort;
  config?: Module2Config;
  /**
   * Speech providers.
   *
   * Production wiring passes nothing and both providers are chosen by
   * configuration alone, so a deployed build cannot be pointed at a different
   * vendor by injection. Tests pass stubs to exercise provider failure paths.
   */
  speech?: SpeechProvider;
  synthesis?: TextToSpeechProvider;
  logger?: Logger;
}

/**
 * Module 2 composition root.
 *
 * Wires the speech providers and the transcript store together. Nothing here
 * references Fastify, Prisma or a speech vendor protocol.
 */
export class Module2 {
  readonly speech: SpeechService;
  readonly recognitionProvider: SpeechProvider;
  readonly synthesisProvider: TextToSpeechProvider;
  readonly config: Module2Config;
  private readonly logger: Logger;

  constructor(deps: Module2Deps) {
    this.config = deps.config ?? loadModule2Config();
    this.logger = deps.logger ?? noopLogger;
    this.recognitionProvider = deps.speech ?? new LoopbackSpeechProvider();
    this.synthesisProvider = deps.synthesis ?? new LoopbackSynthesisProvider();
    this.speech = new SpeechService({
      config: this.config,
      speech: this.recognitionProvider,
      synthesis: this.synthesisProvider,
      calls: deps.calls,
      events: deps.events,
      logger: this.logger,
    });
  }

  routes() {
    return createModule2Routes(this.speech);
  }

  register(table: RouteTable): void {
    table.addAll(this.routes());
  }
}