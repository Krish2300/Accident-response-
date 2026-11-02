import { randomUUID } from 'node:crypto';
import {
  AppError,
  ErrorCode,
  createId,
  noopLogger,
  type CallHandle,
  type CallInvite,
  type Logger,
  type TelephonyProvider,
} from '@resus/core';
import { AmiClient, type AmiClientOptions, type AmiClientPort, type AmiEvent } from './asterisk/amiClient.js';

/**
 * Asterisk telephony adapter.
 *
 * Implements the existing `TelephonyProvider` port against a real Asterisk PBX
 * over AMI. It is signalling plus identity only: it originates and hangs up a
 * channel, and it keeps the map between the call-leg id Module 1 stores and the
 * Asterisk channel, unique id and AudioSocket UUID. Media lives in
 * `AudioSocketServer`; this class never touches audio.
 *
 * Why the id map matters
 * ----------------------
 * `CallService` now writes the provider's `CallHandle.callSessionId` as the
 * `CallSession` primary key, so `hangup(callSessionId)` can find the channel it
 * must tear down. Without that map, operator hangup and the maximum-duration
 * sweep would close the row and leave the SIP leg up.
 *
 * Honesty rules (see `providerPorts.ts`)
 * --------------------------------------
 * `isLive` is `true` because this talks to a real PBX; `probe()` reports
 * `reachable: false` with the reason when the AMI socket or login fails, rather
 * than returning a cheerful placeholder.
 */

export interface AsteriskProviderConfig {
  /** Dialplan location that runs `AudioSocket` for an originated call. */
  context: string;
  exten: string;
  priority: number;
  /** Endpoint dialled when `originate()` is not given an explicit channel. */
  defaultEndpoint: string;
  /** `host:port` of our AudioSocket server, as Asterisk must dial it. */
  audioSocketAddress: string;
  /** Channel driver prefix used to recognise inbound calls, e.g. `PJSIP/`. */
  inboundChannelPrefix: string;
  /** The number/extension an inbound emergency call arrives on. */
  inboundExtension: string;
  /** AMI connection. */
  ami: AmiClientOptions;
  logger?: Logger;
  /** Injectable AMI client for tests. */
  client?: AmiClientPort;
}

/**
 * The channel/uuid bookkeeping the inbound intake and the media bridge need.
 *
 * Extracted as a structural interface for the same reason as `AmiClientPort`: the
 * intake has to be testable without the PBX that produces these events.
 */
export interface AsteriskCallRegistry {
  trackInbound(input: { channel: string; uuid?: string | null; callerId?: string | null }): string;
  bindUuid(callSessionId: string, uuid: string): void;
  markHungUpByChannel(channel: string): void;
  callSessionIdForUuid(uuid: string): string | null;
  callSessionIdForChannel(channel: string): string | null;
}

/** What the inbound intake needs: the registry plus the AMI event stream. */
export type AsteriskIntakeTelephony = AsteriskCallRegistry & {
  onAmiEvent(handler: (event: AmiEvent) => void): () => void;
};

interface TrackedCall {
  callSessionId: string;
  /** Asterisk channel, e.g. `PJSIP/trunk-0000000a`. Empty until known. */
  channel: string;
  /** AudioSocket UUID the dialplan will present to our server. */
  uuid: string | null;
  direction: 'inbound' | 'outbound';
  startedAt: Date;
  hungUp: boolean;
}

export class AsteriskTelephonyProvider implements TelephonyProvider, AsteriskCallRegistry {
  readonly providerName = 'asterisk';
  readonly isLive = true;

  private readonly logger: Logger;
  private readonly client: AmiClientPort;
  private readonly calls = new Map<string, TrackedCall>();
  private readonly byChannel = new Map<string, string>();
  private readonly byUuid = new Map<string, string>();

  constructor(private readonly config: AsteriskProviderConfig) {
    this.logger = config.logger ?? noopLogger;
    this.client = config.client ?? new AmiClient({ ...config.ami, logger: this.logger });
  }

  /** Opens the AMI connection up front so a dead PBX fails at boot, not on the first call. */
  async start(): Promise<void> {
    await this.client.connect();
  }

  async stop(): Promise<void> {
    await this.client.close();
  }

  /** Subscribe to raw AMI events; used by the inbound-call intake. */
  onAmiEvent(handler: (event: AmiEvent) => void): () => void {
    return this.client.onEvent(handler);
  }

  async originate(invite: CallInvite): Promise<CallHandle> {
    await this.connectIfNeeded();

    // Attaching to a call Asterisk already has (inbound intake): `invite.channel`
    // names a tracked channel, so this is not a new leg.
    const requestedChannel = invite.channel?.trim();
    if (requestedChannel) {
      const existingId = this.byChannel.get(requestedChannel);
      const tracked = existingId ? this.calls.get(existingId) : undefined;
      if (tracked) return this.toHandle(tracked);
    }

    const callSessionId = createId('CALL');
    const uuid = randomUUID();
    const endpoint = requestedChannel && requestedChannel !== '' ? requestedChannel : this.config.defaultEndpoint;
    const actionId = this.client.newActionId();

    const outcome = this.client.waitForEvent(
      (event) => event.name === 'OriginateResponse' && event.fields.ActionID === actionId,
      this.config.ami.actionTimeoutMs,
    );

    let reply;
    try {
      reply = await this.client.sendAction('Originate', {
        Channel: endpoint,
        Context: this.config.context,
        Exten: this.config.exten,
        Priority: this.config.priority,
        CallerID: invite.callerId ?? undefined,
        // Two variables travel with the leg: the key we will hang up by, and the
        // UUID the dialplan hands to AudioSocket.
        Variable: `RESUS_CALL_KEY=${callSessionId},RESUS_CALL_UUID=${uuid}`,
        // File a hangup in the manager's event stream even if the dialplan path
        // never reaches AudioSocket.
        Async: 'true',
        ActionID: actionId,
      });
    } catch (error) {
      throw this.providerError('originate', error);
    }

    if (reply.Response !== 'Success') {
      throw new AppError(
        ErrorCode.PROVIDER_UNAVAILABLE,
        `Asterisk refused to originate on '${endpoint}': ${reply.Message ?? reply.Response ?? 'unknown reason'}.`,
        503,
        { endpoint, response: reply.Response },
      );
    }

    let event: AmiEvent;
    try {
      event = await outcome;
    } catch (error) {
      throw this.providerError('originate', error);
    }

    if (event.fields.Response !== 'Success') {
      throw new AppError(
        ErrorCode.PROVIDER_UNAVAILABLE,
        `Asterisk could not establish the call to '${endpoint}': ${event.fields.Reason ?? event.fields.Message ?? 'no reason given'}.`,
        503,
        { endpoint, response: event.fields.Response, reason: event.fields.Reason },
      );
    }

    const tracked: TrackedCall = {
      callSessionId,
      channel: event.fields.Channel ?? endpoint,
      uuid,
      direction: 'outbound',
      startedAt: new Date(),
      hungUp: false,
    };
    this.register(tracked);

    this.logger.info(
      { callSessionId, channel: tracked.channel, endpoint, uuid },
      'originated an Asterisk call leg',
    );
    return this.toHandle(tracked);
  }

  /**
   * Registers a channel Asterisk already owns, returning the call-session id
   * Module 1 should store. Called by the inbound intake *before* it opens the
   * session, so `CallService.open()` -> `originate({ channel })` finds it.
   */
  trackInbound(input: { channel: string; uuid?: string | null; callerId?: string | null }): string {
    this.prune();
    const existingId = this.byChannel.get(input.channel);
    if (existingId) return existingId;

    const callSessionId = createId('CALL');
    const tracked: TrackedCall = {
      callSessionId,
      channel: input.channel,
      uuid: input.uuid ?? null,
      direction: 'inbound',
      startedAt: new Date(),
      hungUp: false,
    };
    this.register(tracked);
    this.logger.info(
      { callSessionId, channel: input.channel, uuid: tracked.uuid, callerId: input.callerId ?? null },
      'tracked an inbound Asterisk channel',
    );
    return callSessionId;
  }

  /** Binds a late-arriving AudioSocket UUID to an already tracked channel. */
  bindUuid(callSessionId: string, uuid: string): void {
    const tracked = this.calls.get(callSessionId);
    if (!tracked) return;
    tracked.uuid = uuid;
    this.byUuid.set(uuid, callSessionId);
  }

  /** Marks a tracked call hung up when AMI reports the channel went away. */
  markHungUpByChannel(channel: string): void {
    const callSessionId = this.byChannel.get(channel);
    const tracked = callSessionId ? this.calls.get(callSessionId) : undefined;
    if (tracked) tracked.hungUp = true;
  }

  callSessionIdForUuid(uuid: string): string | null {
    return this.byUuid.get(uuid) ?? null;
  }

  callSessionIdForChannel(channel: string): string | null {
    return this.byChannel.get(channel) ?? null;
  }

  async hangup(callSessionId: string, reason: string): Promise<void> {
    const tracked = this.calls.get(callSessionId);
    if (!tracked) {
      // Idempotent by contract: the channel is already gone (Asterisk hung up
      // first), so there is nothing to do and nothing to report as an error.
      this.logger.debug({ callSessionId, reason }, 'hangup for an unknown call leg; treating as already ended');
      return;
    }
    if (tracked.hungUp) {
      // Asterisk reported the hangup first (the caller side tore the leg down),
      // so there is no Hangup action to send. The bookkeeping must still be
      // dropped here: returning without it left a dead leg in `calls`, and the
      // transport probe kept reporting a leg that no longer existed until the
      // one-hour prune finally ran.
      this.release(tracked.callSessionId);
      return;
    }

    await this.connectIfNeeded();
    if (tracked.channel) {
      await this.client.sendAction('Hangup', { Channel: tracked.channel }).catch((error: unknown) => {
        // The leg can disappear between our bookkeeping and the action; that is
        // the same outcome we wanted, so it is logged rather than thrown.
        this.logger.warn(
          { callSessionId, channel: tracked.channel, reason: (error as Error).message },
          'Asterisk rejected the Hangup action; the channel may already be gone',
        );
      });
    }
    tracked.hungUp = true;
    this.release(tracked.callSessionId);
  }

  async probe(): Promise<{ reachable: boolean; detail: string }> {
    try {
      await this.client.ping();
      return { reachable: true, detail: `Asterisk AMI reachable; ${this.calls.size} call leg(s) tracked.` };
    } catch (error) {
      return { reachable: false, detail: (error as Error).message };
    }
  }

  // -- internals --------------------------------------------------------------

  private register(tracked: TrackedCall): void {
    this.calls.set(tracked.callSessionId, tracked);
    if (tracked.channel) this.byChannel.set(tracked.channel, tracked.callSessionId);
    if (tracked.uuid) this.byUuid.set(tracked.uuid, tracked.callSessionId);
  }

  private release(callSessionId: string): void {
    const tracked = this.calls.get(callSessionId);
    if (!tracked) return;
    this.calls.delete(callSessionId);
    this.byChannel.delete(tracked.channel);
    if (tracked.uuid) this.byUuid.delete(tracked.uuid);
  }

  /** Bounds the maps: a leg that has been hung up for over an hour is not coming back. */
  private prune(now: number = Date.now()): void {
    for (const [id, tracked] of this.calls) {
      if (tracked.hungUp && now - tracked.startedAt.getTime() > 3_600_000) this.release(id);
    }
  }

  private toHandle(tracked: TrackedCall): CallHandle {
    return {
      callSessionId: tracked.callSessionId,
      transport: 'SIP',
      providerName: this.providerName,
      isLive: this.isLive,
      startedAt: tracked.startedAt.toISOString(),
    };
  }

  private async connectIfNeeded(): Promise<void> {
    if (!this.client.connected) await this.client.connect();
  }

  private providerError(operation: string, error: unknown): AppError {
    if (error instanceof AppError) return error;
    return new AppError(
      ErrorCode.PROVIDER_UNAVAILABLE,
      `Asterisk ${operation} failed: ${(error as Error).message}`,
      503,
      { provider: this.providerName, operation },
    );
  }
}
