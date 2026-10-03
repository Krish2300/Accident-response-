import {
  REALTIME_CHANNELS,
  type Logger,
  type RealtimeChannel,
  type RealtimeMessage,
  type RealtimePublisherPort,
  createConsoleLogger,
} from '@resus/core';

/**
 * WebSocket fan-out.
 *
 * Implements `RealtimePublisherPort` for the in-process hub. Modules never hold
 * socket handles — they publish to a channel and this decides who receives it,
 * which is what keeps the domain modules transport-agnostic.
 */

/** Transport-neutral shape, so the hub does not depend on a WebSocket library. */
export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readyState?: number;
}

export const SOCKET_OPEN = 1;

interface Client {
  id: string;
  socket: SocketLike;
  channels: Set<RealtimeChannel>;
}

export class RealtimeHub implements RealtimePublisherPort {
  private readonly clients = new Map<string, Client>();
  private readonly logger: Logger;
  private counter = 0;
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(options: { logger?: Logger; heartbeatMs?: number } = {}) {
    this.logger = options.logger ?? createConsoleLogger('info', 'server.realtime');
    const interval = options.heartbeatMs ?? 25_000;
    if (interval > 0) {
      this.heartbeat = setInterval(() => this.sendHeartbeat(), interval);
      // Never hold the process open just for heartbeats.
      this.heartbeat.unref();
    }
  }

  /**
   * Registers a socket. `requested` limits what the client will receive; a client
   * that asks for nothing is subscribed to every channel, which is the default
   * for the dashboard.
   */
  attach(socket: SocketLike, requested?: readonly string[]): { clientId: string; channels: RealtimeChannel[] } {
    this.counter += 1;
    const clientId = `ws-${Date.now().toString(36)}-${this.counter}`;
    const channels = normaliseChannels(requested);
    this.clients.set(clientId, { id: clientId, socket, channels: new Set(channels) });
    this.logger.info({ clientId, channels: channels.length }, 'realtime client attached');

    this.send(clientId, {
      kind: 'snapshot',
      channel: 'system',
      payload: { clientId, channels, attachedAt: new Date().toISOString() },
      timestamp: new Date().toISOString(),
    });
    return { clientId, channels };
  }

  detach(clientId: string): void {
    this.clients.delete(clientId);
    this.logger.info({ clientId, remaining: this.clients.size }, 'realtime client detached');
  }

  /** Narrows an attached client's channel set, acknowledging a subscribe frame. */
  resubscribe(clientId: string, requested?: readonly string[]): RealtimeChannel[] {
    const client = this.clients.get(clientId);
    if (!client) return [];
    const channels = normaliseChannels(requested);
    client.channels = new Set(channels);
    return channels;
  }

  /** `RealtimePublisherPort`. Called by Module 11 after a transaction commits. */
  publish(channel: RealtimeChannel, message: RealtimeMessage): void {
    const frame = JSON.stringify({ ...message, channel });
    for (const client of this.clients.values()) {
      if (!client.channels.has(channel)) continue;
      try {
        client.socket.send(frame);
      } catch (error) {
        this.logger.warn(
          { clientId: client.id, error: String(error) },
          'failed to write to client; detaching',
        );
        this.detach(client.id);
      }
    }
  }

  subscriberCount(channel: RealtimeChannel): number {
    let count = 0;
    for (const client of this.clients.values()) {
      if (client.channels.has(channel)) count += 1;
    }
    return count;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  private send(clientId: string, message: RealtimeMessage): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    try {
      client.socket.send(JSON.stringify(message));
    } catch {
      this.detach(clientId);
    }
  }

  private sendHeartbeat(): void {
    if (this.clients.size === 0) return;
    this.publish('system', {
      kind: 'heartbeat',
      channel: 'system',
      payload: { clients: this.clients.size },
      timestamp: new Date().toISOString(),
    });
  }

  dispose(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const client of this.clients.values()) {
      try {
        client.socket.close(1001, 'server shutting down');
      } catch {
        // Nothing useful to do while tearing down.
      }
    }
    this.clients.clear();
  }
}

function normaliseChannels(requested?: readonly string[]): RealtimeChannel[] {
  if (!requested || requested.length === 0) return [...REALTIME_CHANNELS];
  const valid = new Set<string>(REALTIME_CHANNELS);
  const filtered = requested.filter((c) => valid.has(c)) as RealtimeChannel[];
  // An entirely invalid request must not leave the client silently deaf.
  return filtered.length > 0 ? filtered : [...REALTIME_CHANNELS];
}