import { noopLogger, type Logger, type RouteTable, type SpeechProvider, type TextToSpeechProvider } from '@resus/core';
import { loadModule2Config, type Module2Config } from './config.js';
import { SpeechService, type CallSessionStore } from './speechService.js';
import { createModule2Routes } from './api/routes.js';
import { LoopbackSpeechProvider, LoopbackSynthesisProvider } from './providers/loopbackProviders.js';
import { WhisperSpeechProvider } from './providers/whisperProvider.js';
import { EspeakSynthesisProvider } from './providers/espeakProvider.js';

/**
 * Builds the recogniser named by configuration.
 *
 * Kept out of the constructor so the choice is testable without a whisper
 * install: `whisper` is the only branch that reaches an external binary, and it
 * must be possible to prove that asking for it produces a provider with
 * `isLive: true`.
 *
 * The engine paths come from `config.speech.real`, which is only populated when a
 * real provider was selected — so a misconfigured build fails once, here, naming
 * the missing variable, instead of at the first emergency call.
 */
export function createSpeechProvider(config: Module2Config, logger: Logger): SpeechProvider {
  if (config.speech.provider === 'whisper') {
    const real = config.speech.real;
    if (!real) {
      throw new Error(
        'SPEECH_PROVIDER="whisper" needs WHISPER_CPP_BINARY and WHISPER_CPP_MODEL; neither could be resolved.',
      );
    }
    return new WhisperSpeechProvider({
      binary: real.whisper.binary,
      model: real.whisper.model,
      threads: real.whisper.threads,
      language: real.whisper.language,
      timeoutMs: config.speech.timeoutMs,
      logger,
    });
  }
  return new LoopbackSpeechProvider();
}

/** Mirror of `createSpeechProvider` for the synthesiser. */
export function createSynthesisProvider(config: Module2Config, logger: Logger): TextToSpeechProvider {
  if (config.speech.synthesisProvider === 'espeak') {
    const real = config.speech.real;
    if (!real) {
      throw new Error('SPEECH_SYNTHESIS_PROVIDER="espeak" needs its engine configuration to be resolvable.');
    }
    return new EspeakSynthesisProvider({
      binary: real.espeak.binary,
      voice: real.espeak.voice,
      speedWpm: real.espeak.speedWpm,
      timeoutMs: config.speech.timeoutMs,
      logger,
    });
  }
  return new LoopbackSynthesisProvider();
}

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
    this.recognitionProvider = deps.speech ?? createSpeechProvider(this.config, this.logger);
    this.synthesisProvider = deps.synthesis ?? createSynthesisProvider(this.config, this.logger);
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