/**
 * Protocol turn orchestration port (Module 5).
 *
 * Module 5's engine is the sole clinical decision-maker: it decides what the
 * protocol does next and produces the authoritative instruction. Everything
 * that is *not* a clinical decision — persisting the caller's words into the
 * call transcript, persisting the spoken reply, and synthesising that reply
 * into audio — is orchestration, and it belongs to whoever owns the call
 * session and the speech service (the server composition root).
 *
 * This port lets the composition root inject that orchestration around
 * Module 5's decision without Module 5 taking a dependency on Module 11
 * (persistence) or Module 2 (speech). The orchestrator wraps the turn; it
 * never replaces it. When no orchestrator is wired (unit tests, protocol-only
 * sessions), the route calls `sessions.handleUtterance` directly and nothing
 * about the clinical decision changes.
 *
 * Why a port and not a second engine: a second decision path would be a second
 * place a protocol could advance, escalate or ask — a divergence waiting to
 * happen. The orchestrator receives `decide`, calls it exactly once, and
 * returns its result untouched. It cannot invent a step, change a threshold or
 * talk a bystander past an escalation, because it never makes a decision.
 */
import type { SessionTurn } from './sessionService.js';

export interface ProtocolTurnOrchestrator {
  /**
   * Runs one caller turn with full orchestration around Module 5's decision.
   *
   * The contract is deliberately narrow:
   *
   *  - `decide` is Module 5's authoritative `handleUtterance`. The orchestrator
   *    must call it exactly once and return its result. It must not catch a
   *    rejection from `decide` and substitute its own turn — a failed clinical
   *    decision is a failed turn, not a turn the orchestrator gets to invent.
   *  - Transcript persistence and TTS are best-effort from the orchestrator's
   *    point of view: a transcript write failure or a synthesis failure is
   *    logged and swallowed so the caller still hears the protocol's decision,
   *    but it must never change the decision or the turn's fields.
   *  - When no live call session is bound to the emergency, the orchestrator
   *    skips transcript and TTS and still returns the decision — a protocol-only
   *    HTTP session has no call to persist against and nothing to speak into.
   */
  orchestrateTurn(input: {
    sessionId: string;
    utterance: string;
    /** Module 5's authoritative decision. Call exactly once; return untouched. */
    decide: () => Promise<SessionTurn>;
  }): Promise<SessionTurn>;
}
