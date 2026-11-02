import 'dotenv/config';
import { readNumber, readString, readEnum, readOptionalString } from '@resus/core';
import type { CallTransport } from '@resus/core';

/**
 * Module 1 configuration.
 *
 * `TRANSPORT_PROVIDER` selects the telephony adapter:
 *   - `loopback` (default) is the development adapter and is always non-live;
 *   - `asterisk` drives a real Asterisk PBX over AMI and AudioSocket, and is the
 *     only provider in this build that produces a live call leg and real media;
 *   - `sip` / `webrtc` name signalling stacks this repository does not ship, so
 *     selecting them without `TRANSPORT_SIGNALLING_URL` fails loudly at boot
 *     rather than degrading silently to a mock an operator might mistake for a
 *     working line.
 *
 * For `asterisk`, `TRANSPORT_SIGNALLING_URL` carries the AMI endpoint as
 * `host:port` — reusing the existing variable keeps the boot-time guard that
 * already refuses a configured-but-unreachable carrier where it was.
 */

export type TelephonyProviderName = 'loopback' | 'asterisk' | 'sip' | 'webrtc';

/** Asterisk-specific settings, used only when `provider` is `asterisk`. */
export interface AsteriskConfig {
  ami: {
    host: string;
    port: number;
    username: string;
    secret: string;
    connectTimeoutMs: number;
    actionTimeoutMs: number;
  };
  audioSocket: {
    /** Interface the in-process AudioSocket server binds to. */
    bindHost: string;
    bindPort: number;
    /**
     * Host Asterisk should dial. When the PBX runs on the same machine as the
     * server this is `127.0.0.1`; it is separate from `bindHost` because a
     * server bound to `0.0.0.0` still must tell Asterisk a concrete address.
     */
    advertiseHost: string;
  };
  dialplan: {
    /** Context an originated call enters, where the dialplan runs AudioSocket. */
    context: string;
    exten: string;
    priority: number;
  };
  /** Endpoint dialled when `open()` supplies no channel, e.g. `PJSIP/1001`. */
  defaultEndpoint: string;
  inbound: {
    /** Channel variable the inbound dialplan sets with the AudioSocket UUID. */
    uuidVariable: string;
    /** Extension inbound calls arrive on, for logging and dialplan parity. */
    extension: string;
    /** Language assumed for an inbound caller. */
    language: string;
    /**
     * Service-area coordinates used to open an emergency for an inbound call.
     *
     * An inbound trunk carries no location, and a session cannot exist without
     * one, so the emergency is opened at the configured centroid and flagged for
     * the operator to confirm. Required when `provider` is `asterisk`: a missing
     * location would otherwise throw on every inbound call instead of once, here,
     * where it is fixable.
     */
    latitude: number;
    longitude: number;
  };
}

export interface Module1Config {
  telephony: {
    provider: TelephonyProviderName;
    /** SIP / WebRTC signalling endpoint, or the AMI `host:port` for Asterisk. */
    signallingUrl: string;
    defaultTransport: CallTransport;
    /** Language assumed when the caller does not state one. */
    defaultLanguage: string;
    /** Languages the call interface will accept. */
    supportedLanguages: string[];
    /** Hard cap on a single call, after which the session is force-ended. */
    maxCallDurationMinutes: number;
    /** Provider call timeout in milliseconds. */
    timeoutMs: number;
    /** Present only when `provider` is `asterisk`. */
    asterisk?: AsteriskConfig;
  };
}

const LANGUAGES = ['en', 'ml'] as const;

/**
 * Splits a `host:port` string. Rejects anything without a port, because an AMI
 * endpoint silently defaulting to some other port is exactly the kind of
 * misconfiguration that should stop a boot.
 */
function parseHostPort(value: string, variable: string): { host: string; port: number } {
  const match = /^(?<host>[^:\s]+):(?<port>\d{1,5})$/.exec(value.trim());
  const host = match?.groups?.host;
  const port = match?.groups?.port ? Number(match.groups.port) : NaN;
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${variable} must be in host:port form, received '${value}'.`);
  }
  return { host, port };
}

/**
 * Reads configuration from `process.env` through the shared helpers.
 *
 * There is deliberately no `env` parameter: `readString`/`readNumber`/`readEnum`
 * all read `process.env` directly, so accepting an injected object would give the
 * signature a promise of testability the body cannot keep — half the values
 * would come from the argument and half from the real environment. Tests set
 * `process.env` instead, as every other module's tests do.
 */
export function loadModule1Config(): Module1Config {
  const provider = readEnum('TRANSPORT_PROVIDER', ['loopback', 'asterisk', 'sip', 'webrtc'], 'loopback');
  const signallingUrl = readOptionalString('TRANSPORT_SIGNALLING_URL') ?? '';

  // A configured-but-unreachable carrier is the dangerous failure mode: it looks
  // configured in review and silently loses calls at runtime. Refuse to boot.
  if (provider !== 'loopback' && !signallingUrl) {
    throw new Error(
      `TRANSPORT_PROVIDER="${provider}" requires TRANSPORT_SIGNALLING_URL to be set. ` +
        'This repository ships no SIP or WebRTC signalling stack; set TRANSPORT_PROVIDER=loopback ' +
        'for local development, or point TRANSPORT_SIGNALLING_URL at your own signalling service.',
    );
  }

  const base = {
    provider,
    signallingUrl,
    defaultTransport:
      provider === 'sip' ? 'SIP' : provider === 'webrtc' ? 'WEBRTC' : provider === 'asterisk' ? 'SIP' : 'LOOPBACK',
    defaultLanguage: readString('CALL_DEFAULT_LANGUAGE', 'en'),
    supportedLanguages: LANGUAGES as unknown as string[],
    maxCallDurationMinutes: readNumber('CALL_MAX_DURATION_MINUTES', 30),
    timeoutMs: readNumber('CALL_PROVIDER_TIMEOUT_MS', 10_000),
  } satisfies Omit<Module1Config['telephony'], 'asterisk'>;

  if (provider !== 'asterisk') {
    return { telephony: base };
  }

  return {
    telephony: {
      ...base,
      asterisk: loadAsteriskConfig(signallingUrl, base.timeoutMs),
    },
  };
}

function loadAsteriskConfig(signallingUrl: string, providerTimeoutMs: number): AsteriskConfig {
  const { host, port } = parseHostPort(signallingUrl, 'TRANSPORT_SIGNALLING_URL');

  const secret = readOptionalString('ASTERISK_AMI_SECRET');
  if (!secret) {
    throw new Error(
      'TRANSPORT_PROVIDER="asterisk" requires ASTERISK_AMI_SECRET. Create a manager account in ' +
        '`/etc/asterisk/manager.conf` and set the same secret here.',
    );
  }

  const latitude = readNumber('ASTERISK_INBOUND_LAT', Number.NaN);
  const longitude = readNumber('ASTERISK_INBOUND_LNG', Number.NaN);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new Error(
      'TRANSPORT_PROVIDER="asterisk" requires ASTERISK_INBOUND_LAT and ASTERISK_INBOUND_LNG. ' +
        'An inbound call carries no location; the emergency is opened at these service-area ' +
        'coordinates and flagged for the operator to confirm.',
    );
  }
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    throw new Error(
      `ASTERISK_INBOUND_LAT/ASTERISK_INBOUND_LNG are out of range: received ${latitude}, ${longitude}.`,
    );
  }

  return {
    ami: {
      host,
      port,
      username: readString('ASTERISK_AMI_USERNAME', 'resus'),
      secret,
      connectTimeoutMs: readNumber('ASTERISK_AMI_CONNECT_TIMEOUT_MS', 5_000),
      actionTimeoutMs: readNumber('ASTERISK_AMI_ACTION_TIMEOUT_MS', providerTimeoutMs),
    },
    audioSocket: {
      bindHost: readString('ASTERISK_AUDIOSOCKET_BIND_HOST', '0.0.0.0'),
      bindPort: readNumber('ASTERISK_AUDIOSOCKET_BIND_PORT', 9092),
      advertiseHost: readString('ASTERISK_AUDIOSOCKET_ADVERTISE_HOST', '127.0.0.1'),
    },
    dialplan: {
      context: readString('ASTERISK_DIALPLAN_CONTEXT', 'resus'),
      exten: readString('ASTERISK_DIALPLAN_EXTEN', 's'),
      priority: readNumber('ASTERISK_DIALPLAN_PRIORITY', 1),
    },
    defaultEndpoint: readString('ASTERISK_DEFAULT_ENDPOINT', 'PJSIP/1001'),
    inbound: {
      uuidVariable: readString('ASTERISK_INBOUND_UUID_VARIABLE', 'RESUS_INBOUND_UUID'),
      extension: readString('ASTERISK_INBOUND_EXTEN', '1000'),
      language: readString('CALL_DEFAULT_LANGUAGE', 'en'),
      latitude,
      longitude,
    },
  };
}
