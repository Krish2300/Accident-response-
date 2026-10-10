/**
 * Module 5 — Bystander assistance.
 *
 * Public surface only. Internal layout (catalogue loader, engine internals,
 * provider implementations) is deliberately not re-exported: other modules must
 * use `Module5` and its ports, not reach into the protocol machinery.
 */
export { Module5, type Module5Deps } from './module.js';
export { loadModule5Config, type Module5Config } from './config.js';
export {
  ProtocolSessionService,
  factsFrom,
  MIN_TRUSTED_CONFIDENCE,
  type SessionTurn,
  type StartSessionInput,
  type HandleUtteranceInput,
} from './session/sessionService.js';
export { ProtocolEngine } from './protocol_engine/engine.js';
export type {
  EngineState,
  EngineAction,
  EngineTurnResult,
  EngineAdvance,
  TurnInput,
} from './protocol_engine/engine.js';
export { UNKNOWN, instructionIdFor, questionIdFor, type ProtocolFacts } from './protocol_engine/types.js';
export type {
  ProtocolDecision,
  ProtocolDecisionAudit,
  ProtocolDecisionEscalation,
  ProtocolDecisionType,
  ProtocolInstruction,
  ProtocolQuestionRequirement,
} from './protocol_engine/types.js';
export { LlmGateway, LLMServiceRegistry, createDefaultRegistry } from './llm/llmService.js';
export type { LLMService, LlmHealth, Extraction, Entities, Classification } from './llm/contracts.js';
export { assertSafeRephrasing, type SafetyVerdict } from './llm/safety.js';
