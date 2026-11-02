import type { Logger } from '@resus/core';
import {
  AsteriskCallIntake,
  AsteriskTelephonyProvider,
  AudioBridge,
  type AudioBridgeCallStore,
  type AudioBridgeConversationPort,
  type AudioBridgeSpeechPort,
  type Module1,
} from '@resus/call';
import type { ServerConfig } from '../config.js';
import { startCallDurationWatch } from './callDurationWatch.js';

/**
 * Asterisk runtime: the pieces that exist only when the telephony provider is a
 * real PBX.
 *
 * Module 1 builds the provider from configuration, but the provider is only the
 * signalling half of a call. Two more things must exist for an inbound emergency
 * call to reach the system as a `CallSession` carrying real audio:
 *
 *   - the intake, which turns an AMI event into an opened session;
 *   - the media bridge, which turns AudioSocket PCM into a transcript and the
 *     greeting into the caller's ear.
 *
 * Both are started here rather than inside Module 1 because they are
 * infrastructure — sockets, ports, timers — and Module 1's composition root is
 * deliberately transport-agnostic (it builds a `TelephonyProvider` and stops).
 * This file is the composition root's own composition root: it is the one place
 * where Module 1, Module 2 and the operating system's sockets meet.
 *
 * Failure policy
 * --------------
 * If the provider is configured as `asterisk` and any part of this cannot start
 * — AMI refuses the login, the AudioSocket port is taken — the exception
 * propagates and the server does not boot. That is deliberate and matches the
 * existing rule for a configured-but-unreachable carrier: a deployment that
 * *looks* telephony-enabled while silently accepting no calls is worse than one
 * that refuses to start and says why.
 */
export interface AsteriskRuntime {
  provider: AsteriskTelephonyProvider;
  intake: AsteriskCallIntake;
  bridge: AudioBridge;
  /** Address the AudioSocket server actually bound to (port may differ from the config if 0 was requested). */
  audioSocket: { host: string; port: number };
  stop(): Promise<void>;
}

export interface StartAsteriskRuntimeDeps {
  module1: Module1;
  /** Module 2's speech service, typed through the bridge's structural port. */
  speech: AudioBridgeSpeechPort;
  /**
   * Module 5's conversation, typed through the bridge's structural port.
   *
   * When present, a live call runs a stateful protocol over the socket: the
   * first instruction replaces the greeting and each caller utterance produces
   * the next one. Omitted in tests and in loopback builds.
   */
  conversation?: AudioBridgeConversationPort;
  /** Module 11's call store, typed through the bridge's structural port. */
  calls: AudioBridgeCallStore;
  config: ServerConfig;
  logger: Logger;
}

/**
 * Starts the Asterisk runtime, or returns `null` when the configured provider is
 * not `asterisk`.
 *
 * Returning `null` rather than an inert stub keeps the default development path
 * (loopback) free of listeners, timers and event subscriptions it will never
 * use, and keeps this file out of the way of every existing test.
 */
export async function startAsteriskRuntime(deps: StartAsteriskRuntimeDeps): Promise<AsteriskRuntime | null> {
  const { module1, config, logger } = deps;
  if (module1.config.telephony.provider !== 'asterisk') return null;

  const asterisk = module1.config.telephony.asterisk;
  if (!asterisk) {
    // Unreachable if `loadModule1Config` is correct, but a silent null here would
    // mean "telephony is running" when nothing is listening.
    throw new Error('TRANSPORT_PROVIDER="asterisk" but no Asterisk configuration was resolved.');
  }

  const provider = module1.telephony;
  if (!(provider instanceof AsteriskTelephonyProvider)) {
    throw new Error(
      `TRANSPORT_PROVIDER="asterisk" resolved to the '${module1.telephony.providerName}' provider; expected the Asterisk adapter.`,
    );
  }

  const intake = new AsteriskCallIntake({
    provider,
    calls: module1.calls,
    config: {
      inboundUuidVariable: asterisk.inbound.uuidVariable,
      defaultCallerId: null,
      defaultLanguage: asterisk.inbound.language,
      latitude: asterisk.inbound.latitude,
      longitude: asterisk.inbound.longitude,
    },
    logger,
  });

  const bridge = new AudioBridge({
    provider,
    calls: deps.calls,
    speech: deps.speech,
    ...(deps.conversation ? { conversation: deps.conversation } : {}),
    config: {
      greeting: config.asterisk.greeting,
      greetingTone: config.asterisk.greetingTone,
      bindHost: asterisk.audioSocket.bindHost,
      bindPort: asterisk.audioSocket.bindPort,
      speechRmsThreshold: config.asterisk.speechRmsThreshold,
      hangoverMs: config.asterisk.hangoverMs,
      minUtteranceMs: config.asterisk.minUtteranceMs,
      maxUtteranceMs: config.asterisk.maxUtteranceMs,
      resolveTimeoutMs: config.asterisk.resolveTimeoutMs,
      // Module 4: caller-silence re-prompt. 0 (the default) leaves the bridge's
      // previous behaviour untouched.
      silenceTimeoutMs: config.conversation.silenceTimeoutMs,
    },
    logger,
  });
  module1.calls.setSyntheticTimingMarkerSink((callSessionId, marker) =>
    bridge.recordSyntheticSpeechMarker(callSessionId, marker),
  );

  // Subscribed before the AMI connection opens, so no event can arrive for a
  // listener that has not yet been registered.
  intake.start();

  let audioSocket: { host: string; port: number };
  try {
    audioSocket = await bridge.start();
  } catch (error) {
    intake.stop();
    throw error;
  }

  try {
    await provider.start();
  } catch (error) {
    await bridge.stop();
    intake.stop();
    throw error;
  }

  logger.info(
    {
      ami: `${asterisk.ami.host}:${asterisk.ami.port}`,
      audioSocket: `${audioSocket.host}:${audioSocket.port}`,
      audioSocketAdvertised: `${asterisk.audioSocket.advertiseHost}:${asterisk.audioSocket.bindPort}`,
      greeting: config.asterisk.greeting !== '',
    },
    'Asterisk telephony runtime started',
  );

  // Enforce the configured maximum call duration for as long as the runtime is
  // up. The watch records its own start instant as a watermark, so calls that
  // were already ACTIVE when this process booted are left for a deliberate
  // reconciliation instead of being mass-closed on the first sweep.
  const durationWatch = startCallDurationWatch({
    enforce: (now, notBefore) => module1.calls.enforceMaxDuration(now, notBefore),
    logger,
  });

  return {
    provider,
    intake,
    bridge,
    audioSocket,
    async stop() {
      durationWatch.stop();
      await bridge.stop();
      intake.stop();
      await provider.stop();
    },
  };
}
