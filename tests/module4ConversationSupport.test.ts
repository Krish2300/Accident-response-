import { describe, expect, it } from 'vitest';
import type {
  AudioBridgeConversationPort,
  ConversationTurn,
} from '@resus/call';
import {
  ConversationSupportAdapter,
  type ConversationEventSink,
} from '../apps/server/src/conversation/conversationSupport.js';
import { SilenceRetryPolicy } from '../apps/server/src/conversation/timeoutPolicy.js';

/**
 * Module 4 conversation-support tests.
 *
 * The adapter sits between the media bridge and the Module 5-backed controller.
 * These tests pin its two jobs and its limits: it forwards connect/utterance turns
 * verbatim (Module 5 stays the authority), it replays the last authoritative turn
 * on silence, it escalates only after the retry budget is spent, and it records
 * the conversation-layer events with the documented payloads.
 */

function turn(overrides: Partial<ConversationTurn> = {}): ConversationTurn {
  return {
    speech: 'Check if they respond.',
    tone: 'CALM',
    verbatimProtocolText: true,
    terminal: false,
    questionId: null,
    ...overrides,
  };
}

class FakeInner implements AudioBridgeConversationPort {
  readonly connects: unknown[] = [];
  readonly utterances: unknown[] = [];
  readonly forgets: string[] = [];
  opening: ConversationTurn | null = turn();
  reply: ConversationTurn | null = turn({ speech: 'Give two rescue breaths.' });

  async onCallConnected(input: {
    callSessionId: string;
    emergencyId: string;
    language: string;
  }): Promise<ConversationTurn | null> {
    this.connects.push(input);
    return this.opening;
  }

  async onCallerUtterance(input: {
    callSessionId: string;
    emergencyId: string;
    language: string;
    text: string;
  }): Promise<ConversationTurn | null> {
    this.utterances.push(input);
    return this.reply;
  }

  forget(callSessionId: string): void {
    this.forgets.push(callSessionId);
  }
}

class RecordingSink implements ConversationEventSink {
  readonly events: Array<{ type: string; emergencyId?: string | null; payload: unknown }> = [];
  fail = false;

  async record(event: { type: string; emergencyId?: string | null; payload: unknown }): Promise<unknown> {
    if (this.fail) throw new Error('event store offline');
    this.events.push(event);
    return {};
  }
}

const connect = { callSessionId: 'CALL-1', emergencyId: 'EMG-1', language: 'en' };

function build(options: { retryLimit?: number; events?: boolean } = {}): {
  adapter: ConversationSupportAdapter;
  inner: FakeInner;
  sink: RecordingSink;
} {
  const inner = new FakeInner();
  const sink = new RecordingSink();
  const adapter = new ConversationSupportAdapter({
    inner,
    ...(options.events === false ? {} : { events: sink }),
    config: { silenceTimeoutMs: 5_000, silenceRetryLimit: options.retryLimit ?? 2 },
  });
  return { adapter, inner, sink };
}

describe('SilenceRetryPolicy', () => {
  it('allows the configured number of repeats before escalating', () => {
    const policy = new SilenceRetryPolicy(2);
    expect(policy.registerSilence('c')).toEqual({ action: 'REPROMPT', attempt: 1 });
    expect(policy.registerSilence('c')).toEqual({ action: 'REPROMPT', attempt: 2 });
    expect(policy.registerSilence('c')).toEqual({ action: 'ESCALATE', attempt: 3 });
  });

  it('escalates on the first silence when the limit is zero', () => {
    const policy = new SilenceRetryPolicy(0);
    expect(policy.registerSilence('c')).toEqual({ action: 'ESCALATE', attempt: 1 });
  });

  it('resets the budget when the caller answers', () => {
    const policy = new SilenceRetryPolicy(1);
    expect(policy.registerSilence('c').action).toBe('REPROMPT');
    policy.reset('c');
    expect(policy.attemptFor('c')).toBe(0);
    expect(policy.registerSilence('c').action).toBe('REPROMPT');
  });

  it('rejects an invalid limit', () => {
    expect(() => new SilenceRetryPolicy(-1)).toThrow();
    expect(() => new SilenceRetryPolicy(1.5)).toThrow();
  });
});

describe('ConversationSupportAdapter', () => {
  it('forwards connect and utterance turns verbatim so Module 5 stays the authority', async () => {
    const { adapter, inner } = build();

    const opening = await adapter.onCallConnected(connect);
    expect(opening).toEqual(turn());
    expect(inner.connects).toHaveLength(1);

    const reply = await adapter.onCallerUtterance({ ...connect, text: 'no' });
    expect(reply).toEqual(turn({ speech: 'Give two rescue breaths.' }));
    expect(inner.utterances).toHaveLength(1);
  });

  it('repeats the last authoritative turn on silence and records CONVERSATION_TIMED_OUT', async () => {
    const { adapter, sink } = build();
    await adapter.onCallConnected({ ...connect });

    const repeated = await adapter.onCallerSilence({ ...connect });

    // The same reviewed instruction is replayed; nothing is invented here.
    expect(repeated).toEqual(turn());
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      type: 'CONVERSATION_TIMED_OUT',
      emergencyId: 'EMG-1',
      payload: { emergencyId: 'EMG-1', questionId: null, waitedMs: 5_000, nextAction: 'REPROMPT' },
    });
  });

  it('carries the outstanding question id onto the timeout event', async () => {
    const { adapter, inner, sink } = build();
    inner.opening = turn({ questionId: 'cardiac@1.0.0:q1' });
    await adapter.onCallConnected({ ...connect });

    await adapter.onCallerSilence({ ...connect });

    expect(sink.events[0]!.payload).toMatchObject({ questionId: 'cardiac@1.0.0:q1' });
  });

  it('escalates once the retry budget is spent and stops prompting', async () => {
    const { adapter, sink } = build({ retryLimit: 2 });
    await adapter.onCallConnected({ ...connect });

    expect(await adapter.onCallerSilence({ ...connect })).not.toBeNull();
    expect(await adapter.onCallerSilence({ ...connect })).not.toBeNull();
    const escalated = await adapter.onCallerSilence({ ...connect });
    expect(escalated).toBeNull();

    const types = sink.events.map((event) => event.type);
    expect(types).toEqual([
      'CONVERSATION_TIMED_OUT',
      'CONVERSATION_TIMED_OUT',
      'CONVERSATION_TIMED_OUT',
      'CONVERSATION_ESCALATED',
    ]);
    expect(sink.events[2]!.payload).toMatchObject({ nextAction: 'ESCALATE' });
    expect(sink.events[3]!.payload).toMatchObject({ trigger: 'RETRY_LIMIT' });

    // A late timer cannot re-run the escalation.
    expect(await adapter.onCallerSilence({ ...connect })).toBeNull();
    expect(sink.events).toHaveLength(4);
  });

  it('permits exactly the approved two re-prompts at the retry-limit boundary', async () => {
    const { adapter, sink } = build({ retryLimit: 2 });
    await adapter.onCallConnected({ ...connect });

    const results: Array<ConversationTurn | null> = [];
    for (let i = 0; i < 4; i += 1) results.push(await adapter.onCallerSilence({ ...connect }));

    // Two replays, then no prompt on every silence thereafter.
    expect(results[0]).not.toBeNull();
    expect(results[1]).not.toBeNull();
    expect(results[2]).toBeNull();
    expect(results[3]).toBeNull();

    const reprompts = sink.events.filter(
      (event) =>
        event.type === 'CONVERSATION_TIMED_OUT' &&
        (event.payload as { nextAction: string }).nextAction === 'REPROMPT',
    );
    const escalations = sink.events.filter((event) => event.type === 'CONVERSATION_ESCALATED');
    expect(reprompts).toHaveLength(2);
    expect(escalations).toHaveLength(1);
  });

  it('permits exactly one re-prompt when the limit is one', async () => {
    const { adapter, sink } = build({ retryLimit: 1 });
    await adapter.onCallConnected({ ...connect });

    expect(await adapter.onCallerSilence({ ...connect })).not.toBeNull();
    expect(await adapter.onCallerSilence({ ...connect })).toBeNull();

    const reprompts = sink.events.filter(
      (event) =>
        event.type === 'CONVERSATION_TIMED_OUT' &&
        (event.payload as { nextAction: string }).nextAction === 'REPROMPT',
    );
    expect(reprompts).toHaveLength(1);
    expect(sink.events.filter((event) => event.type === 'CONVERSATION_ESCALATED')).toHaveLength(1);
  });

  it('escalates on the first silence with no re-prompt when the limit is zero', async () => {
    const { adapter, inner, sink } = build({ retryLimit: 0 });
    await adapter.onCallConnected({ ...connect });

    expect(await adapter.onCallerSilence({ ...connect })).toBeNull();

    expect(
      sink.events.filter(
        (event) =>
          event.type === 'CONVERSATION_TIMED_OUT' &&
          (event.payload as { nextAction: string }).nextAction === 'REPROMPT',
      ),
    ).toHaveLength(0);
    expect(sink.events.filter((event) => event.type === 'CONVERSATION_ESCALATED')).toHaveLength(1);
    expect(inner.utterances).toHaveLength(0);
    expect(sink.events.map((event) => event.type)).toEqual([
      'CONVERSATION_TIMED_OUT',
      'CONVERSATION_ESCALATED',
    ]);
    expect(sink.events.some((event) => event.type.startsWith('PROTOCOL_'))).toBe(false);
    expect(sink.events.some((event) => event.type === 'EMERGENCY_STATUS_CHANGED')).toBe(false);
  });

  it('does not restart prompting when silence repeats after escalation', async () => {
    const { adapter, sink } = build({ retryLimit: 1 });
    await adapter.onCallConnected({ ...connect });
    await adapter.onCallerSilence({ ...connect }); // REPROMPT
    await adapter.onCallerSilence({ ...connect }); // ESCALATE
    const afterEscalation = sink.events.length;

    // Many later silences: never a replay, never a new event.
    for (let i = 0; i < 5; i += 1) {
      expect(await adapter.onCallerSilence({ ...connect })).toBeNull();
    }
    expect(sink.events).toHaveLength(afterEscalation);
  });

  it('stays escalated even if the caller speaks again', async () => {
    const { adapter, sink } = build({ retryLimit: 1 });
    await adapter.onCallConnected({ ...connect });
    await adapter.onCallerSilence({ ...connect }); // REPROMPT
    await adapter.onCallerSilence({ ...connect }); // ESCALATE
    const afterEscalation = sink.events.length;

    // A later caller turn must not re-open the budget: the escalation is sticky.
    const reply = await adapter.onCallerUtterance({ ...connect, text: 'hello?' });
    expect(reply).not.toBeNull();
    expect(await adapter.onCallerSilence({ ...connect })).toBeNull();
    expect(sink.events).toHaveLength(afterEscalation);
  });

  it('clears escalation on forget so a fresh call on the same id starts clean', async () => {
    const { adapter } = build({ retryLimit: 2 });
    await adapter.onCallConnected({ ...connect });
    await adapter.onCallerSilence({ ...connect }); // REPROMPT
    await adapter.onCallerSilence({ ...connect }); // REPROMPT
    expect(await adapter.onCallerSilence({ ...connect })).toBeNull(); // escalated

    // Hangup clears the per-call bookkeeping, including the sticky escalation.
    adapter.forget('CALL-1');
    await adapter.onCallConnected({ ...connect });

    // The conversation prompts again rather than inheriting the old escalation.
    expect(await adapter.onCallerSilence({ ...connect })).not.toBeNull();
  });

  it('resets the retry budget when the caller answers between silences', async () => {
    const { adapter, sink } = build({ retryLimit: 1 });
    await adapter.onCallConnected({ ...connect });

    expect(await adapter.onCallerSilence({ ...connect })).not.toBeNull();
    // The caller replies: the next silence starts a fresh budget.
    await adapter.onCallerUtterance({ ...connect, text: 'yes' });
    expect(await adapter.onCallerSilence({ ...connect })).not.toBeNull();
    // Only after a second silence *without* an intervening reply does it escalate.
    expect(await adapter.onCallerSilence({ ...connect })).toBeNull();

    const nextActions = sink.events
      .filter((event) => event.type === 'CONVERSATION_TIMED_OUT')
      .map((event) => (event.payload as { nextAction: string }).nextAction);
    expect(nextActions).toEqual(['REPROMPT', 'REPROMPT', 'ESCALATE']);
  });

  it('does not prompt after a terminal turn', async () => {
    const inner = new FakeInner();
    inner.reply = turn({ terminal: true });
    const sink = new RecordingSink();
    const adapter = new ConversationSupportAdapter({
      inner,
      events: sink,
      config: { silenceTimeoutMs: 5_000, silenceRetryLimit: 2 },
    });

    await adapter.onCallConnected({ ...connect });
    await adapter.onCallerUtterance({ ...connect, text: 'done' });

    expect(await adapter.onCallerSilence({ ...connect })).toBeNull();
    expect(sink.events).toHaveLength(0);
  });

  it('says nothing when there is no outstanding prompt', async () => {
    const { adapter, sink } = build();
    // No connect happened, so there is nothing to repeat.
    expect(await adapter.onCallerSilence({ ...connect })).toBeNull();
    expect(sink.events).toHaveLength(0);
  });

  it('releases per-call state on forget so a reused id starts clean', async () => {
    const { adapter, inner, sink } = build();
    await adapter.onCallConnected({ ...connect });
    await adapter.onCallerSilence({ ...connect });
    adapter.forget('CALL-1');

    expect(inner.forgets).toEqual(['CALL-1']);
    // The state is gone: a silence for the same call now has nothing to repeat.
    expect(await adapter.onCallerSilence({ ...connect })).toBeNull();
    expect(sink.events).toHaveLength(1);
  });

  it('keeps prompting when the event store is unavailable', async () => {
    const { adapter, sink } = build();
    sink.fail = true;
    await adapter.onCallConnected({ ...connect });

    // A failed event write must not break the caller's audio path.
    await expect(adapter.onCallerSilence({ ...connect })).resolves.toEqual(turn());
    expect(sink.events).toHaveLength(0);
  });

  it('works without an event sink at all', async () => {
    const { adapter } = build({ events: false });
    await adapter.onCallConnected({ ...connect });
    await expect(adapter.onCallerSilence({ ...connect })).resolves.toEqual(turn());
  });
});
