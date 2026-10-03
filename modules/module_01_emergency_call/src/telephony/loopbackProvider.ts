import {
  AppError,
  ErrorCode,
  createId,
  type CallHandle,
  type CallInvite,
  type CallTransport,
  type TelephonyProvider,
} from '@resus/core';

/**
 * Development call transport.
 *
 * What this actually is
 * ---------------------
 * An in-process session registry. It creates a session id, records a start
 * timestamp and returns a handle. There is no SIP dialogue, no RTP stream, no
 * microphone and no telephone network involved, and `isLive` is hard-coded
 * `false` so that fact travels with every handle this provider produces.
 *
 * Why it exists anyway
 * --------------------
 * Modules 2, 4 and 10 need a call session to exist before they can be developed,
 * tested or demonstrated end-to-end. Making that dependency explicit — behind the
 * `TelephonyProvider` port — is what allows the rest of the system to be built
 * and verified without a carrier, and it means replacing this file with a real
 * `SipProvider` changes nothing above the port.
 *
 * Determinism
 * -----------
 * Session ids come from the shared `createId` sequence and timestamps from the
 * injected clock, so a test that starts a call twice with the same clock and
 * counter produces byte-identical transcripts.
 */
export class LoopbackTelephonyProvider implements TelephonyProvider {
  readonly providerName = 'loopback';
  readonly isLive = false;

  private readonly sessions = new Map<string, { startedAt: Date; handle: CallHandle }>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async originate(invite: CallInvite): Promise<CallHandle> {
    const id = createId('CALL');
    const handle: CallHandle = {
      callSessionId: id,
      transport: 'LOOPBACK' satisfies CallTransport,
      providerName: this.providerName,
      isLive: false,
      startedAt: this.now().toISOString(),
    };
    this.sessions.set(id, { startedAt: this.now(), handle });
    return handle;
  }

  async hangup(callSessionId: string, reason: string): Promise<void> {
    if (!this.sessions.has(callSessionId)) {
      throw new AppError(ErrorCode.CALL_NOT_FOUND, `Call session '${callSessionId}' is not active.`, 404, {
        callSessionId,
        reason,
      });
    }
    // Idempotent: a second hangup of an already-ended call is a no-op rather than
    // an error, because disconnects can be observed twice (carrier hangup and
    // local teardown racing) and neither observer should see a fault.
    this.sessions.delete(callSessionId);
  }

  async probe(): Promise<{ reachable: boolean; detail: string }> {
    return {
      reachable: true,
      detail: `Loopback transport, ${this.sessions.size} active session(s). No telephone network is involved.`,
    };
  }

  /** Test/diagnostic helper: sessions this provider still considers active. */
  activeSessions(): string[] {
    return [...this.sessions.keys()];
  }
}
