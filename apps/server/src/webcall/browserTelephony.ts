import { randomUUID } from 'node:crypto';
import type { CallHandle, CallInvite, TelephonyProvider } from '@resus/core';

/**
 * Module 1 transport for a call placed from a browser.
 *
 * The media never touches a PBX: the caller's browser captures audio and the
 * words reach the server over HTTPS. The leg is live (a real person is on the
 * other end), so `isLive` is true, and the transport is recorded as `WEBRTC`.
 * Used by the Web Call service alongside whatever `TRANSPORT_PROVIDER` the
 * server runs, so it works with or without Asterisk.
 */
export class BrowserTelephonyProvider implements TelephonyProvider {
  readonly providerName = 'webcall';
  readonly isLive = true;
  private readonly active = new Set<string>();

  async originate(_invite: CallInvite): Promise<CallHandle> {
    const callSessionId = `WEB-${randomUUID()}`;
    this.active.add(callSessionId);
    return { callSessionId, transport: 'WEBRTC', providerName: this.providerName, isLive: true, startedAt: new Date().toISOString() };
  }

  async hangup(callSessionId: string): Promise<void> {
    this.active.delete(callSessionId);
  }

  async probe(): Promise<{ reachable: boolean; detail: string }> {
    return { reachable: true, detail: `Browser web-call transport, ${this.active.size} active call(s).` };
  }
}
