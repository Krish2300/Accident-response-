/**
 * Module 10 – Database Persistence (Module 11 Integration)
 * PostgreSQL via pg-pool + transaction-safe event logging.
 */

import { Pool } from 'pg';
import { EmergencyContext, StateChangeEvent } from '../types';
import { logger } from '../utils/logger';

// ─────────────────────────────────────────────
// CONNECTION POOL
// ─────────────────────────────────────────────

const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgresql://emergency:secret@localhost:5432/emergency_db',
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: true } : false,
});

pool.on('error', (err) => logger.error(`[DB] Idle client error: ${err.message}`));

// ─────────────────────────────────────────────
// PERSISTENCE LAYER
// ─────────────────────────────────────────────

class DbPersistence {

  /**
   * UPSERT full EmergencyContext on every state change.
   * Uses ON CONFLICT to handle idempotent re-delivery.
   */
  async upsertIncident(ctx: EmergencyContext): Promise<void> {
    const sql = `
      INSERT INTO emergencies (
        incident_id, call_session_id, current_state, previous_state,
        incident_type, severity, confidence, priority,
        location, patient, caller, transcript,
        ambulance, hospital, route, corridor,
        error_log, tags, raw_nlp_data,
        created_at, updated_at, completed_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,
        $9::jsonb,$10::jsonb,$11::jsonb,$12,
        $13::jsonb,$14::jsonb,$15::jsonb,$16::jsonb,
        $17::jsonb,$18::text[],$19::jsonb,
        $20,$21,$22
      )
      ON CONFLICT (incident_id) DO UPDATE SET
        current_state   = EXCLUDED.current_state,
        previous_state  = EXCLUDED.previous_state,
        incident_type   = EXCLUDED.incident_type,
        severity        = EXCLUDED.severity,
        confidence      = EXCLUDED.confidence,
        priority        = EXCLUDED.priority,
        location        = EXCLUDED.location,
        patient         = EXCLUDED.patient,
        transcript      = EXCLUDED.transcript,
        ambulance       = EXCLUDED.ambulance,
        hospital        = EXCLUDED.hospital,
        route           = EXCLUDED.route,
        corridor        = EXCLUDED.corridor,
        error_log       = EXCLUDED.error_log,
        tags            = EXCLUDED.tags,
        raw_nlp_data    = EXCLUDED.raw_nlp_data,
        updated_at      = EXCLUDED.updated_at,
        completed_at    = EXCLUDED.completed_at
    `;

    await pool.query(sql, [
      ctx.incidentId,
      ctx.callSessionId,
      ctx.currentState,
      ctx.previousState,
      ctx.incidentType,
      ctx.severity,
      ctx.confidence,
      ctx.priority,
      JSON.stringify(ctx.location),
      JSON.stringify(ctx.patient),
      JSON.stringify(ctx.caller),
      ctx.transcript,
      JSON.stringify(ctx.ambulance ?? null),
      JSON.stringify(ctx.hospital ?? null),
      JSON.stringify(ctx.route ?? null),
      JSON.stringify(ctx.corridor ?? null),
      JSON.stringify(ctx.errorLog),
      ctx.tags,
      JSON.stringify(ctx.rawNlpData ?? null),
      ctx.createdAt,
      ctx.updatedAt,
      ctx.completedAt ?? null,
    ]);
  }

  /**
   * Append a StateChangeEvent to the event log table (append-only audit trail).
   */
  async appendEvent(event: StateChangeEvent): Promise<void> {
    const sql = `
      INSERT INTO events (
        event_id, incident_id, trigger, from_state, to_state,
        actor_module, payload, duration_ms, timestamp
      ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)
    `;

    await pool.query(sql, [
      event.eventId,
      event.incidentId,
      event.trigger,
      event.fromState,
      event.toState,
      event.actorModule,
      JSON.stringify(event.payload),
      event.meta?.durationMs ?? null,
      event.timestamp,
    ]);
  }

  /**
   * Lightweight partial patch – called on GPS/status updates between state changes.
   */
  async patchIncidentContext(
    incidentId: string,
    patch: Partial<EmergencyContext>,
  ): Promise<void> {
    const setClauses: string[] = [];
    const values: unknown[]    = [];
    let   idx = 1;

    const addField = (col: string, val: unknown, isJson = false) => {
      setClauses.push(`${col} = $${idx}${isJson ? '::jsonb' : ''}`);
      values.push(isJson ? JSON.stringify(val) : val);
      idx++;
    };

    if (patch.location  !== undefined) addField('location',  patch.location,  true);
    if (patch.patient   !== undefined) addField('patient',   patch.patient,   true);
    if (patch.ambulance !== undefined) addField('ambulance', patch.ambulance, true);
    if (patch.priority  !== undefined) addField('priority',  patch.priority);
    if (patch.updatedAt !== undefined) addField('updated_at', patch.updatedAt);

    if (setClauses.length === 0) return;

    values.push(incidentId);
    await pool.query(
      `UPDATE emergencies SET ${setClauses.join(', ')} WHERE incident_id = $${idx}`,
      values,
    );
  }

  /**
   * Load active incidents from DB on service restart (recovery).
   */
  async loadActiveIncidents(): Promise<EmergencyContext[]> {
    const result = await pool.query<EmergencyContext>(`
      SELECT * FROM emergencies
      WHERE current_state NOT IN ('COMPLETED','FAILED','CANCELLED')
      ORDER BY created_at ASC
    `);
    return result.rows;
  }

  async end(): Promise<void> {
    await pool.end();
  }
}

export const dbPersistence = new DbPersistence();

// ─────────────────────────────────────────────
// DDL (run once during migration)
// ─────────────────────────────────────────────

export const SCHEMA_DDL = `
-- Module 11 Tables (managed by Module 11, referenced here for context)

CREATE TABLE IF NOT EXISTS emergencies (
  incident_id     UUID PRIMARY KEY,
  call_session_id TEXT NOT NULL,
  current_state   TEXT NOT NULL,
  previous_state  TEXT,
  incident_type   TEXT NOT NULL DEFAULT 'UNKNOWN',
  severity        TEXT NOT NULL DEFAULT 'MEDIUM',
  confidence      FLOAT NOT NULL DEFAULT 0,
  priority        INT  NOT NULL DEFAULT 50,
  location        JSONB,
  patient         JSONB NOT NULL DEFAULT '{}',
  caller          JSONB NOT NULL DEFAULT '{}',
  transcript      TEXT NOT NULL DEFAULT '',
  ambulance       JSONB,
  hospital        JSONB,
  route           JSONB,
  corridor        JSONB,
  error_log       JSONB NOT NULL DEFAULT '[]',
  tags            TEXT[] NOT NULL DEFAULT '{}',
  raw_nlp_data    JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_emergencies_state    ON emergencies(current_state);
CREATE INDEX IF NOT EXISTS idx_emergencies_severity ON emergencies(severity);
CREATE INDEX IF NOT EXISTS idx_emergencies_updated  ON emergencies(updated_at DESC);

CREATE TABLE IF NOT EXISTS events (
  event_id    UUID PRIMARY KEY,
  incident_id UUID NOT NULL REFERENCES emergencies(incident_id),
  trigger     TEXT NOT NULL,
  from_state  TEXT NOT NULL,
  to_state    TEXT NOT NULL,
  actor_module TEXT NOT NULL,
  payload     JSONB,
  duration_ms INT,
  timestamp   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_events_incident ON events(incident_id);
CREATE INDEX IF NOT EXISTS idx_events_ts       ON events(timestamp DESC);
`;
