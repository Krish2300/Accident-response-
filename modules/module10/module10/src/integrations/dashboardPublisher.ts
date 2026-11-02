/**
 * Module 10 – Dashboard Publisher (Module 12 Integration)
 * WebSocket broadcast via Socket.IO server adapter.
 * Also writes to Redis for fan-out to horizontally-scaled dashboard nodes.
 */

import { Server as SocketIOServer } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';
import { StateChangeEvent, EmergencyContext, IncidentSeverity } from '../types';
import { logger } from '../utils/logger';

// ─────────────────────────────────────────────
// WEBSOCKET ROOM NAMING CONVENTIONS
// ─────────────────────────────────────────────

export const WS_ROOMS = {
  allDashboards: 'dashboard:all',
  incident: (id: string) => `incident:${id}`,
} as const;

// ─────────────────────────────────────────────
// SOCKET.IO EVENT NAMES
// ─────────────────────────────────────────────

export const WS_EVENTS = {
  STATE_CHANGED:    'emergency:stateChanged',
  CONTEXT_PATCH:    'emergency:contextPatch',
  ALERT:            'emergency:alert',
  INCIDENT_SUMMARY: 'emergency:summary',
} as const;

// ─────────────────────────────────────────────
// ALERT PAYLOAD
// ─────────────────────────────────────────────

export interface AlertPayload {
  incidentId: string;
  alertType:  'TIMEOUT' | 'INCIDENT_FAILED' | 'MODULE_ERROR' | 'MANUAL_OVERRIDE';
  message:    string;
  severity:   IncidentSeverity;
  timestamp?: string;
}

// ─────────────────────────────────────────────
// DASHBOARD PUBLISHER
// ─────────────────────────────────────────────

class DashboardPublisher {
  private io: SocketIOServer | null = null;

  /**
   * Call once during server bootstrap with your HTTP server.
   */
  async initialize(httpServer: unknown): Promise<void> {
    this.io = new SocketIOServer(httpServer as any, {
      cors: {
        origin:  process.env.DASHBOARD_ORIGIN ?? 'http://localhost:3000',
        methods: ['GET', 'POST'],
      },
      transports: ['websocket', 'polling'],
    });

    // Redis adapter for multi-node deployments
    const pubClient = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' });
    const subClient = pubClient.duplicate();
    await Promise.all([pubClient.connect(), subClient.connect()]);
    this.io.adapter(createAdapter(pubClient as any, subClient as any));

    this.io.on('connection', (socket) => {
      logger.info(`[Dashboard] Client connected: ${socket.id}`);

      // Client subscribes to specific incident room
      socket.on('subscribe:incident', (incidentId: string) => {
        socket.join(WS_ROOMS.incident(incidentId));
        logger.debug(`[Dashboard] ${socket.id} subscribed to ${incidentId}`);
      });

      socket.on('unsubscribe:incident', (incidentId: string) => {
        socket.leave(WS_ROOMS.incident(incidentId));
      });

      // All dashboard operators join global room
      socket.join(WS_ROOMS.allDashboards);

      socket.on('disconnect', () => {
        logger.debug(`[Dashboard] Client disconnected: ${socket.id}`);
      });
    });

    logger.info('[Dashboard] WebSocket server initialized');
  }

  /**
   * Broadcast a state change to all relevant rooms.
   */
  async publishStateChange(event: StateChangeEvent): Promise<void> {
    if (!this.io) return;

    const payload = {
      incidentId: event.incidentId,
      fromState:  event.fromState,
      toState:    event.toState,
      trigger:    event.trigger,
      timestamp:  event.timestamp,
      actorModule: event.actorModule,
      priority:   (event.payload as EmergencyContext).priority,
      severity:   (event.payload as EmergencyContext).severity,
      ambulance:  (event.payload as EmergencyContext).ambulance,
      hospital:   (event.payload as EmergencyContext).hospital,
      route:      (event.payload as EmergencyContext).route,
      corridor:   (event.payload as EmergencyContext).corridor,
    };

    // Broadcast to incident room (paramedics / supervisors tracking this incident)
    this.io.to(WS_ROOMS.incident(event.incidentId)).emit(WS_EVENTS.STATE_CHANGED, payload);

    // Broadcast summary to global dashboard operators
    this.io.to(WS_ROOMS.allDashboards).emit(WS_EVENTS.INCIDENT_SUMMARY, {
      incidentId: event.incidentId,
      state:      event.toState,
      severity:   (event.payload as EmergencyContext).severity,
      priority:   (event.payload as EmergencyContext).priority,
      timestamp:  event.timestamp,
    });

    logger.debug(`[Dashboard] Published state change for ${event.incidentId}: ${event.fromState}→${event.toState}`);
  }

  /**
   * Publish lightweight context patch (GPS updates, patient data changes).
   */
  async publishContextPatch(ctx: EmergencyContext): Promise<void> {
    if (!this.io) return;

    this.io.to(WS_ROOMS.incident(ctx.incidentId)).emit(WS_EVENTS.CONTEXT_PATCH, {
      incidentId: ctx.incidentId,
      location:   ctx.location,
      ambulance:  ctx.ambulance,
      patient:    ctx.patient,
      priority:   ctx.priority,
      updatedAt:  ctx.updatedAt,
    });
  }

  /**
   * Publish an alert to all dashboard operators.
   */
  publishAlert(alert: AlertPayload): void {
    if (!this.io) return;

    const payload = { ...alert, timestamp: alert.timestamp ?? new Date().toISOString() };
    this.io.to(WS_ROOMS.allDashboards).emit(WS_EVENTS.ALERT, payload);
    this.io.to(WS_ROOMS.incident(alert.incidentId)).emit(WS_EVENTS.ALERT, payload);

    logger.warn(`[Dashboard] Alert: [${alert.alertType}] ${alert.message}`);
  }

  getIO(): SocketIOServer | null { return this.io; }
}

export const dashboardPublisher = new DashboardPublisher();
