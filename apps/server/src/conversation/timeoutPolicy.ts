/**
 * Module 4 — caller-silence retry budget.
 *
 * The protocol engine tells the caller what to do next and waits. It has no
 * concept of *time*: it does not know the caller has stopped answering, and it
 * must not, because a decision that depends on wall-clock silence would be a
 * clinical decision made in the transport layer. This file holds the one piece
 * of state that is genuinely the conversation layer's: how many times the current
 * instruction has already been repeated into a silence.
 *
 * It answers exactly one question, deterministically: *given that the caller has
 * been silent again, should the instruction be repeated, or has the budget run
 * out?* It never decides what to say — the re-prompt is the protocol's own
 * instruction replayed, never text invented here.
 */

export interface SilenceDecisionRetry {
  action: 'REPROMPT';
  /** 1-based count of this silence within the current prompt window. */
  attempt: number;
}

export interface SilenceDecisionEscalate {
  action: 'ESCALATE';
  /** The attempt that exhausted the budget. */
  attempt: number;
}

export type SilenceDecision = SilenceDecisionRetry | SilenceDecisionEscalate;

export class SilenceRetryPolicy {
  private readonly attempts = new Map<string, number>();

  constructor(private readonly retryLimit: number) {
    if (!Number.isInteger(retryLimit) || retryLimit < 0) {
      throw new Error('SilenceRetryPolicy retryLimit must be a non-negative integer.');
    }
  }

  /** How many repeats are allowed before the conversation is escalated. */
  get repeatsAllowed(): number {
    return this.retryLimit;
  }

  /**
   * Records one silent window and returns what to do about it.
   *
   * The first `retryLimit` silences produce a re-prompt; the next one escalates.
   * With `retryLimit = 0` the very first silence escalates, so the feature can be
   * configured to give up immediately.
   */
  registerSilence(callSessionId: string): SilenceDecision {
    const attempt = (this.attempts.get(callSessionId) ?? 0) + 1;
    this.attempts.set(callSessionId, attempt);
    if (attempt <= this.retryLimit) return { action: 'REPROMPT', attempt };
    return { action: 'ESCALATE', attempt };
  }

  /** Clears the budget because the caller answered: the next silence starts over. */
  reset(callSessionId: string): void {
    this.attempts.delete(callSessionId);
  }

  /** Drops all state for a call that has ended. */
  clear(callSessionId: string): void {
    this.attempts.delete(callSessionId);
  }

  /** Current silent-window count for a call; 0 when the caller is answering. */
  attemptFor(callSessionId: string): number {
    return this.attempts.get(callSessionId) ?? 0;
  }
}
