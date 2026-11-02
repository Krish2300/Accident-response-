import { noopLogger, type Logger, type SystemEventEnvelope } from '@resus/core';
import type { AudioBridgeConversationPort, ConversationTurn } from '@resus/call';
import { SilenceRetryPolicy } from './timeoutPolicy.js';

/**
 * Module 4 — conversation support.
 *
 * A thin decorator over the Asterisk conversation controller (over Module 5). It
 * adds the two responsibilities the intended Module 4 owns but which the
 * disconnected Python CLI never provided at the protocol layer:
 *
 *   - the caller-silence retry budget: when the caller stops answering, repeat the
 *     protocol's own current instruction a bounded number of times and then hand
 *     the conversation to the operator; and
 *   - the conversation-layer events (`CONVERSATION_TIMED_OUT`,
 *     `CONVERSATION_ESCALATED`) that mark those transitions on the timeline.
 *
 * It is deliberately a passthrough for everything else: connect and utterance
 * turns are forwarded verbatim, so Module 5 remains the sole authority on what is
 * said. The re-prompt is the last authoritative turn replayed — the adapter never
 * composes, translates or changes clinical text, and it never selects a question.
 *
 * It does *not* end the call, close the emergency or mark anything escalated:
 * `CONVERSATION_ESCALATED` is a timeline marker that a human is needed, not a
 * status change. The call stays open for the operator, matching the bridge's own
 * policy when a protocol reaches a terminal result.
 */

export interface ConversationEventSink {
  record(
    event: SystemEventEnvelope,
    context?: { emergencyId?: string | null; metadata?: Record<string, unknown> },
  ): Promise<unknown>;
}

export interface ConversationSupportConfig {
  /** Milliseconds the caller may stay silent before a re-prompt is due. */
  silenceTimeoutMs: number;
  /** How many times the current instruction may be repeated before escalation. */
  silenceRetryLimit: number;
}

export interface ConversationSupportDeps {
  /** The underlying conversation, normally the Module 5-backed controller. */
  inner: AudioBridgeConversationPort;
  /** Where `CONVERSATION_*` events are recorded; absence disables them. */
  events?: ConversationEventSink;
  config: ConversationSupportConfig;
  logger?: Logger;
}

interface CallSupportState {
  emergencyId: string;
  language: string;
  /** The last turn the caller actually heard, replayed on a silence. */
  lastTurn: ConversationTurn | null;
  /** Stable identifier of the question that turn asked, for the timeout event. */
  questionId: string | null;
  /** Set once the protocol reaches a terminal turn; no further prompting. */
  terminal: boolean;
  /**
   * Set once the silence budget is spent for this conversation.
   *
   * Sticky: unlike `terminal`, it is never cleared by a later turn, so a caller
   * who talks again after escalation cannot restart automatic prompting. This is
   * the guarantee that a repeated silence can never begin the loop anew.
   */
  escalated: boolean;
}

export class ConversationSupportAdapter implements AudioBridgeConversationPort {
  private readonly logger: Logger;
  private readonly policy: SilenceRetryPolicy;
  private readonly byCall = new Map<string, CallSupportState>();

  constructor(private readonly deps: ConversationSupportDeps) {
    this.logger = deps.logger ?? noopLogger;
    this.policy = new SilenceRetryPolicy(deps.config.silenceRetryLimit);
  }

  async onCallConnected(input: {
    callSessionId: string;
    emergencyId: string;
    language: string;
  }): Promise<ConversationTurn | null> {
    const turn = await this.deps.inner.onCallConnected(input);
    this.remember(input, turn);
    return turn;
  }

  async onCallerUtterance(input: {
    callSessionId: string;
    emergencyId: string;
    language: string;
    text: string;
  }): Promise<ConversationTurn | null> {
    const turn = await this.deps.inner.onCallerUtterance(input);
    this.remember(input, turn);
    return turn;
  }

  /**
   * The caller has been silent since the last prompt.
   *
   * Returns the last authoritative turn again so the caller hears the same
   * reviewed instruction, or `null` once the budget is spent (the operator is
   * notified by the event instead of the caller being prompted forever).
   */
  async onCallerSilence(input: {
    callSessionId: string;
    emergencyId: string;
    language: string;
  }): Promise<ConversationTurn | null> {
    const state = this.byCall.get(input.callSessionId);
    // No prompt is outstanding, the protocol already finished, the conversation has
    // already been escalated, or nothing was ever said: there is nothing to repeat,
    // so stay silent rather than invent a turn. `escalated` is checked first so the
    // budget can never be restarted once it is spent.
    if (!state || state.escalated || state.terminal || !state.lastTurn) return null;
    if (state.lastTurn.speech.trim() === '') return null;

    const decision = this.policy.registerSilence(input.callSessionId);

    if (decision.action === 'REPROMPT') {
      await this.publish(input.emergencyId, 'CONVERSATION_TIMED_OUT', {
        emergencyId: input.emergencyId,
        questionId: state.questionId,
        waitedMs: this.deps.config.silenceTimeoutMs,
        nextAction: 'REPROMPT',
      });
      this.logger.info(
        { callSessionId: input.callSessionId, attempt: decision.attempt },
        'caller was silent; repeating the current protocol instruction',
      );
      return { ...state.lastTurn, terminal: false };
    }

    await this.publish(input.emergencyId, 'CONVERSATION_TIMED_OUT', {
      emergencyId: input.emergencyId,
      questionId: state.questionId,
      waitedMs: this.deps.config.silenceTimeoutMs,
      nextAction: 'ESCALATE',
    });
    await this.publish(input.emergencyId, 'CONVERSATION_ESCALATED', {
      emergencyId: input.emergencyId,
      reason: `The caller was silent through ${decision.attempt} prompts; the conversation needs an operator.`,
      trigger: 'RETRY_LIMIT',
    });

    // Mark the conversation escalated. Both flags are set: `terminal` stops the
    // outstanding prompt, and `escalated` is sticky so a late timer firing, or a
    // later caller turn, can never restart prompting. The protocol row itself is
    // untouched: only the conversation stops prompting.
    state.terminal = true;
    state.escalated = true;
    this.logger.warn(
      { callSessionId: input.callSessionId, attempt: decision.attempt },
      'caller remained silent through every retry; the conversation is no longer prompting',
    );
    return null;
  }

  forget(callSessionId: string): void {
    this.byCall.delete(callSessionId);
    this.policy.clear(callSessionId);
    this.deps.inner.forget?.(callSessionId);
  }

  /** Remembers the authoritative turn and restarts the silence budget. */
  private remember(
    input: { callSessionId: string; emergencyId: string; language: string },
    turn: ConversationTurn | null,
  ): void {
    if (!turn) return;
    const existing = this.byCall.get(input.callSessionId);
    // Once escalated, the conversation stays escalated: a later turn updates what
    // was last said but must not re-open the silence budget.
    const escalated = existing?.escalated ?? false;
    this.byCall.set(input.callSessionId, {
      emergencyId: input.emergencyId,
      language: input.language,
      lastTurn: turn,
      questionId: turn.questionId ?? null,
      terminal: turn.terminal || escalated,
      escalated,
    });
    // A real turn arrived before escalation: the caller is engaged, so the next
    // silence begins a fresh budget rather than continuing the previous one.
    if (!escalated) this.policy.reset(input.callSessionId);
  }

  /**
   * Records a conversation-layer event, never letting a logging failure break the
   * call. These events mark the timeline; the caller's audio path must not depend
   * on them.
   */
  private async publish(
    emergencyId: string,
    type: 'CONVERSATION_TIMED_OUT' | 'CONVERSATION_ESCALATED',
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!this.deps.events) return;
    try {
      const event = { type, emergencyId, payload } as unknown as SystemEventEnvelope;
      await this.deps.events.record(event, { emergencyId });
    } catch (error) {
      this.logger.warn(
        { type, emergencyId, reason: (error as Error).message },
        'could not record a conversation-support event',
      );
    }
  }
}
