import { noopLogger, type Logger, type TelephonyProvider } from '@resus/core';
import { loadModule1Config, type Module1Config } from './config.js';
import { CallService, type CallSessionStore, type EmergencyStore } from './callService.js';
import { createModule1Routes } from './api/routes.js';
import { LoopbackTelephonyProvider } from './telephony/loopbackProvider.js';
import { AsteriskTelephonyProvider } from './telephony/asteriskProvider.js';

/**
 * Builds the telephony adapter for the configured provider.
 *
 * Kept out of the constructor so it is unit-testable: `asterisk` is the only
 * branch that talks to an external system, and it must be possible to prove that
 * asking for it produces `isLive: true` without a PBX present.
 *
 * `sip` and `webrtc` have no adapter in this build — selecting one already fails
 * at config load unless `TRANSPORT_SIGNALLING_URL` is set, and until a real
 * stack is added they fall through to loopback, exactly as before.
 */
export function createTelephonyProvider(config: Module1Config, logger: Logger): TelephonyProvider {
  const asterisk = config.telephony.asterisk;
  if (config.telephony.provider === 'asterisk' && asterisk) {
    return new AsteriskTelephonyProvider({
      context: asterisk.dialplan.context,
      exten: asterisk.dialplan.exten,
      priority: asterisk.dialplan.priority,
      defaultEndpoint: asterisk.defaultEndpoint,
      audioSocketAddress: `${asterisk.audioSocket.advertiseHost}:${asterisk.audioSocket.bindPort}`,
      inboundChannelPrefix: 'PJSIP/',
      inboundExtension: asterisk.inbound.extension,
      ami: asterisk.ami,
      logger,
    });
  }
  return new LoopbackTelephonyProvider();
}

export interface Module1Deps {
  /** Implemented by Module 11. Module 1 never sees a Prisma client. */
  emergencies: EmergencyStore;
  calls: CallSessionStore;
  events: import('@resus/core').EventPublisherPort;
  config?: Module1Config;
  /**
   * Telephony adapter.
   *
   * Production wiring passes nothing and the transport is chosen by
   * configuration alone, so a deployed build cannot be pointed at a different
   * carrier by injection. Tests pass a stub to exercise transport failure paths.
   */
  telephony?: TelephonyProvider;
  logger?: Logger;
}

/**
 * Module 1 composition root.
 *
 * Owns call intake and session lifecycle. It receives persistence through ports,
 * so nothing here references Fastify, Prisma or a transport protocol directly.
 */
export class Module1 {
  readonly calls: CallService;
  readonly telephony: TelephonyProvider;
  readonly config: Module1Config;
  private readonly logger: Logger;

  constructor(deps: Module1Deps) {
    this.config = deps.config ?? loadModule1Config();
    this.logger = deps.logger ?? noopLogger;
    this.telephony = deps.telephony ?? createTelephonyProvider(this.config, this.logger);
    this.calls = new CallService({
      config: this.config,
      telephony: this.telephony,
      emergencies: deps.emergencies,
      calls: deps.calls,
      events: deps.events,
      logger: this.logger,
    });
  }

  routes() {
    return createModule1Routes(this.calls);
  }

  register(table: import('@resus/core').RouteTable): void {
    table.addAll(this.routes());
  }
}