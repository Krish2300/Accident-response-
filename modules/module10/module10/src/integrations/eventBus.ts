/**
 * Module 10 – Event Bus Integration
 * Redis Pub/Sub (primary) with Kafka fallback option.
 * Publishes StateChangeEvents and outcomes for Module 11/12 + other consumers.
 */

import { createClient, RedisClientType } from 'redis';
import { logger } from '../utils/logger';

// ─────────────────────────────────────────────
// CHANNELS / TOPICS
// ─────────────────────────────────────────────

export const CHANNELS = {
  STATE_CHANGED:  'emergency.state_changed',
  OUTCOME:        'emergency.outcome',
  ALERT:          'emergency.alert',
  CONTEXT_PATCH:  'emergency.context_patch',
} as const;

export type Channel = typeof CHANNELS[keyof typeof CHANNELS];

// ─────────────────────────────────────────────
// REDIS EVENT BUS
// ─────────────────────────────────────────────

class RedisEventBus {
  private publisher: RedisClientType;
  private subscribers = new Map<string, RedisClientType>();

  constructor() {
    this.publisher = createClient({
      url: process.env.REDIS_URL ?? 'redis://localhost:6379',
      socket: { reconnectStrategy: (retries) => Math.min(retries * 100, 3000) },
    }) as RedisClientType;

    this.publisher.on('error', (err) => logger.error(`[EventBus] Redis publisher error: ${err}`));
    this.publisher.on('ready', ()  => logger.info('[EventBus] Redis publisher connected'));
  }

  async connect(): Promise<void> {
    await this.publisher.connect();
  }

  /**
   * Publish an event to a Redis channel.
   * Uses XADD (Streams) for durable fan-out; falls back to PUBLISH for ephemeral.
   */
  async publish(channel: string, payload: unknown): Promise<void> {
    const data = JSON.stringify(payload);
    try {
      // Redis Streams: durable, consumer-group aware
      await (this.publisher as any).xAdd(channel, '*', { data });
    } catch (err) {
      // Ephemeral fallback
      logger.warn(`[EventBus] XADD failed, falling back to PUBLISH: ${err}`);
      await this.publisher.publish(channel, data);
    }
  }

  /**
   * Subscribe to a channel with a consumer group.
   * cb receives parsed JSON objects.
   */
  async subscribe<T>(
    channel: string,
    group: string,
    consumer: string,
    cb: (payload: T) => Promise<void>,
  ): Promise<void> {
    const subClient = createClient({
      url: process.env.REDIS_URL ?? 'redis://localhost:6379',
    }) as RedisClientType;
    await subClient.connect();
    this.subscribers.set(`${channel}:${group}:${consumer}`, subClient);

    // Ensure stream + group exist
    try {
      await (subClient as any).xGroupCreate(channel, group, '$', { MKSTREAM: true });
    } catch { /* group already exists */ }

    // Poll loop
    const poll = async () => {
      while (true) {
        try {
          const results: any[] = await (subClient as any).xReadGroup(
            group, consumer,
            [{ key: channel, id: '>' }],
            { COUNT: 10, BLOCK: 5000 },
          ) ?? [];

          for (const stream of results) {
            for (const msg of stream.messages) {
              try {
                const payload = JSON.parse(msg.message.data) as T;
                await cb(payload);
                await (subClient as any).xAck(channel, group, msg.id);
              } catch (err) {
                logger.error(`[EventBus] Consumer error on ${channel}: ${err}`);
              }
            }
          }
        } catch (err) {
          logger.error(`[EventBus] Stream read error: ${err}`);
          await new Promise(r => setTimeout(r, 1000));
        }
      }
    };

    poll().catch(err => logger.error(`[EventBus] Poll loop crashed: ${err}`));
  }

  async disconnect(): Promise<void> {
    await this.publisher.disconnect();
    for (const client of this.subscribers.values()) {
      await client.disconnect();
    }
  }
}

export const eventBus = new RedisEventBus();
