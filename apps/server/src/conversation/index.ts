/**
 * Module 4 — conversation support layer.
 *
 * Exported as one surface so the composition root wires a single `conversation`
 * collaborator into the media bridge rather than several loose pieces.
 */
export {
  InstructionLocalizer,
  type InstructionLocaliser,
  type LocalisationReason,
  type LocalisationRequest,
  type LocalisationResult,
  type TranslationCatalogue,
} from './localizer.js';
export {
  SilenceRetryPolicy,
  type SilenceDecision,
  type SilenceDecisionEscalate,
  type SilenceDecisionRetry,
} from './timeoutPolicy.js';
export {
  ConversationSupportAdapter,
  type ConversationEventSink,
  type ConversationSupportConfig,
  type ConversationSupportDeps,
} from './conversationSupport.js';
