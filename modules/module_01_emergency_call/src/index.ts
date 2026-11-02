/**
 * Module 1 — emergency call interface.
 *
 * Public surface only.
 *
 * Application code reaches telephony through the `TelephonyProvider` port, not
 * through a carrier implementation. The Asterisk pieces are exported anyway, for
 * two reasons that do not break that rule: the composition root has to check
 * which adapter it was handed (`instanceof`) before starting the AMI session and
 * the media port, and the wire codec and framing are protocol definitions that
 * tests and operators legitimately need to inspect.
 */
export {
  Module1,
  type Module1Deps,
  createTelephonyProvider,
} from './module.js';
export {
  loadModule1Config,
  type Module1Config,
  type TelephonyProviderName,
  type AsteriskConfig,
} from './config.js';
export { CallService, type CallSessionStore, type EmergencyStore } from './callService.js';
export type { OpenCallInput, OpenCallResult, CloseCallResult } from './callService.js';
export { LoopbackTelephonyProvider } from './telephony/loopbackProvider.js';
export {
  AsteriskTelephonyProvider,
  type AsteriskProviderConfig,
  type AsteriskCallRegistry,
  type AsteriskIntakeTelephony,
} from './telephony/asteriskProvider.js';
export type { AmiEvent, AmiClientPort } from './telephony/asterisk/amiClient.js';
export { parseAmiBuffer, parseAmiMessage, serializeAmiAction, type AmiFields, type AmiMessage } from './telephony/asterisk/amiMessage.js';
export { AsteriskCallIntake, type AsteriskIntakeConfig, type AsteriskIntakeCalls } from './telephony/asteriskIntake.js';
export { AudioSocketServer, type AudioSocketSession, type AudioFrame } from './telephony/asterisk/audioSocket.js';
export {
  AudioBridge,
  type AudioBridgeConfig,
  type AudioBridgeDeps,
  type AudioBridgeCallStore,
  type AudioBridgeSpeechPort,
  type AudioBridgeConversationPort,
  type ConversationTurn,
} from './telephony/asterisk/audioBridge.js';