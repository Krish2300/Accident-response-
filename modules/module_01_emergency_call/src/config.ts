import 'dotenv/config';
import { readNumber, readString, readEnum, readOptionalString } from '@resus/core';
import type { CallTransport } from '@resus/core';

/**
 * Module 1 configuration.
 *
 * `TRANSPORT_PROVIDER` selects the telephony adapter. `loopback` is the
 * development default and is always non-live; `sip` and `webrtc` require a real
 * signalling stack that this repository does not ship, so selecting them without
 * the matching environment fails loudly at boot rather than degrading silently to
 * a mock that an operator might mistake for a working line.
 */
export type TelephonyProviderName = 'loopback' | 'sip' | 'webrtc';

export interface Module1Config {
  telephony: {
    provider: TelephonyProviderName;
    /** SIP / WebRTC signalling endpoint. Unused by the loopback provider. */
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
  };
}

const LANGUAGES = ['en', 'ml'] as const;

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
  const provider = readEnum('TRANSPORT_PROVIDER', ['loopback', 'sip', 'webrtc'], 'loopback');
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

  return {
    telephony: {
      provider,
      signallingUrl,
      defaultTransport:
        provider === 'sip' ? 'SIP' : provider === 'webrtc' ? 'WEBRTC' : 'LOOPBACK',
      defaultLanguage: readString('CALL_DEFAULT_LANGUAGE', 'en'),
      supportedLanguages: LANGUAGES as unknown as string[],
      maxCallDurationMinutes: readNumber('CALL_MAX_DURATION_MINUTES', 30),
      timeoutMs: readNumber('CALL_PROVIDER_TIMEOUT_MS', 10_000),
    },
  };
}
