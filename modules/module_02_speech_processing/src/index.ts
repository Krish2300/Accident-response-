/**
 * Module 2 — speech processing.
 *
 * Public surface only. Provider implementations are exported because tests and
 * the end-to-end demo need to script specific exchanges, but callers should
 * reach them through the `SpeechProvider` / `TextToSpeechProvider` ports rather
 * than depending on the loopback adapter.
 */
export { Module2, type Module2Deps } from './module.js';
export { loadModule2Config, type Module2Config } from './config.js';
export {
  SpeechService,
  type CallSessionStore,
  type TranscribeInput,
  type TranscribeResult,
  type SpeakInput,
  type SpeakResult,
} from './speechService.js';
export {
  LoopbackSpeechProvider,
  LoopbackSynthesisProvider,
  audioCarrier,
  readAudioCarrier,
  type LoopbackSpeechOptions,
  type LoopbackSynthesisOptions,
} from './providers/loopbackProviders.js';