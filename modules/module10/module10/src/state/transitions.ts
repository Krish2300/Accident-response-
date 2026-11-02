/**
 * Module 10 – Finite State Machine Core
 * Defines the transition table and guards.
 */

import {
  IncidentState,
  IncidentSeverity,
  TransitionTrigger,
  TransitionMap,
  EmergencyContext,
} from '../types';

// ─────────────────────────────────────────────
// VALID TRANSITION TABLE
// ─────────────────────────────────────────────

export const TRANSITION_TABLE: TransitionMap = {
  [IncidentState.NEW]: {
    [TransitionTrigger.CALL_RECEIVED]:    IncidentState.CALL_ACTIVE,
    [TransitionTrigger.CANCEL_INCIDENT]:  IncidentState.CANCELLED,
  },
  [IncidentState.CALL_ACTIVE]: {
    [TransitionTrigger.SPEECH_TRANSCRIBED]:     IncidentState.ANALYZING,
    [TransitionTrigger.CANCEL_INCIDENT]:        IncidentState.CANCELLED,
    [TransitionTrigger.TIMEOUT]:                IncidentState.FAILED,
  },
  [IncidentState.ANALYZING]: {
    [TransitionTrigger.NLP_CLASSIFICATION_DONE]: IncidentState.CLASSIFIED,
    [TransitionTrigger.MODULE_FAILURE]:          IncidentState.ANALYZING,  // retry in same state
    [TransitionTrigger.CANCEL_INCIDENT]:         IncidentState.CANCELLED,
    [TransitionTrigger.TIMEOUT]:                 IncidentState.FAILED,
  },
  [IncidentState.CLASSIFIED]: {
    [TransitionTrigger.RESPONSE_DECISION_MADE]: IncidentState.RESPONSE_INITIATED,
    [TransitionTrigger.CANCEL_INCIDENT]:        IncidentState.CANCELLED,
  },
  [IncidentState.RESPONSE_INITIATED]: {
    [TransitionTrigger.AMBULANCE_DISPATCHED]: IncidentState.AMBULANCE_ASSIGNED,
    [TransitionTrigger.MODULE_FAILURE]:       IncidentState.RESPONSE_INITIATED, // retry
    [TransitionTrigger.CANCEL_INCIDENT]:      IncidentState.CANCELLED,
    [TransitionTrigger.TIMEOUT]:              IncidentState.FAILED,
  },
  [IncidentState.AMBULANCE_ASSIGNED]: {
    [TransitionTrigger.ROUTE_CALCULATED]: IncidentState.ROUTE_GENERATED,
    [TransitionTrigger.MODULE_FAILURE]:   IncidentState.AMBULANCE_ASSIGNED, // retry
    [TransitionTrigger.CANCEL_INCIDENT]:  IncidentState.CANCELLED,
    [TransitionTrigger.TIMEOUT]:          IncidentState.FAILED,
  },
  [IncidentState.ROUTE_GENERATED]: {
    [TransitionTrigger.CORRIDOR_ACTIVATED]: IncidentState.CORRIDOR_ACTIVE,
    [TransitionTrigger.MODULE_FAILURE]:     IncidentState.ROUTE_GENERATED,  // retry
    [TransitionTrigger.CANCEL_INCIDENT]:    IncidentState.CANCELLED,
    [TransitionTrigger.TIMEOUT]:            IncidentState.FAILED,
  },
  [IncidentState.CORRIDOR_ACTIVE]: {
    [TransitionTrigger.PATIENT_ARRIVED]:  IncidentState.HOSPITAL_ARRIVAL,
    [TransitionTrigger.CANCEL_INCIDENT]:  IncidentState.CANCELLED,
    [TransitionTrigger.TIMEOUT]:          IncidentState.FAILED,
  },
  [IncidentState.HOSPITAL_ARRIVAL]: {
    [TransitionTrigger.INCIDENT_RESOLVED]: IncidentState.COMPLETED,
    [TransitionTrigger.CANCEL_INCIDENT]:   IncidentState.CANCELLED,
  },
  // Terminal states – no further transitions
  [IncidentState.COMPLETED]:  {},
  [IncidentState.FAILED]:     { [TransitionTrigger.RETRY]: IncidentState.RESPONSE_INITIATED },
  [IncidentState.CANCELLED]:  {},
};

// ─────────────────────────────────────────────
// GUARD CONDITIONS
// ─────────────────────────────────────────────

export type Guard = (ctx: EmergencyContext) => boolean | string; // string = failure reason

export const TRANSITION_GUARDS: Partial<Record<
  `${IncidentState}->${IncidentState}`,
  Guard
>> = {
  [`${IncidentState.CLASSIFIED}->${IncidentState.RESPONSE_INITIATED}`]: (ctx) => {
    if (!ctx.location) return 'Location is required before dispatching response';
    if (ctx.confidence < 0.4) return 'NLP confidence too low to auto-dispatch';
    return true;
  },
  [`${IncidentState.RESPONSE_INITIATED}->${IncidentState.AMBULANCE_ASSIGNED}`]: (ctx) => {
    if (!ctx.ambulance) return 'Ambulance assignment missing';
    return true;
  },
  [`${IncidentState.AMBULANCE_ASSIGNED}->${IncidentState.ROUTE_GENERATED}`]: (ctx) => {
    if (!ctx.hospital) return 'Hospital selection required before route calculation';
    if (!ctx.ambulance) return 'Ambulance must be assigned before calculating route';
    return true;
  },
  [`${IncidentState.ROUTE_GENERATED}->${IncidentState.CORRIDOR_ACTIVE}`]: (ctx) => {
    if (!ctx.route) return 'Route information missing';
    return true;
  },
};

// ─────────────────────────────────────────────
// PRIORITY SCORING
// ─────────────────────────────────────────────

const SEVERITY_SCORE: Record<IncidentSeverity, number> = {
  [IncidentSeverity.CRITICAL]: 100,
  [IncidentSeverity.HIGH]:      75,
  [IncidentSeverity.MEDIUM]:    50,
  [IncidentSeverity.LOW]:       25,
};

export function computePriority(ctx: EmergencyContext): number {
  let score = SEVERITY_SCORE[ctx.severity] ?? 50;

  // Boost for confirmed unconsciousness
  if (ctx.patient.consciousnessLevel === 'UNCONSCIOUS') score += 20;

  // Boost for abnormal breathing
  if (ctx.patient.breathingNormally === false) score += 15;

  // Confidence-weighted adjustment
  score = score * (0.5 + ctx.confidence * 0.5);

  return Math.min(Math.round(score), 150);
}

// ─────────────────────────────────────────────
// TIMEOUT THRESHOLDS PER STATE (ms)
// ─────────────────────────────────────────────

export const STATE_TIMEOUT_MS: Partial<Record<IncidentState, number>> = {
  [IncidentState.CALL_ACTIVE]:        120_000,  // 2 min – wait for transcription
  [IncidentState.ANALYZING]:           30_000,  // 30 s  – NLP must respond
  [IncidentState.RESPONSE_INITIATED]:  60_000,  // 1 min – ambulance dispatch
  [IncidentState.AMBULANCE_ASSIGNED]:  45_000,  // 45 s  – route calculation
  [IncidentState.ROUTE_GENERATED]:     30_000,  // 30 s  – corridor activation
  [IncidentState.CORRIDOR_ACTIVE]:   3600_000,  // 1 hr  – patient in transit
};

export const MAX_RETRIES_PER_STATE: Partial<Record<IncidentState, number>> = {
  [IncidentState.ANALYZING]:          3,
  [IncidentState.RESPONSE_INITIATED]: 3,
  [IncidentState.AMBULANCE_ASSIGNED]: 2,
  [IncidentState.ROUTE_GENERATED]:    2,
};
