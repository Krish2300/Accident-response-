/**
 * Module 10 – Module API Client
 * Thin HTTP client wrapping downstream module REST APIs.
 */

import {
  IncidentSeverity,
  IncidentType,
  GeoLocation,
  Module3Payload,
  Module6Payload,
  Module7Payload,
  Module8Payload,
  Module9Payload,
} from '../types';
import { logger } from '../utils/logger';

// ─────────────────────────────────────────────
// CONFIG (from environment)
// ─────────────────────────────────────────────

const BASE_URLS = {
  MODULE_3: process.env.MODULE_3_URL ?? 'http://module-nlp:8003',
  MODULE_6: process.env.MODULE_6_URL ?? 'http://module-ambulance:8006',
  MODULE_7: process.env.MODULE_7_URL ?? 'http://module-hospital:8007',
  MODULE_8: process.env.MODULE_8_URL ?? 'http://module-route:8008',
  MODULE_9: process.env.MODULE_9_URL ?? 'http://module-corridor:8009',
};

const DEFAULT_TIMEOUT_MS = 15_000;

// ─────────────────────────────────────────────
// HTTP HELPER
// ─────────────────────────────────────────────

async function post<T>(url: string, body: unknown): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => 'unknown error');
      throw new Error(`HTTP ${res.status} from ${url}: ${errText}`);
    }

    return res.json() as Promise<T>;
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error(`Request to ${url} timed out after ${DEFAULT_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ─────────────────────────────────────────────
// MODULE API CALLS
// ─────────────────────────────────────────────

export const moduleApiClient = {

  /** Module 3 – NLP / LLM Classification */
  async classifyIncident(input: {
    transcript:   string;
    callSessionId: string;
    language:     string;
  }): Promise<Module3Payload> {
    logger.debug(`[ModuleAPI] POST ${BASE_URLS.MODULE_3}/classify`);
    return post<Module3Payload>(`${BASE_URLS.MODULE_3}/classify`, input);
  },

  /** Module 6 – Ambulance Assignment */
  async assignAmbulance(input: {
    incidentId:   string;
    location:     GeoLocation;
    severity:     IncidentSeverity;
    incidentType: IncidentType;
  }): Promise<Module6Payload> {
    logger.debug(`[ModuleAPI] POST ${BASE_URLS.MODULE_6}/assign`);
    return post<Module6Payload>(`${BASE_URLS.MODULE_6}/assign`, input);
  },

  /** Module 7 – Hospital Selection */
  async selectHospital(input: {
    incidentId:   string;
    location:     GeoLocation;
    incidentType: IncidentType;
    severity:     IncidentSeverity;
  }): Promise<Module7Payload> {
    logger.debug(`[ModuleAPI] POST ${BASE_URLS.MODULE_7}/select`);
    return post<Module7Payload>(`${BASE_URLS.MODULE_7}/select`, input);
  },

  /** Module 8 – Route Calculation */
  async calculateRoute(input: {
    incidentId:  string;
    origin:      GeoLocation;
    destination: GeoLocation;
    hospitalId:  string;
  }): Promise<Module8Payload> {
    logger.debug(`[ModuleAPI] POST ${BASE_URLS.MODULE_8}/calculate`);
    return post<Module8Payload>(`${BASE_URLS.MODULE_8}/calculate`, input);
  },

  /** Module 9 – Corridor / Geofence Activation */
  async activateCorridor(input: {
    incidentId:    string;
    routePolyline: string;
    ambulanceId:   string;
    severity:      IncidentSeverity;
  }): Promise<Module9Payload> {
    logger.debug(`[ModuleAPI] POST ${BASE_URLS.MODULE_9}/activate`);
    return post<Module9Payload>(`${BASE_URLS.MODULE_9}/activate`, input);
  },
};
