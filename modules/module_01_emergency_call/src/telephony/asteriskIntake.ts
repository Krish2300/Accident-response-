import { noopLogger, type Logger } from '@resus/core';
import type { OpenCallInput, OpenCallResult } from '../callService.js';
import type { AsteriskIntakeTelephony } from './asteriskProvider.js';
import type { AmiEvent } from './asterisk/amiClient.js';

/**
 * Inbound-call intake.
 *
 * Bridges the PBX to Module 1: when an emergency call arrives, this opens the
 * `CallSession`; when the caller hangs up, it closes it. It owns no state of its
 * own beyond the set of channels it has already acted on — session lifecycle
 * stays in `CallService`, and the channel/uuid map stays in the provider.
 *
 * How an inbound call is recognised
 * ---------------------------------
 * The dialplan tags every inbound leg with a channel variable it also feeds to
 * AudioSocket:
 *
 *     Set(RESUS_INBOUND_UUID=${UUID()})
 *     Answer()
 *     AudioSocket(${RESUS_INBOUND_UUID},127.0.0.1:9092)
 *
 * Asterisk reports that assignment as a `VarSet` event carrying the channel, the
 * value and the caller id together — which is exactly the triple needed to open
 * a session. Using a dedicated variable name (not the one outbound origination
 * sets) means an originated leg can never be mistaken for an inbound one.
 *
 * Coordinates
 * -----------
 * An inbound call has no location of its own; the trunk does not carry one. The
 * session is opened against the configured service-area coordinates and the
 * emergency is flagged for the operator to confirm the real position. This is a
 * deliberate, documented compromise: inventing a precise location from a district
 * centroid would be worse than admitting the position is provisional.
 */
export interface AsteriskIntakeConfig {
  /** Channel variable Asterisk sets on inbound legs, carrying the AudioSocket UUID. */
  inboundUuidVariable: string;
  /** Fallback caller id when the PBX reports none. */
  defaultCallerId: string | null;
  /** Language assumed for an inbound caller. */
  defaultLanguage: string;
  /**
   * Service-area coordinates used to open the emergency. Required: a session
   * cannot be created without a location, and pretending otherwise would be
   * `CallService.open` throwing on every inbound call instead.
   */
  latitude: number;
  longitude: number;
}

/**
 * The two `CallService` operations the intake performs.
 *
 * Structural rather than the concrete class, for the same reason as the telephony
 * side: the intake's behaviour is "translate an AMI event into one `open` or one
 * `close`", which has to be verifiable without a database behind it.
 */
export interface AsteriskIntakeCalls {
  open(input: OpenCallInput): Promise<OpenCallResult>;
  close(callSessionId: string, reason?: string): Promise<unknown>;
}

export interface AsteriskIntakeDeps {
  provider: AsteriskIntakeTelephony;
  calls: AsteriskIntakeCalls;
  config: AsteriskIntakeConfig;
  logger?: Logger;
}

export class AsteriskCallIntake {
  private readonly logger: Logger;
  private readonly handledChannels = new Set<string>();
  /**
   * The `open()` currently in flight per channel, published as a promise that
   * always settles.
   *
   * `CallService.open()` writes the emergency, the session and the event before
   * it returns, while Asterisk can report a hangup faster than that. A `Hangup`
   * that ran `close()` against a row that does not exist yet would log
   * `CALL_NOT_FOUND` and leave `CallSession.status = ACTIVE` on a call that has
   * actually ended. Holding the promise lets the hangup wait for the row instead.
   */
  private readonly opening = new Map<
    string,
    Promise<{ ok: true; result: OpenCallResult } | { ok: false; error: unknown }>
  >();
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly deps: AsteriskIntakeDeps) {
    this.logger = deps.logger ?? noopLogger;
  }

  /** Subscribes to the AMI event stream. Idempotent. */
  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.deps.provider.onAmiEvent((event) => {
      void this.onEvent(event);
    });
    this.logger.info(
      { variable: this.deps.config.inboundUuidVariable },
      'listening for inbound Asterisk calls',
    );
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private async onEvent(event: AmiEvent): Promise<void> {
    if (event.name === 'VarSet') {
      await this.onVarSet(event);
      return;
    }
    if (event.name === 'Hangup') {
      await this.onHangup(event);
    }
  }

  private async onVarSet(event: AmiEvent): Promise<void> {
    if (event.fields.Variable !== this.deps.config.inboundUuidVariable) return;

    const channel = event.fields.Channel;
    const uuid = event.fields.Value;
    if (!channel || !uuid) return;
    if (this.handledChannels.has(channel)) return;
    this.handledChannels.add(channel);

    const callerId = event.fields.CallerIDNum ?? this.deps.config.defaultCallerId;

    // Register the channel and uuid first: `CallService.open` will call
    // `telephony.originate({ channel })`, which resolves to this same leg.
    this.deps.provider.trackInbound({ channel, uuid, callerId });

    // Published before the first `await` so a `Hangup` delivered while this is
    // still in flight can find it and wait, rather than racing the row into
    // existence. The rejection is captured rather than left on the promise so
    // only this handler decides what a failed open means.
    const opening = this.deps.calls
      .open({
        latitude: this.deps.config.latitude,
        longitude: this.deps.config.longitude,
        channel,
        callerId,
        language: this.deps.config.defaultLanguage,
        description:
          'Inbound emergency call. Location is the configured service-area centroid (provisional); ' +
          'confirm the caller\'s actual position.',
      })
      .then(
        (result) => ({ ok: true as const, result }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    this.opening.set(channel, opening);

    try {
      const outcome = await opening;
      if (!outcome.ok) throw outcome.error;
      this.logOpened(outcome.result, channel, uuid);
    } catch (error) {
      this.handledChannels.delete(channel);
      this.logger.error(
        { channel, uuid, reason: (error as Error).message },
        'failed to open a session for an inbound Asterisk call',
      );
    } finally {
      this.opening.delete(channel);
    }
  }

  private async onHangup(event: AmiEvent): Promise<void> {
    const channel = event.fields.Channel;
    if (!channel) return;

    this.deps.provider.markHungUpByChannel(channel);
    const callSessionId = this.deps.provider.callSessionIdForChannel(channel);
    if (!callSessionId) return;

    // An `open()` for this channel may still be committing; without this the
    // close would run against a row that does not exist yet, report
    // `CALL_NOT_FOUND`, and leave an ended call marked ACTIVE.
    const opening = this.opening.get(channel);
    if (opening) await opening;

    try {
      // `CallService.close` calls `telephony.hangup`, which is idempotent, so a
      // hangup we already issued is a no-op rather than an error.
      await this.deps.calls.close(callSessionId, event.fields.Cause ? `Caller hung up (${event.fields.Cause}).` : 'Caller hung up.');
    } catch (error) {
      this.logger.warn(
        { channel, callSessionId, reason: (error as Error).message },
        'could not close the session for a hung-up Asterisk call',
      );
    }
  }

  private logOpened(result: OpenCallResult, channel: string, uuid: string): void {
    this.logger.info(
      {
        callSessionId: result.session.id,
        emergencyId: result.emergency.id,
        channel,
        uuid,
        language: result.session.language,
      },
      'inbound Asterisk call opened a session',
    );
  }
}
