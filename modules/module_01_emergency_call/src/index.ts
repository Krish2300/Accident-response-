/**
 * Module 1 — emergency call interface.
 *
 * Public surface only. The transport adapter is not re-exported, because callers
 * must go through the `TelephonyProvider` port rather than depend on a specific
 * carrier implementation.
 */
export { Module1, type Module1Deps } from './module.js';
export { loadModule1Config, type Module1Config, type TelephonyProviderName } from './config.js';
export { CallService, type CallSessionStore, type EmergencyStore } from './callService.js';
export type { OpenCallInput, OpenCallResult, CloseCallResult } from './callService.js';
export { LoopbackTelephonyProvider } from './telephony/loopbackProvider.js';