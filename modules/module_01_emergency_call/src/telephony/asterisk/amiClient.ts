import net from 'node:net';
import { AppError, ErrorCode, noopLogger, type Logger } from '@resus/core';
import { parseAmiBuffer, serializeAmiAction, type AmiFields, type AmiMessage } from './amiMessage.js';

/**
 * Asterisk Manager Interface client.
 *
 * Scope: exactly the actions and events a call adapter needs — connect, log in,
 * send one action and await its reply, observe asynchronous events, and probe
 * liveness. It is not a general AMI library.
 *
 * Failure policy
 * --------------
 * An unreachable PBX, a rejected login and a timed-out action all surface as
 * `AppError(PROVIDER_UNAVAILABLE)`. They are never converted into an empty
 * successful result: the caller has to be able to tell "Asterisk said no" from
 * "Asterisk never answered", and an operator has to be able to alert on both.
 */

export interface AmiClientOptions {
  host: string;
  port: number;
  username: string;
  secret: string;
  logger?: Logger;
  /** How long to wait for the socket to open before failing. */
  connectTimeoutMs?: number;
  /** How long to wait for a reply to an action. */
  actionTimeoutMs?: number;
  /**
   * Socket factory. Defaults to `net.createConnection`; tests inject a fake so
   * the codec and correlation logic run against scripted bytes without a PBX.
   */
  createConnection?: (options: net.NetConnectOpts) => net.Socket;
}

export interface AmiEvent {
  name: string;
  fields: AmiFields;
}

/**
 * The AMI surface this adapter depends on.
 *
 * Declared separately from `AmiClient` so the telephony provider can be tested
 * against a scripted double without a PBX: a class with private fields is
 * nominally typed, so the concrete client could never be faked.
 */
export interface AmiClientPort {
  readonly connected: boolean;
  connect(): Promise<void>;
  close(): Promise<void>;
  onEvent(handler: (event: AmiEvent) => void): () => void;
  newActionId(): string;
  sendAction(
    verb: string,
    params?: Record<string, string | number | undefined>,
    timeoutMs?: number,
  ): Promise<AmiFields>;
  waitForEvent(predicate: (event: AmiEvent) => boolean, timeoutMs?: number): Promise<AmiEvent>;
  ping(timeoutMs?: number): Promise<void>;
}

interface PendingAction {
  resolve: (fields: AmiFields) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_ACTION_TIMEOUT_MS = 10_000;

export class AmiClient implements AmiClientPort {
  private readonly logger: Logger;
  private readonly options: Required<Pick<AmiClientOptions, 'connectTimeoutMs' | 'actionTimeoutMs'>> &
    AmiClientOptions;

  private socket: net.Socket | null = null;
  /**
   * Id of the connection currently allowed to touch this client.
   *
   * A replaced socket keeps emitting events for a while after it was written
   * off — `close` in particular arrives asynchronously. Comparing against a
   * token taken per connection means those late events are ignored instead of
   * tearing down the connection that replaced them.
   */
  private connectionToken = 0;
  private buffer = '';
  private loginInFlight: Promise<void> | null = null;
  private readonly pending = new Map<string, PendingAction>();
  private readonly eventHandlers = new Set<(event: AmiEvent) => void>();
  private sequence = 0;
  private closed = false;

  constructor(options: AmiClientOptions) {
    this.options = {
      connectTimeoutMs: DEFAULT_CONNECT_TIMEOUT_MS,
      actionTimeoutMs: DEFAULT_ACTION_TIMEOUT_MS,
      ...options,
    };
    this.logger = options.logger ?? noopLogger;
  }

  get connected(): boolean {
    return this.socket !== null && !this.closed;
  }

  /** Subscribes to asynchronous events. Returns an unsubscribe function. */
  onEvent(handler: (event: AmiEvent) => void): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  /** Connects and authenticates. Idempotent while a login is in flight. */
  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.loginInFlight) return this.loginInFlight;

    this.loginInFlight = this.doConnect().finally(() => {
      this.loginInFlight = null;
    });
    return this.loginInFlight;
  }

  private async doConnect(): Promise<void> {
    const token = (this.connectionToken += 1);
    const create = this.options.createConnection ?? ((opts) => net.createConnection(opts));
    const socket = create({ host: this.options.host, port: this.options.port });
    socket.setEncoding('utf8');
    this.closed = false;

    // Listeners are attached before the connect resolves: Asterisk sends its
    // banner (`Asterisk Call Manager/x.y.z`) as soon as the socket opens, and a
    // listener attached a tick later would lose those bytes.
    socket.on('data', (chunk: string) => {
      if (this.connectionToken !== token) return;
      this.onData(chunk);
    });
    socket.on('error', (error: Error) => {
      if (this.connectionToken !== token) return;
      this.failAll(error);
    });
    socket.on('close', () => {
      if (this.connectionToken !== token) return;
      this.socket = null;
      this.failAll(new AppError(ErrorCode.PROVIDER_UNAVAILABLE, 'The AMI connection closed.', 503));
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(
          new AppError(
            ErrorCode.PROVIDER_UNAVAILABLE,
            `Timed out connecting to Asterisk AMI at ${this.options.host}:${this.options.port}.`,
            503,
            { host: this.options.host, port: this.options.port },
          ),
        );
      }, this.options.connectTimeoutMs);

      const onError = (error: Error): void => {
        clearTimeout(timer);
        reject(
          new AppError(
            ErrorCode.PROVIDER_UNAVAILABLE,
            `Could not reach Asterisk AMI at ${this.options.host}:${this.options.port}: ${error.message}`,
            503,
            { host: this.options.host, port: this.options.port },
          ),
        );
      };

      socket.once('error', onError);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.off('error', onError);
        resolve();
      });
    });

    this.socket = socket;

    const login = await this.sendAction('Login', { Username: this.options.username, Secret: this.options.secret });
    if (login.Response !== 'Success') {
      const message = login.Message ?? 'AMI login was rejected.';
      socket.destroy();
      this.socket = null;
      throw new AppError(ErrorCode.PROVIDER_UNAVAILABLE, `Asterisk rejected the AMI login: ${message}`, 503);
    }

    // Acknowledge events explicitly so a PBX configured with `events=off` by
    // default still delivers them; if the account forbids it the action fails
    // and we carry on, because originate/hangup/probe do not depend on events.
    await this.sendAction('Events', { EventMask: 'on' }).catch((error: unknown) => {
      this.logger.warn({ reason: (error as Error).message }, 'could not enable AMI events');
    });

    this.logger.info({ host: this.options.host, port: this.options.port }, 'connected to Asterisk AMI');
  }

  /** A fresh id for correlating an action with its asynchronous event. */
  newActionId(): string {
    this.sequence += 1;
    return `${process.pid}-${this.sequence}`;
  }

  /** Sends one action and resolves with its reply headers. */
  async sendAction(
    verb: string,
    params: Record<string, string | number | undefined> = {},
    timeoutMs: number = this.options.actionTimeoutMs,
  ): Promise<AmiFields> {
    const socket = this.socket;
    if (!socket) {
      throw new AppError(ErrorCode.PROVIDER_UNAVAILABLE, 'The AMI connection is not open.', 503);
    }

    const actionId = typeof params.ActionID === 'string' ? params.ActionID : this.newActionId();

    const reply = new Promise<AmiFields>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(actionId);
        reject(
          new AppError(
            ErrorCode.PROVIDER_TIMEOUT,
            `Asterisk did not answer the '${verb}' action within ${timeoutMs} ms.`,
            504,
            { action: verb, actionId },
          ),
        );
      }, timeoutMs);
      this.pending.set(actionId, { resolve, reject, timer });
    });

    socket.write(serializeAmiAction(verb, { ...params, ActionID: actionId }));
    return reply;
  }

  /**
   * Resolves with the first event matching `predicate`.
   *
   * Used for outcomes AMI reports asynchronously rather than in the action
   * reply — `OriginateResponse` being the one this adapter depends on.
   */
  waitForEvent(
    predicate: (event: AmiEvent) => boolean,
    timeoutMs: number = this.options.actionTimeoutMs,
  ): Promise<AmiEvent> {
    return new Promise<AmiEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(
          new AppError(ErrorCode.PROVIDER_TIMEOUT, `No matching AMI event arrived within ${timeoutMs} ms.`, 504),
        );
      }, timeoutMs);
      const off = this.onEvent((event) => {
        if (!predicate(event)) return;
        clearTimeout(timer);
        off();
        resolve(event);
      });
    });
  }

  /** Liveness probe. Resolves when Asterisk answers `Ping`. */
  async ping(timeoutMs?: number): Promise<void> {
    if (!this.connected) await this.connect();
    const reply = await this.sendAction('Ping', {}, timeoutMs);
    if (reply.Response !== 'Success') {
      throw new AppError(ErrorCode.PROVIDER_UNAVAILABLE, `Asterisk answered Ping with '${reply.Response ?? 'nothing'}'.`, 503);
    }
  }

  /** Closes the socket and fails anything still waiting. */
  async close(): Promise<void> {
    this.closed = true;
    const socket = this.socket;
    this.socket = null;
    this.failAll(new AppError(ErrorCode.PROVIDER_UNAVAILABLE, 'The AMI client was closed.', 503));
    if (!socket) return;
    await new Promise<void>((resolve) => socket.end(() => resolve()));
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    // Asterisk greets with a banner line before any framed message; drop it so
    // it cannot be mistaken for a header of the first real message.
    if (this.buffer.startsWith('Asterisk Call Manager')) {
      const newline = this.buffer.indexOf('\r\n');
      if (newline !== -1) this.buffer = this.buffer.slice(newline + 2);
    }
    const { messages, rest } = parseAmiBuffer(this.buffer);
    this.buffer = rest;
    for (const message of messages) this.dispatch(message);
  }

  private dispatch(message: AmiMessage): void {
    // Replies to actions carry a `Response` header and our `ActionID`; anything
    // else is an asynchronous event. `OriginateResponse` is special: it is an
    // event that also settles an Originate action.
    if (message.response !== undefined && message.actionId) {
      const pending = this.pending.get(message.actionId);
      if (pending) {
        this.pending.delete(message.actionId);
        clearTimeout(pending.timer);
        pending.resolve(message.fields);
        return;
      }
    }

    if (message.event !== undefined) {
      const event: AmiEvent = { name: message.event, fields: message.fields };
      for (const handler of this.eventHandlers) {
        try {
          handler(event);
        } catch (error) {
          this.logger.error({ event: message.event, reason: (error as Error).message }, 'AMI event handler threw');
        }
      }
    }
  }

  private failAll(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
