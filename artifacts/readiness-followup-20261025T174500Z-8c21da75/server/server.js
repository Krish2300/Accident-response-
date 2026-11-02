// apps/server/src/main.ts
import "dotenv/config";

// apps/server/src/config.ts
import { z } from "zod";
var LEVELS = ["debug", "info", "warn", "error"];
var serverConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4e3),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.enum(LEVELS).default("info"),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  JWT_SECRET: z.string().default(""),
  JWT_EXPIRES_IN: z.string().default("1h"),
  DATABASE_URL: z.string().optional(),
  // Media bridge. Defaults are usable, so a working deployment needs none of
  // these; they exist so the tuning that a real line needs can be changed
  // without a rebuild.
  ASTERISK_GREETING: z.string().default("Emergency line. Tell me what happened."),
  ASTERISK_GREETING_TONE: z.enum(["CALM", "URGENT", "REASSURING"]).default("CALM"),
  ASTERISK_SPEECH_RMS_THRESHOLD: z.coerce.number().min(0).max(32767).default(700),
  ASTERISK_HANGOVER_MS: z.coerce.number().int().min(100).max(1e4).default(800),
  ASTERISK_MIN_UTTERANCE_MS: z.coerce.number().int().min(0).max(1e4).default(400),
  ASTERISK_MAX_UTTERANCE_MS: z.coerce.number().int().min(1e3).max(6e5).default(3e4),
  ASTERISK_RESOLVE_TIMEOUT_MS: z.coerce.number().int().min(100).max(6e4).default(5e3),
  // Module 3 (external Python service). Off by default: it needs the service to
  // be running, and its LLM provider is configured on that side, not here.
  MODULE3_NLP_ENABLED: z.string().default("false").transform((value) => value.toLowerCase() === "true"),
  MODULE3_NLP_URL: z.string().default("http://127.0.0.1:8003"),
  MODULE3_NLP_TIMEOUT_MS: z.coerce.number().int().min(100).max(6e4).default(8e3),
  // Module 4 (conversation support). Off by default: localisation needs a
  // reviewed translation table to exist, and silence handling changes live-call
  // behaviour, so neither should switch on implicitly.
  MODULE4_LOCALISATION_ENABLED: z.string().default("false").transform((value) => value.toLowerCase() === "true"),
  MODULE4_TRANSLATIONS_FILE: z.string().default(""),
  MODULE4_SILENCE_TIMEOUT_MS: z.coerce.number().int().min(0).max(6e5).default(0),
  // The approved policy allows at most two silence-triggered re-prompts before the
  // conversation is escalated. The ceiling is enforced here so a deployment cannot
  // configure a longer loop than the policy permits.
  MODULE4_SILENCE_RETRY_LIMIT: z.coerce.number().int().min(0).max(2).default(2)
});
function loadServerConfig(env = process.env) {
  const parsed = serverConfigSchema.parse(env);
  const isProduction = parsed.NODE_ENV === "production";
  if (isProduction && (!parsed.JWT_SECRET || parsed.JWT_SECRET.length < 32)) {
    throw new Error(
      `JWT_SECRET must be set to at least 32 characters when NODE_ENV=production. Generate one with: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
    );
  }
  return {
    nodeEnv: parsed.NODE_ENV,
    isProduction,
    port: parsed.PORT,
    host: parsed.HOST,
    logLevel: parsed.LOG_LEVEL,
    corsOrigins: parsed.CORS_ORIGIN === "*" ? "*" : parsed.CORS_ORIGIN.split(",").map((o) => o.trim()),
    jwtSecret: parsed.JWT_SECRET || "development-only-insecure-secret",
    jwtExpiresIn: parsed.JWT_EXPIRES_IN,
    asterisk: {
      greeting: parsed.ASTERISK_GREETING,
      greetingTone: parsed.ASTERISK_GREETING_TONE,
      speechRmsThreshold: parsed.ASTERISK_SPEECH_RMS_THRESHOLD,
      hangoverMs: parsed.ASTERISK_HANGOVER_MS,
      minUtteranceMs: parsed.ASTERISK_MIN_UTTERANCE_MS,
      maxUtteranceMs: parsed.ASTERISK_MAX_UTTERANCE_MS,
      resolveTimeoutMs: parsed.ASTERISK_RESOLVE_TIMEOUT_MS
    },
    nlp: {
      enabled: parsed.MODULE3_NLP_ENABLED,
      baseUrl: parsed.MODULE3_NLP_URL,
      timeoutMs: parsed.MODULE3_NLP_TIMEOUT_MS
    },
    conversation: {
      localisationEnabled: parsed.MODULE4_LOCALISATION_ENABLED,
      translationsFile: parsed.MODULE4_TRANSLATIONS_FILE.trim() === "" ? null : parsed.MODULE4_TRANSLATIONS_FILE,
      silenceTimeoutMs: parsed.MODULE4_SILENCE_TIMEOUT_MS,
      silenceRetryLimit: parsed.MODULE4_SILENCE_RETRY_LIMIT
    }
  };
}

// apps/server/src/app.ts
import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import jwt from "@fastify/jwt";

// packages/core/src/env.ts
function readString(key, fallback2) {
  const raw = process.env[key];
  if (raw === void 0 || raw === "") {
    if (fallback2 !== void 0) return fallback2;
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return raw;
}
function readOptionalString(key) {
  const raw = process.env[key];
  return raw === void 0 || raw === "" ? void 0 : raw;
}
function readNumber(key, fallback2) {
  const raw = process.env[key];
  if (raw === void 0 || raw === "") return fallback2;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${key} must be a number, received '${raw}'.`);
  }
  return parsed;
}
function readEnum(key, allowed, fallback2) {
  const raw = process.env[key];
  if (raw === void 0 || raw === "") return fallback2;
  if (!allowed.includes(raw)) {
    throw new Error(`Environment variable ${key} must be one of ${allowed.join(", ")}.`);
  }
  return raw;
}

// packages/core/src/errors.ts
var ErrorCode = {
  // generic
  INTERNAL_ERROR: "INTERNAL_ERROR",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  RATE_LIMITED: "RATE_LIMITED",
  // LLM / module 5
  LLM_UNAVAILABLE: "LLM_UNAVAILABLE",
  LLM_TIMEOUT: "LLM_TIMEOUT",
  LLM_MODEL_NOT_FOUND: "LLM_MODEL_NOT_FOUND",
  LLM_MALFORMED_RESPONSE: "LLM_MALFORMED_RESPONSE",
  LLM_OUTPUT_SCHEMA_VIOLATION: "LLM_OUTPUT_SCHEMA_VIOLATION",
  PROTOCOL_NOT_FOUND: "PROTOCOL_NOT_FOUND",
  PROTOCOL_INVALID_TRANSITION: "PROTOCOL_INVALID_TRANSITION",
  PROTOCOL_STEP_NOT_ACTIONABLE: "PROTOCOL_STEP_NOT_ACTIONABLE",
  PROTOCOL_SESSION_NOT_FOUND: "PROTOCOL_SESSION_NOT_FOUND",
  PROTOCOL_ESCALATION_REQUIRED: "PROTOCOL_ESCALATION_REQUIRED",
  PROTOCOL_CATALOGUE_INVALID: "PROTOCOL_CATALOGUE_INVALID",
  CLARIFICATION_LIMIT_REACHED: "CLARIFICATION_LIMIT_REACHED",
  // ambulance / module 6
  AMBULANCE_NOT_FOUND: "AMBULANCE_NOT_FOUND",
  AMBULANCE_NOT_AVAILABLE: "AMBULANCE_NOT_AVAILABLE",
  AMBULANCE_INVALID_STATUS_TRANSITION: "AMBULANCE_INVALID_STATUS_TRANSITION",
  AMBULANCE_ALREADY_ASSIGNED: "AMBULANCE_ALREADY_ASSIGNED",
  AMBULANCE_NO_CANDIDATE: "AMBULANCE_NO_CANDIDATE",
  AMBULANCE_CREW_UNAVAILABLE: "AMBULANCE_CREW_UNAVAILABLE",
  // provider / transport / infrastructure (modules 1, 2, 8, 9)
  PROVIDER_UNAVAILABLE: "PROVIDER_UNAVAILABLE",
  PROVIDER_TIMEOUT: "PROVIDER_TIMEOUT",
  PROVIDER_MALFORMED_RESPONSE: "PROVIDER_MALFORMED_RESPONSE",
  PROVIDER_NOT_CONFIGURED: "PROVIDER_NOT_CONFIGURED",
  CALL_NOT_FOUND: "CALL_NOT_FOUND",
  CALL_ALREADY_ACTIVE: "CALL_ALREADY_ACTIVE",
  SPEECH_TRANSCRIPTION_FAILED: "SPEECH_TRANSCRIPTION_FAILED",
  SPEECH_SYNTHESIS_FAILED: "SPEECH_SYNTHESIS_FAILED",
  SPEECH_LANGUAGE_UNSUPPORTED: "SPEECH_LANGUAGE_UNSUPPORTED",
  ROUTING_FAILED: "ROUTING_FAILED",
  NO_ROUTE_AVAILABLE: "NO_ROUTE_AVAILABLE",
  POSITION_UNAVAILABLE: "POSITION_UNAVAILABLE",
  NOTIFICATION_FAILED: "NOTIFICATION_FAILED",
  // hospital / module 7
  HOSPITAL_NOT_FOUND: "HOSPITAL_NOT_FOUND",
  HOSPITAL_NO_SUITABLE_CANDIDATE: "HOSPITAL_NO_SUITABLE_CANDIDATE",
  HOSPITAL_RESOURCE_UNAVAILABLE: "HOSPITAL_RESOURCE_UNAVAILABLE",
  // corridor / module 9
  CORRIDOR_NOT_FOUND: "CORRIDOR_NOT_FOUND",
  CORRIDOR_ALREADY_ACTIVE: "CORRIDOR_ALREADY_ACTIVE",
  CORRIDOR_INVALID_TRANSITION: "CORRIDOR_INVALID_TRANSITION",
  // conversation / module 4
  CONVERSATION_NOT_FOUND: "CONVERSATION_NOT_FOUND",
  CONVERSATION_CLOSED: "CONVERSATION_CLOSED",
  NO_QUESTION_PENDING: "NO_QUESTION_PENDING",
  // decision engine / module 10
  EMERGENCY_NOT_FOUND: "EMERGENCY_NOT_FOUND",
  INVALID_STATE_TRANSITION: "INVALID_STATE_TRANSITION",
  ORCHESTRATION_CONFLICT: "ORCHESTRATION_CONFLICT",
  ORCHESTRATION_STEP_FAILED: "ORCHESTRATION_STEP_FAILED",
  // database / module 11
  DATABASE_FAILURE: "DATABASE_FAILURE",
  TRANSACTION_FAILED: "TRANSACTION_FAILED",
  IMMUTABLE_RECORD: "IMMUTABLE_RECORD",
  SIMULATION_DATA_MIXED: "SIMULATION_DATA_MIXED",
  // analytics / module 12
  ANALYTICS_INSUFFICIENT_DATA: "ANALYTICS_INSUFFICIENT_DATA",
  INVALID_TIME_WINDOW: "INVALID_TIME_WINDOW"
};
var AppError = class _AppError extends Error {
  code;
  statusCode;
  details;
  constructor(code, message, statusCode = 400, details) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
  toJSON() {
    return {
      error: true,
      code: this.code,
      message: this.message,
      ...this.details === void 0 ? {} : { details: this.details }
    };
  }
  static notFound(what, id) {
    return new _AppError(
      ErrorCode.NOT_FOUND,
      id ? `${what} '${id}' was not found.` : `${what} was not found.`,
      404
    );
  }
  static validation(message, details) {
    return new _AppError(ErrorCode.VALIDATION_ERROR, message, 422, details);
  }
};
function isAppError(value) {
  return value instanceof AppError;
}

// packages/core/src/geo.ts
var EARTH_RADIUS_KM = 6371.0088;
var toRad = (deg) => deg * Math.PI / 180;
function haversineKm(a, b) {
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}
function isValidCoordinate(value) {
  if (typeof value !== "object" || value === null) return false;
  const { latitude, longitude } = value;
  return typeof latitude === "number" && typeof longitude === "number" && Number.isFinite(latitude) && Number.isFinite(longitude) && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180;
}
function estimateTravelMinutes(distanceKm, averageSpeedKmh, trafficFactor = 1.25) {
  if (averageSpeedKmh <= 0) return Number.POSITIVE_INFINITY;
  return distanceKm / averageSpeedKmh * 60 * trafficFactor;
}

// packages/core/src/http.ts
var RouteTable = class {
  routes = [];
  register(route) {
    this.routes.push(route);
  }
  addAll(routes) {
    routes.forEach((route) => this.register(route));
  }
};
function paginated(items, total, limit, offset) {
  return { items, total, limit, offset };
}

// packages/core/src/ports.ts
var REALTIME_CHANNELS = [
  "system",
  "emergencies",
  "ambulances",
  "protocols",
  "hospitals",
  "routes",
  "corridors",
  "events"
];

// packages/core/src/providerPorts.ts
var VOICE_CONFIDENCE = {
  /**
   * At or above this, the transcript is treated as a reliable account of what
   * was said. `HIGH` is not used as a medical claim — it only means the audio
   * was intelligible.
   */
  HIGH: 0.75,
  /**
   * Between LOW and HIGH: usable, but the caller should be asked to confirm
   * before anything time-critical rests on it.
   */
  LOW: 0.45,
  /**
   * Below this the result is discarded. It is not written to the transcript and
   * not passed to interpretation, because a guess at this confidence level is
   * more dangerous than an admitted gap: it can be acted on while looking like
   * something the caller actually said.
   */
  DISCARD_BELOW: 0.45
};
function confidenceBand(confidence, discardBelow = VOICE_CONFIDENCE.DISCARD_BELOW) {
  if (confidence >= VOICE_CONFIDENCE.HIGH) return "HIGH";
  if (confidence >= discardBelow) return "LOW";
  return "UNUSABLE";
}
var SUPPORTED_LANGUAGES = ["en", "ml"];
function normaliseLanguageCode(language) {
  const base = language.trim().toLowerCase().split(/[-_]/)[0] ?? "";
  return SUPPORTED_LANGUAGES.includes(base) ? base : null;
}

// packages/core/src/domain/enums.ts
var EMERGENCY_STATUSES = [
  "CREATED",
  "CALL_ACTIVE",
  "CLASSIFIED",
  "PROTOCOL_ACTIVE",
  "AWAITING_AMBULANCE",
  "AMBULANCE_ASSIGNED",
  "EN_ROUTE",
  "ON_SCENE",
  "PATIENT_ONBOARD",
  "TRANSPORTING",
  "AT_HOSPITAL",
  "COMPLETED",
  "CANCELLED"
];
var EMERGENCY_SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
var INCIDENT_TYPES = [
  "CARDIAC_ARREST",
  "CHOKING",
  "UNCONSCIOUS",
  "SEVERE_BREATHING_DIFFICULTY",
  "SEVERE_BLEEDING",
  "TRAUMA",
  "OVERDOSE",
  "SEIZURE",
  "ALLERGIC_REACTION",
  "STROKE",
  "CHEST_PAIN",
  "UNSAFE_SCENE",
  "OTHER"
];
var AMBULANCE_STATUSES = [
  "AVAILABLE",
  "ASSIGNED",
  "DISPATCHED",
  "EN_ROUTE",
  "AT_SCENE",
  "PATIENT_ONBOARD",
  "TRANSPORTING",
  "AT_HOSPITAL",
  "UNAVAILABLE",
  "MAINTENANCE"
];
var PROTOCOL_SESSION_STATUSES = [
  "ACTIVE",
  "WAITING_FOR_RESPONSE",
  "ACTION_REQUIRED",
  "ESCALATED",
  "COMPLETED",
  "CANCELLED"
];
var PROTOCOL_STEP_STATUSES = [
  "PENDING",
  "ACTIVE",
  "COMPLETED",
  "SKIPPED"
];
var ASSIGNMENT_SOURCES = ["AUTOMATIC", "MANUAL_OVERRIDE"];
var ASSIGNMENT_DECISIONS = ["ASSIGNED", "ACCEPTED", "DECLINED", "DISPATCHED", "CANCELLED"];
var HOSPITAL_STATUSES = ["OPEN", "BUSY", "DIVERTING", "CLOSED"];
var HOSPITAL_CAPABILITIES = [
  "ED_TRAUMA",
  "ED_CARDIAC",
  "CARDIAC_CATHETERISATION",
  "NEUROSURGERY",
  "BURN_CENTRE",
  "POISON_CONTROL",
  "RESPIRATORY",
  "GENERAL"
];
var EQUIPMENT_CODES = [
  "DEFIBRILLATOR",
  "ADVANCED_AIRWAY",
  "OXYGEN",
  "TRAUMA_KIT",
  "HAEMORRHAGE_KIT",
  "CARDIAC_MONITOR",
  "ECG",
  "NEONATAL_KIT",
  "BURN_KIT",
  "POISON_KIT",
  "SALT_DROP_KIT",
  "SPINAL_BOARD"
];
var CREW_CAPABILITIES = [
  "PARAMEDIC",
  "ADVANCED_LIFE_SUPPORT",
  "BLS_TRANSPORT",
  "CRITICAL_CARE",
  "TRAUMA_SPECIALIST",
  "HAEMORRHAGE_TRANSPORT",
  "PEDIATRIC_CARE",
  "MENTAL_HEALTH"
];
var OUTCOME_STATUSES = [
  "STABILISED",
  "TRANSPORTED",
  "SURVIVED_TO_DISCHARGE",
  "DECEASED",
  "HANDED_OVER_OTHER_SERVICE",
  "CANCELLED_BEFORE_ARRIVAL",
  "UNKNOWN"
];
var OUTCOME_CORRECTION_REASON_CODES = [
  "DATA_ENTRY_ERROR",
  "NEW_VERIFIED_EVIDENCE",
  "CATEGORY_REASSESSMENT",
  "IDENTIFIER_CORRECTION"
];
var OUTCOME_REVIEW_DECISIONS = ["APPROVED", "REJECTED", "NEEDS_EVIDENCE"];
var OUTCOME_ELIGIBILITY_DECISIONS = ["ELIGIBLE", "INELIGIBLE"];
var OUTCOME_REVIEW_REASON_CODES = [
  "VERIFIED_EVIDENCE",
  "INSUFFICIENT_EVIDENCE",
  "UNSUPPORTED_CATEGORY",
  "SIMULATION_DATA",
  "TEST_DATA",
  "UNVERIFIED_PROVENANCE",
  "OUTCOME_UNCERTAIN",
  "REJECTED_INVALID"
];
var CALL_SESSION_STATUSES = ["ACTIVE", "ENDED"];
var HOSPITAL_RESOURCE_TYPES = [
  "ICU_BED",
  "EMERGENCY_BED",
  "OPERATION_THEATRE",
  "SPECIALIST",
  "EQUIPMENT"
];
var TRANSCRIPT_SPEAKERS = ["CALLER", "SYSTEM", "BYSTANDER", "OPERATOR"];
var ACTOR_TYPES = ["SYSTEM", "OPERATOR", "CALLER", "AMBULANCE", "MODULE", "SIMULATION"];
var USER_ROLES = [
  "OPERATOR",
  "DISPATCHER",
  "CLINICAL_SUPERVISOR",
  "OUTCOME_SUBMITTER",
  "OUTCOME_REVIEWER",
  "DRIVER",
  "AMBULANCE_DRIVER",
  "ADMIN"
];

// packages/core/src/domain/events.ts
var SYSTEM_EVENT_TYPES = [
  // call + classification
  "EMERGENCY_CREATED",
  "CALL_STARTED",
  "TRANSCRIPT_UPDATED",
  "EMERGENCY_CLASSIFIED",
  "EMERGENCY_STATUS_CHANGED",
  // module 5 - protocol engine
  "PROTOCOL_STARTED",
  "PROTOCOL_STEP_PRESENTED",
  "CALLER_RESPONSE_RECEIVED",
  "PROTOCOL_STEP_COMPLETED",
  "PROTOCOL_CLARIFICATION_REQUESTED",
  "PROTOCOL_ESCALATED",
  "PROTOCOL_COMPLETED",
  "PROTOCOL_CANCELLED",
  "LLM_CALL_FAILED",
  // module 6 - ambulance
  "AMBULANCE_CREATED",
  "AMBULANCE_UPDATED",
  "AMBULANCE_ASSIGNMENT_REQUESTED",
  "AMBULANCE_ASSIGNED",
  "AMBULANCE_ASSIGNMENT_CANCELLED",
  "AMBULANCE_ASSIGNMENT_ACCEPTED",
  "AMBULANCE_ASSIGNMENT_DECLINED",
  "AMBULANCE_DISPATCHED",
  "AMBULANCE_LOCATION_UPDATED",
  "AMBULANCE_STATUS_CHANGED",
  "AMBULANCE_ARRIVED_SCENE",
  "PATIENT_ONBOARD",
  "HOSPITAL_SELECTED",
  "AMBULANCE_ARRIVED_HOSPITAL",
  "EMERGENCY_COMPLETED",
  // decision / outcome
  "DECISION_CREATED",
  "OUTCOME_RECORDED",
  "OUTCOME_REVIEW_RECORDED",
  "CORRIDOR_ACTIVATED",
  "ROUTE_UPDATED",
  // analytics
  "ANALYTICS_SNAPSHOT_CREATED",
  "LEARNING_MODEL_UPDATED",
  // ---------------------------------------------------------------------------
  // Additions for modules 1-4 and 7-9.
  //
  // Per docs/MODULE_DEPENDENCY_MAP.md section 11 the vocabulary is append-only:
  // these types are new, and no existing payload shape was altered, so every
  // producer and consumer written before them keeps working unchanged.
  // ---------------------------------------------------------------------------
  // module 1 - emergency call interface
  "CALL_CONNECTED",
  "CALL_DISCONNECTED",
  "CALL_FAILED",
  // module 2 - speech processing
  "TRANSCRIPT_PARTIAL",
  "SPEECH_SYNTHESIZED",
  "SPEECH_TRANSCRIPTION_FAILED",
  "SPEECH_SYNTHESIS_FAILED",
  // module 3 - emergency NLP
  "NLP_EXTRACTION_COMPLETED",
  "NLP_EXTRACTION_REJECTED",
  "FACT_EXTRACTED",
  // module 4 - conversation & question engine
  "QUESTION_REQUIRED",
  "ANSWER_RECEIVED",
  "CONVERSATION_TIMED_OUT",
  "CONVERSATION_ESCALATED",
  // module 7 - hospital intelligence
  "HOSPITAL_RESOURCE_UPDATED",
  "HOSPITAL_REJECTED",
  // module 8 - route optimization
  "ROUTE_GENERATED",
  "ROUTE_RECALCULATED",
  "ROUTE_FAILED",
  // module 9 - emergency corridor & alerts
  "CORRIDOR_RENEGOTIATED",
  "CORRIDOR_RELEASED",
  "NOTIFICATION_SENT",
  "SIMULATED_POLICE_NOTIFICATION_CREATED",
  "SIMULATED_POLICE_NOTIFICATION_ACKNOWLEDGED",
  "SIMULATED_POLICE_NOTIFICATION_SUPERSEDED",
  // module 11 - outcome access grant lifecycle (audit)
  "OUTCOME_GRANTED",
  "OUTCOME_GRANT_REVOKED"
];
function isSystemEventType(value) {
  return typeof value === "string" && SYSTEM_EVENT_TYPES.includes(value);
}
function defineEvent(type, body) {
  return { type, ...body };
}

// packages/core/src/domain/provenance.ts
var DATA_PROVENANCE = {
  /** Recorded from a real system event. Verifiable by replaying the event log. */
  REAL_OBSERVED: "REAL_OBSERVED",
  /** Produced by the labelled ambulance simulator. Never mixed with real data. */
  SIMULATION: "SIMULATION",
  /** Computed from observed data by a transparent formula. */
  STATISTICAL_ESTIMATE: "STATISTICAL_ESTIMATE",
  /** Output of the outcome-learning layer. Always carries its sample count. */
  MODEL_OUTPUT: "MODEL_OUTPUT"
};

// packages/core/src/domain/schemas.ts
import { z as z2 } from "zod";
var enumFrom = (values) => z2.enum(values);
var emergencyStatusSchema = enumFrom(EMERGENCY_STATUSES);
var emergencySeveritySchema = enumFrom(EMERGENCY_SEVERITIES);
var incidentTypeSchema = enumFrom(INCIDENT_TYPES);
var ambulanceStatusSchema = enumFrom(AMBULANCE_STATUSES);
var protocolSessionStatusSchema = enumFrom(PROTOCOL_SESSION_STATUSES);
var protocolStepStatusSchema = enumFrom(PROTOCOL_STEP_STATUSES);
var assignmentSourceSchema = enumFrom(ASSIGNMENT_SOURCES);
var assignmentDecisionSchema = enumFrom(ASSIGNMENT_DECISIONS);
var hospitalStatusSchema = enumFrom(HOSPITAL_STATUSES);
var hospitalCapabilitySchema = enumFrom(HOSPITAL_CAPABILITIES);
var equipmentCodeSchema = enumFrom(EQUIPMENT_CODES);
var crewCapabilitySchema = enumFrom(CREW_CAPABILITIES);
var outcomeStatusSchema = enumFrom(OUTCOME_STATUSES);
var callSessionStatusSchema = enumFrom(CALL_SESSION_STATUSES);
var transcriptSpeakerSchema = enumFrom(TRANSCRIPT_SPEAKERS);
var actorTypeSchema = enumFrom(ACTOR_TYPES);
var userRoleSchema = enumFrom(USER_ROLES);
var coordinateSchema = z2.object({
  latitude: z2.number().min(-90).max(90),
  longitude: z2.number().min(-180).max(180)
});
var isoDateTime = z2.string().datetime({ offset: true }).or(z2.string().datetime()).or(z2.string().refine((v) => !Number.isNaN(Date.parse(v)), "invalid date"));
var jsonColumn = z2.union([z2.array(z2.unknown()), z2.record(z2.unknown())]).nullable().optional();

// packages/core/src/runtime.ts
var counter = 0;
function createId(prefix) {
  counter = (counter + 1) % 65535;
  const rand = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID().replace(/-/g, "").slice(0, 10) : Math.random().toString(36).slice(2, 12);
  return `${prefix}-${rand.toUpperCase()}${counter.toString(16).toUpperCase().padStart(4, "0")}`;
}
function createConsoleLogger(level = "info", scope = "app") {
  const order = { debug: 10, info: 20, warn: 30, error: 40 };
  const threshold = order[level];
  const emit = (lvl, obj, msg) => {
    if (order[lvl] < threshold) return;
    const line = { scope, level: lvl, ...msg ? { msg } : {}, ...obj };
    console[lvl === "debug" ? "log" : lvl](JSON.stringify(line));
  };
  return {
    debug: (o, m) => emit("debug", o, m),
    info: (o, m) => emit("info", o, m),
    warn: (o, m) => emit("warn", o, m),
    error: (o, m) => emit("error", o, m)
  };
}
var noopLogger = {
  debug: () => {
  },
  info: () => {
  },
  warn: () => {
  },
  error: () => {
  }
};

// modules/module_11_database_event_system/src/events/bus.ts
var DomainEventBus = class {
  subscriptions = /* @__PURE__ */ new Set();
  realtime;
  logger;
  constructor(options = {}) {
    this.realtime = options.realtime;
    this.logger = options.logger ?? createConsoleLogger("info", "module_11.bus");
  }
  subscribe(types, handler) {
    const subscription = { types, handler };
    this.subscriptions.add(subscription);
    return () => {
      this.subscriptions.delete(subscription);
    };
  }
  /** Subscribes to every event type. */
  subscribeAll(handler) {
    const subscription = { types: null, handler };
    this.subscriptions.add(subscription);
    return () => {
      this.subscriptions.delete(subscription);
    };
  }
  publish(event) {
    for (const subscription of this.subscriptions) {
      if (subscription.types && !subscription.types.includes(event.type)) continue;
      try {
        const result = subscription.handler(event);
        if (result instanceof Promise) {
          result.catch(
            (error) => this.logger.error(
              { error: error instanceof Error ? error.message : String(error), eventId: event.id },
              "event subscriber failed"
            )
          );
        }
      } catch (error) {
        this.logger.error(
          { error: error instanceof Error ? error.message : String(error), eventId: event.id },
          "event subscriber failed"
        );
      }
    }
    this.realtime?.publish("events", {
      kind: "event",
      eventType: event.type,
      channel: "events",
      payload: event,
      sequence: event.sequence,
      timestamp: event.timestamp,
      isSimulation: Boolean(event.payload?.isSimulation)
    });
  }
};

// modules/module_11_database_event_system/src/api/routes.ts
import { z as z3 } from "zod";

// modules/module_11_database_event_system/src/db/client.ts
import { PrismaClient, Prisma } from "@prisma/client";

// modules/module_11_database_event_system/src/db/transactionScope.ts
import { AsyncLocalStorage } from "node:async_hooks";
var storage = new AsyncLocalStorage();
var commitSink = null;
function registerCommitSink(sink) {
  commitSink = sink;
}
function currentScope() {
  return storage.getStore();
}
function bufferRecord(record) {
  const scope = storage.getStore();
  if (scope) scope.records.push(record);
}
async function runScoped(fn) {
  return storage.run({ records: [] }, async () => {
    let result;
    try {
      result = await fn();
    } catch (error) {
      const scope2 = storage.getStore();
      if (scope2) scope2.records.length = 0;
      throw error;
    }
    const scope = storage.getStore();
    const records = scope ? scope.records.splice(0) : [];
    if (records.length > 0 && commitSink) {
      await commitSink(records);
    }
    return result;
  });
}

// modules/module_11_database_event_system/src/db/client.ts
var instance = null;
function createPrismaClient(options = {}) {
  return new PrismaClient({
    log: options.log ? ["warn", "error"] : ["error"]
  });
}
function getPrismaClient() {
  if (!instance) instance = createPrismaClient();
  return instance;
}
var logger = createConsoleLogger("info", "module_11.db");
async function withTransaction(db, fn) {
  try {
    return await runScoped(() => db.$transaction(fn, { timeout: 15e3, maxWait: 5e3 }));
  } catch (error) {
    throw mapDatabaseError(error, "Transaction failed");
  }
}
function mapDatabaseError(error, fallbackMessage) {
  if (error instanceof AppError) return error;
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    switch (error.code) {
      case "P2002":
        return new AppError(ErrorCode.CONFLICT, "A record with these unique values already exists.", 409, {
          prismaCode: error.code,
          target: error.meta?.target
        });
      case "P2003":
        return new AppError(
          ErrorCode.VALIDATION_ERROR,
          "Referenced record does not exist (foreign key constraint).",
          422,
          { prismaCode: error.code, field: error.meta?.field_name }
        );
      case "P2025":
        return new AppError(ErrorCode.NOT_FOUND, "Record not found.", 404, { prismaCode: error.code });
      case "P2010":
        return mapRawError(String(error.message), error.meta);
      default:
        return new AppError(ErrorCode.DATABASE_FAILURE, fallbackMessage, 500, { prismaCode: error.code });
    }
  }
  return new AppError(ErrorCode.DATABASE_FAILURE, fallbackMessage, 500, {
    cause: error instanceof Error ? error.message : String(error)
  });
}
function mapRawError(message, meta) {
  if (message.includes("IMMUTABLE_RECORD")) {
    return new AppError(
      ErrorCode.IMMUTABLE_RECORD,
      "The system event log is append-only and cannot be modified.",
      409
    );
  }
  if (message.includes("VALIDATION_ERROR")) {
    return new AppError(ErrorCode.VALIDATION_ERROR, "A domain constraint rejected the write.", 422, meta);
  }
  return new AppError(ErrorCode.DATABASE_FAILURE, "Raw database statement failed.", 500, { message, meta });
}
async function guardDatabase(operation, message) {
  try {
    return await operation();
  } catch (error) {
    const appError = mapDatabaseError(error, message);
    if (appError.statusCode >= 500) logger.error({ code: appError.code, message }, "database failure");
    throw appError;
  }
}

// modules/module_11_database_event_system/src/models/mappers.ts
var str = (v) => v === null || v === void 0 ? null : String(v);
var iso = (v) => v instanceof Date ? v.toISOString() : String(v);
var isoOrNull = (v) => v == null ? null : iso(v);
var numOrNull = (v) => v == null ? null : Number(v);
function parseJsonColumn(value, fallback2) {
  if (value == null) return fallback2;
  if (typeof value !== "string") return value;
  try {
    const parsed = JSON.parse(value);
    return parsed ?? fallback2;
  } catch {
    return fallback2;
  }
}
function parseStringArray(value) {
  const parsed = parseJsonColumn(value, []);
  return Array.isArray(parsed) ? parsed.map(String) : [];
}
function parseRecord(value) {
  const parsed = parseJsonColumn(value, {});
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}
function parseEnumList(value, schema) {
  return parseStringArray(value).filter((item) => {
    const result = schema.safeParse(item);
    return result.success;
  });
}
function mapEmergency(row) {
  return {
    id: String(row.id),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    status: emergencyStatusSchema.parse(row.status),
    incidentType: incidentTypeSchema.parse(row.incidentType),
    severity: emergencySeveritySchema.parse(row.severity),
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    description: str(row.description),
    callerId: str(row.callerId),
    assignedAmbulanceId: str(row.assignedAmbulanceId),
    selectedHospitalId: str(row.selectedHospitalId),
    isSimulation: Boolean(row.isSimulation)
  };
}
function mapAmbulance(row, crewRows = []) {
  const equipment = parseEnumList(row.equipmentJson, equipmentCodeSchema);
  const crew = crewRows.map((member) => ({
    id: String(member.id),
    ambulanceId: String(member.ambulanceId),
    name: String(member.name),
    role: String(member.role),
    capabilities: parseEnumList(member.capabilitiesJson, crewCapabilitySchema),
    isOnDuty: Boolean(member.isOnDuty)
  }));
  return {
    id: String(row.id),
    vehicleNumber: String(row.vehicleNumber),
    status: ambulanceStatusSchema.parse(row.status),
    latitude: numOrNull(row.latitude),
    longitude: numOrNull(row.longitude),
    lastLocationUpdate: isoOrNull(row.lastLocationUpdate),
    equipment,
    crew,
    currentEmergencyId: str(row.currentEmergencyId),
    assignedAt: isoOrNull(row.assignedAt),
    availableAt: isoOrNull(row.availableAt),
    isSimulation: Boolean(row.isSimulation),
    stationName: str(row.stationName),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt)
  };
}
function mapAmbulanceLocation(row) {
  return {
    id: String(row.id),
    ambulanceId: String(row.ambulanceId),
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    speedKmh: numOrNull(row.speedKmh),
    headingDeg: numOrNull(row.headingDeg),
    accuracyM: numOrNull(row.accuracyM),
    recordedAt: iso(row.recordedAt),
    source: String(row.source ?? "GPS"),
    isSimulation: Boolean(row.isSimulation)
  };
}
function mapAssignment(row) {
  return {
    id: String(row.id),
    emergencyId: String(row.emergencyId),
    ambulanceId: String(row.ambulanceId),
    status: String(row.status),
    source: assignmentSourceSchema.parse(row.source),
    distanceKm: Number(row.distanceKm),
    estimatedResponseTimeMin: Number(row.estimatedResponseTimeMin),
    score: Number(row.score),
    matchingFactors: parseStringArray(row.matchingFactorsJson),
    rejectedReasons: parseRecord(row.rejectedReasonsJson),
    overrideReason: str(row.overrideReason),
    decidedByUserId: str(row.decidedByUserId),
    decidedAt: iso(row.decidedAt),
    createdAt: iso(row.createdAt)
  };
}
function mapHospital(row) {
  return {
    id: String(row.id),
    name: String(row.name),
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    status: hospitalStatusSchema.parse(row.status),
    capabilities: parseEnumList(row.capabilitiesJson, hospitalCapabilitySchema),
    traumaLevel: Number(row.traumaLevel),
    acceptingEmergencies: Boolean(row.acceptingEmergencies),
    contactPhone: str(row.contactPhone),
    address: str(row.address),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt)
  };
}
function mapHospitalResource(row) {
  return {
    id: String(row.id),
    hospitalId: String(row.hospitalId),
    resourceType: String(row.resourceType),
    code: String(row.code ?? ""),
    total: Number(row.total),
    available: Number(row.available),
    updatedAt: iso(row.updatedAt)
  };
}
function mapProtocolSession(row) {
  return {
    id: String(row.id),
    emergencyId: String(row.emergencyId),
    protocolId: String(row.protocolId),
    protocolVersion: String(row.protocolVersion),
    protocolSource: String(row.protocolSource),
    currentStep: String(row.currentStep),
    status: protocolSessionStatusSchema.parse(row.status),
    startedAt: iso(row.startedAt),
    updatedAt: iso(row.updatedAt),
    completedAt: isoOrNull(row.completedAt),
    escalationRequired: Boolean(row.escalationRequired),
    escalationReason: str(row.escalationReason),
    clarificationCount: Number(row.clarificationCount ?? 0),
    collectedFacts: parseRecord(row.collectedFactsJson),
    initiatedBy: String(row.initiatedBy ?? "SYSTEM")
  };
}
function mapProtocolStep(row) {
  return {
    id: String(row.id),
    protocolSessionId: String(row.protocolSessionId),
    stepId: String(row.stepId),
    orderIndex: Number(row.orderIndex),
    status: protocolStepStatusSchema.parse(row.status),
    presentedAt: isoOrNull(row.presentedAt),
    completedAt: isoOrNull(row.completedAt),
    result: Object.keys(parseRecord(row.resultJson)).length > 0 ? parseRecord(row.resultJson) : null
  };
}
function mapDecision(row) {
  return {
    id: String(row.id),
    emergencyId: String(row.emergencyId),
    decisionType: String(row.decisionType),
    ambulanceId: str(row.ambulanceId),
    hospitalId: str(row.hospitalId),
    optionsConsidered: parseJsonColumn(row.optionsConsideredJson, []),
    chosen: String(row.chosen),
    reasoning: String(row.reasoning),
    confidence: Number(row.confidence),
    actorType: String(row.actorType),
    actorId: str(row.actorId),
    createdAt: iso(row.createdAt)
  };
}
function mapOutcome(row) {
  return {
    id: String(row.id),
    emergencyId: String(row.emergencyId),
    status: outcomeStatusSchema.parse(row.status),
    provenance: String(row.provenance),
    survivalToDischarge: row.survivalToDischarge == null ? null : Boolean(row.survivalToDischarge),
    notes: str(row.notes),
    recordedAt: iso(row.recordedAt),
    recordedByUserId: str(row.recordedByUserId)
  };
}
function mapSystemEvent(row) {
  return {
    id: String(row.id),
    sequence: Number(row.seq),
    type: String(row.type),
    emergencyId: str(row.emergencyId),
    entityType: str(row.entityType),
    entityId: str(row.entityId),
    timestamp: iso(row.recordedAt),
    actorType: str(row.actorType),
    actorId: str(row.actorId),
    payload: parseJsonColumn(row.payloadJson, {}),
    metadata: Object.keys(parseRecord(row.metadataJson)).length > 0 ? parseRecord(row.metadataJson) : null
  };
}

// modules/module_11_database_event_system/src/repositories/protocolRepository.ts
var ProtocolRepository = class {
  constructor(db, events, logger2 = noopLogger) {
    this.db = db;
    this.events = events;
    this.logger = logger2;
  }
  logger;
  async createSession(input) {
    const id = createId("PSE");
    const row = await guardDatabase(
      async () => withTransaction(this.db, async (tx) => {
        const created = await tx.protocolSession.create({
          data: {
            id,
            emergencyId: input.emergencyId,
            protocolId: input.protocolId,
            protocolVersion: input.protocolVersion,
            protocolSource: input.protocolSource,
            currentStep: input.currentStep,
            status: "ACTIVE",
            collectedFactsJson: "{}",
            initiatedBy: input.startedBy ?? "SYSTEM",
            initiatedByUserId: input.initiatedByUserId ?? null,
            llmProvider: input.llmProvider ?? "ollama",
            llmModel: input.llmModel ?? "qwen3:8b",
            degraded: input.degraded ?? false
          }
        });
        await this.events.recordInTransaction(
          tx,
          defineEvent("PROTOCOL_STARTED", {
            emergencyId: input.emergencyId,
            entityType: "protocol_session",
            entityId: id,
            payload: {
              protocolSessionId: id,
              protocolId: input.protocolId,
              protocolVersion: input.protocolVersion,
              source: input.protocolSource
            }
          })
        );
        return created;
      }),
      "Failed to start protocol session"
    );
    return mapProtocolSession(row);
  }
  async findSessionById(id) {
    return guardDatabase(async () => {
      const row = await this.db.protocolSession.findUnique({ where: { id } });
      return row ? mapProtocolSession(row) : null;
    }, "Failed to read protocol session");
  }
  /** `ProtocolSessionPort` name for `findSessionById`. */
  async getSession(id) {
    return this.findSessionById(id);
  }
  /** `ProtocolSessionPort` name for `sessionForEmergency`. */
  async listSessionsForEmergency(emergencyId) {
    return this.sessionForEmergency(emergencyId);
  }
  async requireSession(id) {
    const session = await this.findSessionById(id);
    if (!session) throw new AppError(ErrorCode.NOT_FOUND, `Protocol session '${id}' was not found.`, 404);
    return session;
  }
  async sessionForEmergency(emergencyId) {
    return guardDatabase(async () => {
      const rows = await this.db.protocolSession.findMany({
        where: { emergencyId },
        orderBy: { startedAt: "desc" }
      });
      return rows.map((row) => mapProtocolSession(row));
    }, "Failed to list protocol sessions");
  }
  /**
   * Applies a state transition and the event describing it atomically.
   * `steps` carries the step bookkeeping produced by the protocol engine.
   */
  async applyTransition(input) {
    const result = await guardDatabase(
      async () => withTransaction(this.db, async (tx) => {
        const session = await tx.protocolSession.update({
          where: { id: input.sessionId },
          data: {
            currentStep: input.currentStep,
            status: input.status,
            completedAt: input.completedAt ?? void 0,
            escalationRequired: input.escalationRequired,
            escalationReason: input.escalationReason,
            clarificationCount: input.clarificationCount,
            collectedFactsJson: input.collectedFacts ? JSON.stringify(input.collectedFacts) : void 0,
            degraded: input.degraded
          }
        });
        for (const step of input.steps ?? []) {
          await tx.protocolStep.upsert({
            where: { protocolSessionId_stepId: { protocolSessionId: input.sessionId, stepId: step.stepId } },
            create: {
              id: createId("PST"),
              protocolSessionId: input.sessionId,
              stepId: step.stepId,
              orderIndex: step.orderIndex,
              status: step.status,
              presentedAt: step.presentedAt ?? null,
              completedAt: step.completedAt ?? null,
              resultJson: step.result ? JSON.stringify(step.result) : null
            },
            update: {
              status: step.status,
              orderIndex: step.orderIndex,
              presentedAt: step.presentedAt ?? void 0,
              completedAt: step.completedAt ?? void 0,
              resultJson: step.result ? JSON.stringify(step.result) : void 0
            }
          });
        }
        for (const event of input.events) {
          await this.events.recordInTransaction(
            tx,
            defineEvent(event.type, {
              emergencyId: input.emergencyId,
              entityType: "protocol_session",
              entityId: input.sessionId,
              payload: event.payload
            })
          );
        }
        return session;
      }),
      "Failed to apply protocol transition"
    );
    const steps = await this.stepsForSession(input.sessionId);
    return { session: mapProtocolSession(result), steps };
  }
  async stepsForSession(protocolSessionId) {
    return guardDatabase(async () => {
      const rows = await this.db.protocolStep.findMany({
        where: { protocolSessionId },
        orderBy: { orderIndex: "asc" }
      });
      return rows.map((row) => mapProtocolStep(row));
    }, "Failed to read protocol steps");
  }
  async protocolStats(includeSimulation) {
    return guardDatabase(async () => {
      const emergencyFilter = includeSimulation ? {} : { emergency: { isSimulation: false } };
      const rows = await this.db.protocolSession.findMany({
        where: emergencyFilter,
        select: { status: true, escalationRequired: true }
      });
      return {
        total: rows.length,
        completed: rows.filter((r) => r.status === "COMPLETED").length,
        escalated: rows.filter((r) => r.status === "ESCALATED" || r.escalationRequired).length,
        cancelled: rows.filter((r) => r.status === "CANCELLED").length
      };
    }, "Failed to compute protocol statistics");
  }
};
var DecisionRepository = class {
  constructor(db) {
    this.db = db;
  }
  async create(input) {
    const id = createId("DEC");
    const row = await guardDatabase(
      async () => this.db.decision.create({
        data: {
          id,
          emergencyId: input.emergencyId,
          decisionType: input.decisionType,
          ambulanceId: input.ambulanceId ?? null,
          hospitalId: input.hospitalId ?? null,
          optionsConsideredJson: JSON.stringify(input.optionsConsidered ?? []),
          chosen: input.chosen,
          reasoning: input.reasoning,
          confidence: input.confidence,
          actorType: input.actorType ?? "SYSTEM",
          actorId: input.actorId ?? null
        }
      }),
      "Failed to persist decision"
    );
    return mapDecision(row);
  }
  async forEmergency(emergencyId) {
    return guardDatabase(async () => {
      const rows = await this.db.decision.findMany({
        where: { emergencyId },
        orderBy: { createdAt: "asc" }
      });
      return rows.map((row) => mapDecision(row));
    }, "Failed to list decisions");
  }
};
var OUTCOME_ACCESS_CAPABILITIES = ["SUBMIT", "REVIEW"];
var OUTCOME_GRANT_EVENT_TYPES = ["OUTCOME_GRANTED", "OUTCOME_GRANT_REVOKED"];
var OutcomeRepository = class {
  constructor(db, events) {
    this.db = db;
    this.events = events;
  }
  async recordAssertion(input) {
    const normalized = normalizeOutcomeAssertion(input);
    const events = this.requireEvents();
    return guardDatabase(async () => withTransaction(this.db, async (tx) => {
      const existing = await tx.outcomeAssertion.findUnique({ where: { idempotencyKey: normalized.idempotencyKey } });
      if (existing) {
        if (!sameAssertion(existing, normalized)) throw AppErrorConflict("Outcome idempotency key was already used for different content.");
        return mapOutcomeAssertion(existing);
      }
      const emergency = await tx.emergency.findUnique({ where: { id: normalized.emergencyId }, select: { isSimulation: true } });
      if (!emergency) throw AppError.notFound("Emergency", normalized.emergencyId);
      enforceOutcomeClassification(normalized, emergency.isSimulation);
      if (normalized.supersedesOutcomeId) {
        const predecessor = await tx.outcomeAssertion.findFirst({
          where: { id: normalized.supersedesOutcomeId, emergencyId: normalized.emergencyId }
        });
        if (!predecessor) throw AppError.validation("Correction predecessor must belong to the same emergency.");
        const successor = await tx.outcomeAssertion.findUnique({ where: { supersedesOutcomeId: normalized.supersedesOutcomeId } });
        if (successor) throw AppErrorConflict("Outcome assertion already has a correction successor.");
      }
      const row = await tx.outcomeAssertion.create({ data: {
        id: createId("OUTA"),
        emergencyId: normalized.emergencyId,
        category: normalized.category,
        categoryVersion: normalized.categoryVersion,
        provenance: normalized.provenance,
        dataClassification: normalized.dataClassification,
        survivalToDischarge: normalized.survivalToDischarge,
        observedAt: normalized.observedAt,
        submittedByUserId: normalized.submittedByUserId,
        evidenceRefsJson: normalized.evidenceRefs ? JSON.stringify(normalized.evidenceRefs) : null,
        correctionReasonCode: normalized.correctionReasonCode,
        idempotencyKey: normalized.idempotencyKey,
        supersedesOutcomeId: normalized.supersedesOutcomeId
      } });
      await events.recordInTransaction(tx, defineEvent("OUTCOME_RECORDED", {
        eventId: `EVT-OUTCOME-${row.id}`,
        emergencyId: row.emergencyId,
        entityType: "outcome_assertion",
        entityId: row.id,
        actorType: row.submittedByUserId ? "OPERATOR" : "SYSTEM",
        actorId: row.submittedByUserId,
        payload: {
          contractVersion: 1,
          emergencyId: row.emergencyId,
          outcomeRecordId: row.id,
          category: row.category,
          categoryVersion: row.categoryVersion,
          provenance: row.provenance,
          dataClassification: row.dataClassification,
          reviewStatus: "PENDING",
          observedAt: row.observedAt?.toISOString() ?? null,
          recordedAt: row.recordedAt.toISOString(),
          supersedesOutcomeId: row.supersedesOutcomeId,
          correctionReasonCode: row.correctionReasonCode
        }
      }));
      return mapOutcomeAssertion(row);
    }), "Failed to record outcome assertion");
  }
  async recordReview(input) {
    const normalized = normalizeOutcomeReview(input);
    const events = this.requireEvents();
    return guardDatabase(async () => withTransaction(this.db, async (tx) => {
      const existing = await tx.outcomeReview.findUnique({ where: { idempotencyKey: normalized.idempotencyKey } });
      if (existing) {
        if (!sameReview(existing, normalized)) throw AppErrorConflict("Review idempotency key was already used for different content.");
        return mapOutcomeReview(existing);
      }
      const outcome = await tx.outcomeAssertion.findUnique({ where: { id: normalized.outcomeRecordId } });
      if (!outcome) throw AppError.notFound("Outcome assertion", normalized.outcomeRecordId);
      if (outcome.submittedByUserId === normalized.reviewerUserId) {
        throw new AppError(ErrorCode.FORBIDDEN, "An outcome submitter may not review their own assertion.", 403);
      }
      if (normalized.eligibleForLearning && (normalized.decision !== "APPROVED" || outcome.dataClassification !== "OPERATIONAL" || outcome.provenance !== "REAL_OBSERVED" || !["SURVIVED_TO_DISCHARGE", "DECEASED"].includes(outcome.category))) throw AppError.validation("Only approved operational observations with supported outcome labels may be learning eligible.");
      if (normalized.supersedesReviewId) {
        const predecessor = await tx.outcomeReview.findFirst({
          where: { id: normalized.supersedesReviewId, outcomeRecordId: normalized.outcomeRecordId }
        });
        if (!predecessor) throw AppError.validation("Review correction predecessor must concern the same outcome assertion.");
        const successor = await tx.outcomeReview.findUnique({ where: { supersedesReviewId: normalized.supersedesReviewId } });
        if (successor) throw AppErrorConflict("Review already has a correction successor.");
      } else {
        const root = await tx.outcomeReview.findFirst({ where: { outcomeRecordId: normalized.outcomeRecordId, supersedesReviewId: null } });
        if (root) throw AppErrorConflict("A review already exists; a subsequent decision must supersede it.");
      }
      const row = await tx.outcomeReview.create({ data: {
        id: createId("OUTR"),
        outcomeRecordId: normalized.outcomeRecordId,
        reviewerUserId: normalized.reviewerUserId,
        decision: normalized.decision,
        reviewReasonCode: normalized.reviewReasonCode,
        eligibleForLearning: normalized.eligibleForLearning,
        eligibilityReasonCode: normalized.eligibilityReasonCode,
        evidenceAssessmentJson: normalized.evidenceAssessment ? JSON.stringify(normalized.evidenceAssessment) : null,
        idempotencyKey: normalized.idempotencyKey,
        supersedesReviewId: normalized.supersedesReviewId
      } });
      await events.recordInTransaction(tx, defineEvent("OUTCOME_REVIEW_RECORDED", {
        eventId: `EVT-OUTCOME-REVIEW-${row.id}`,
        emergencyId: outcome.emergencyId,
        entityType: "outcome_review",
        entityId: row.id,
        actorType: "OPERATOR",
        actorId: row.reviewerUserId,
        payload: {
          contractVersion: 1,
          emergencyId: outcome.emergencyId,
          outcomeRecordId: outcome.id,
          reviewRecordId: row.id,
          decision: row.decision,
          reviewReasonCode: row.reviewReasonCode,
          eligibleForLearning: row.eligibleForLearning,
          eligibilityReasonCode: row.eligibilityReasonCode,
          reviewedAt: row.reviewedAt.toISOString()
        }
      }));
      return mapOutcomeReview(row);
    }), "Failed to record outcome review");
  }
  async assertionForEmergency(emergencyId, outcomeRecordId) {
    return guardDatabase(async () => {
      const row = await this.db.outcomeAssertion.findFirst({ where: { id: outcomeRecordId, emergencyId } });
      return row ? mapOutcomeAssertion(row) : null;
    }, "Failed to read outcome assertion");
  }
  async reviewStatusForAssertion(emergencyId, outcomeRecordId) {
    return guardDatabase(async () => {
      const row = await this.db.outcomeAssertion.findFirst({
        where: { id: outcomeRecordId, emergencyId },
        include: { reviews: { include: { successor: { select: { id: true } } } } }
      });
      if (!row) return null;
      const current = row.reviews.find((review) => review.successor === null);
      return current ? current.decision : "PENDING";
    }, "Failed to read outcome review status");
  }
  async historyForEmergency(emergencyId, limit = 100, offset = 0) {
    return guardDatabase(async () => {
      const where = { emergencyId };
      const [rows, total] = await Promise.all([
        this.db.outcomeAssertion.findMany({
          where,
          orderBy: [{ recordedAt: "asc" }, { id: "asc" }],
          take: limit,
          skip: offset,
          include: {
            predecessor: { select: { id: true } },
            successor: { select: { id: true } },
            reviews: { orderBy: [{ reviewedAt: "asc" }, { id: "asc" }], include: { successor: { select: { id: true } } } }
          }
        }),
        this.db.outcomeAssertion.count({ where })
      ]);
      return { total, items: rows.map((row) => {
        const reviews = row.reviews.map((review) => ({ ...mapOutcomeReview(review), isCurrent: review.successor === null }));
        const currentReview = reviews.find((review) => review.isCurrent);
        return {
          ...mapOutcomeAssertion(row),
          isCurrent: row.successor === null,
          reviewStatus: currentReview?.decision ?? "PENDING",
          predecessorId: row.predecessor?.id ?? null,
          successorId: row.successor?.id ?? null,
          reviews
        };
      }) };
    }, "Failed to list outcome history");
  }
  async recordGrant(input) {
    const events = this.requireEvents();
    return guardDatabase(async () => withTransaction(this.db, async (tx) => {
      const existing = await tx.emergencyOutcomeGrant.findUnique({
        where: {
          emergencyId_granteeUserId_capability: {
            emergencyId: input.emergencyId,
            granteeUserId: input.granteeUserId,
            capability: input.capability
          }
        }
      });
      if (existing && !existing.revokedAt) return mapOutcomeGrant(existing);
      let action;
      let reactivatedAt = null;
      let grant;
      if (existing) {
        grant = await tx.emergencyOutcomeGrant.update({
          where: { id: existing.id },
          data: { revokedAt: null, revokedByUserId: null, revokeReason: null, grantedByUserId: input.grantedByUserId }
        });
        action = "REACTIVATED";
        reactivatedAt = (/* @__PURE__ */ new Date()).toISOString();
      } else {
        grant = await tx.emergencyOutcomeGrant.create({
          data: {
            id: createId("OGT"),
            emergencyId: input.emergencyId,
            granteeUserId: input.granteeUserId,
            capability: input.capability,
            grantedByUserId: input.grantedByUserId
          }
        });
        action = "GRANTED";
      }
      await events.recordInTransaction(tx, defineEvent("OUTCOME_GRANTED", {
        emergencyId: grant.emergencyId,
        entityType: "emergency_outcome_grant",
        entityId: grant.id,
        actorType: "OPERATOR",
        actorId: input.grantedByUserId,
        payload: {
          contractVersion: 1,
          emergencyId: grant.emergencyId,
          grantId: grant.id,
          granteeUserId: grant.granteeUserId,
          capability: grant.capability,
          action,
          active: true,
          reactivatedAt
        }
      }));
      return mapOutcomeGrant(grant);
    }), "Failed to record outcome access grant");
  }
  async revokeGrant(grantId, emergencyId, revokedByUserId, revokeReason) {
    const events = this.requireEvents();
    return guardDatabase(async () => withTransaction(this.db, async (tx) => {
      const existing = await tx.emergencyOutcomeGrant.findFirst({ where: { id: grantId, emergencyId } });
      if (!existing) return null;
      if (existing.revokedAt) return mapOutcomeGrant(existing);
      const revoked = await tx.emergencyOutcomeGrant.update({
        where: { id: grantId },
        data: { revokedAt: /* @__PURE__ */ new Date(), revokedByUserId, revokeReason: revokeReason ?? null }
      });
      await events.recordInTransaction(tx, defineEvent("OUTCOME_GRANT_REVOKED", {
        emergencyId: revoked.emergencyId,
        entityType: "emergency_outcome_grant",
        entityId: revoked.id,
        actorType: "OPERATOR",
        actorId: revokedByUserId,
        payload: {
          contractVersion: 1,
          emergencyId: revoked.emergencyId,
          grantId: revoked.id,
          granteeUserId: revoked.granteeUserId,
          capability: revoked.capability,
          revokedAt: (revoked.revokedAt ?? /* @__PURE__ */ new Date()).toISOString(),
          revokeReason: revoked.revokeReason
        }
      }));
      return mapOutcomeGrant(revoked);
    }), "Failed to revoke outcome access grant");
  }
  /** Newest-first audit history of grant lifecycle events, scoped to one emergency. */
  async listGrantEvents(emergencyId, options = {}) {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
    const offset = Math.max(options.offset ?? 0, 0);
    const where = { emergencyId, type: { in: [...OUTCOME_GRANT_EVENT_TYPES] } };
    return guardDatabase(async () => {
      const [rows, total] = await Promise.all([
        this.db.systemEvent.findMany({ where, orderBy: { seq: "desc" }, take: limit, skip: offset }),
        this.db.systemEvent.count({ where })
      ]);
      return { items: rows.map((row) => mapSystemEvent(row)), total };
    }, "Failed to list outcome grant audit events");
  }
  /** Current grant rows (active and revoked) for one emergency, newest first. */
  async listGrants(emergencyId, options = {}) {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
    const offset = Math.max(options.offset ?? 0, 0);
    return guardDatabase(async () => {
      const [rows, total] = await Promise.all([
        this.db.emergencyOutcomeGrant.findMany({
          where: { emergencyId },
          orderBy: { createdAt: "desc" },
          take: limit,
          skip: offset
        }),
        this.db.emergencyOutcomeGrant.count({ where: { emergencyId } })
      ]);
      return { items: rows.map(mapOutcomeGrant), total };
    }, "Failed to list outcome access grants");
  }
  /**
   * Per-emergency scope for the outcome HTTP surface, by capability. Explicit
   * grants are authoritative once any grant row exists for this user on this
   * emergency: an active grant with the required capability authorizes, and a
   * revocation removes access even when the user previously submitted or
   * reviewed here. Without grant rows the legacy outcome-ownership
   * relationships remain (documented compatibility): a prior assertion or the
   * legacy outcome recorder may submit and read; a prior reviewer may review
   * and read. Operational participation (dispatch decisions, protocol starts,
   * driver assignment links) and incidental event actor records never grant
   * access. Fails closed on unknown capabilities and storage errors.
   */
  async hasEmergencyAccess(userId, emergencyId, capability) {
    if (!userId || !emergencyId) return false;
    if (capability !== "READ" && !OUTCOME_ACCESS_CAPABILITIES.includes(capability)) {
      return false;
    }
    return guardDatabase(async () => {
      const grants = await this.db.emergencyOutcomeGrant.findMany({
        where: { emergencyId, granteeUserId: userId },
        select: { capability: true, revokedAt: true }
      });
      if (grants.length > 0) {
        const active = grants.filter((grant) => grant.revokedAt === null);
        if (capability === "READ") return active.length > 0;
        return active.some((grant) => grant.capability === capability);
      }
      if (capability === "SUBMIT") {
        const [priorAssertion2, priorLegacyOutcome2] = await Promise.all([
          this.db.outcomeAssertion.findFirst({ where: { emergencyId, submittedByUserId: userId }, select: { id: true } }),
          this.db.outcome.findFirst({ where: { emergencyId, recordedByUserId: userId }, select: { id: true } })
        ]);
        return Boolean(priorAssertion2 || priorLegacyOutcome2);
      }
      if (capability === "REVIEW") {
        const priorReview2 = await this.db.outcomeReview.findFirst({
          where: { reviewerUserId: userId, outcome: { emergencyId } },
          select: { id: true }
        });
        return Boolean(priorReview2);
      }
      const [priorAssertion, priorReview, priorLegacyOutcome] = await Promise.all([
        this.db.outcomeAssertion.findFirst({ where: { emergencyId, submittedByUserId: userId }, select: { id: true } }),
        this.db.outcomeReview.findFirst({ where: { reviewerUserId: userId, outcome: { emergencyId } }, select: { id: true } }),
        this.db.outcome.findFirst({ where: { emergencyId, recordedByUserId: userId }, select: { id: true } })
      ]);
      return Boolean(priorAssertion || priorReview || priorLegacyOutcome);
    }, "Failed to evaluate emergency outcome access");
  }
  requireEvents() {
    if (!this.events) throw new Error("Outcome history writes require the Module 11 event service.");
    return this.events;
  }
  async upsert(input) {
    const row = await guardDatabase(
      async () => this.db.outcome.upsert({
        where: { emergencyId: input.emergencyId },
        create: {
          id: createId("OUT"),
          emergencyId: input.emergencyId,
          status: input.status,
          provenance: input.provenance,
          survivalToDischarge: input.survivalToDischarge ?? null,
          notes: input.notes ?? null,
          recordedByUserId: input.recordedByUserId ?? null
        },
        update: {
          status: input.status,
          provenance: input.provenance,
          survivalToDischarge: input.survivalToDischarge ?? void 0,
          notes: input.notes ?? void 0,
          recordedByUserId: input.recordedByUserId ?? void 0,
          recordedAt: /* @__PURE__ */ new Date()
        }
      }),
      "Failed to persist outcome"
    );
    return mapOutcome(row);
  }
  async forEmergency(emergencyId) {
    return guardDatabase(async () => {
      const row = await this.db.outcome.findUnique({ where: { emergencyId } });
      return row ? mapOutcome(row) : null;
    }, "Failed to read outcome");
  }
  async list(filter = {}) {
    return guardDatabase(async () => {
      const rows = await this.db.outcome.findMany({
        where: {
          ...filter.since ? { recordedAt: { gte: new Date(filter.since) } } : {},
          ...filter.includeSimulation ? {} : { emergency: { isSimulation: false } }
        },
        orderBy: { recordedAt: "desc" }
      });
      return rows.map((row) => mapOutcome(row));
    }, "Failed to list outcomes");
  }
};
function normalizeOutcomeAssertion(input) {
  const category = outcomeStatusSchema.safeParse(input.category);
  if (!category.success) throw AppError.validation("Unsupported outcome category.");
  if (input.categoryVersion !== "OUTCOME_V1") throw AppError.validation("Unsupported outcome category version.");
  if (!Object.values(DATA_PROVENANCE).includes(input.provenance)) throw AppError.validation("Unsupported outcome provenance.");
  if (!["OPERATIONAL", "SIMULATION", "TEST", "UNVERIFIED_LEGACY"].includes(input.dataClassification)) throw AppError.validation("Unsupported outcome data classification.");
  const expectedSurvival = category.data === "SURVIVED_TO_DISCHARGE" ? true : category.data === "DECEASED" ? false : null;
  const survival = input.survivalToDischarge ?? null;
  if (survival !== expectedSurvival) throw AppError.validation("Outcome category and survival label are inconsistent.");
  const idempotencyKey = validateIdempotencyKey(input.idempotencyKey);
  const observedAt = input.observedAt == null ? null : new Date(input.observedAt);
  if (observedAt && Number.isNaN(observedAt.getTime())) throw AppError.validation("Invalid outcome observation timestamp.");
  if (input.evidenceRefs != null && !Array.isArray(input.evidenceRefs)) throw AppError.validation("Evidence references must be a list.");
  const evidenceRefs = input.evidenceRefs == null ? null : input.evidenceRefs.map((ref) => {
    if (typeof ref !== "string" || ref.trim().length < 1 || ref.trim().length > 256) throw AppError.validation("Invalid evidence reference.");
    return ref.trim();
  });
  if (evidenceRefs && evidenceRefs.length > 32) throw AppError.validation("Too many evidence references.");
  const correctionReasonCode = input.correctionReasonCode ?? null;
  if (input.supersedesOutcomeId && (!correctionReasonCode || !OUTCOME_CORRECTION_REASON_CODES.includes(correctionReasonCode))) {
    throw AppError.validation("A correction requires a supported correction reason code.");
  }
  if (!input.supersedesOutcomeId && correctionReasonCode) throw AppError.validation("A correction reason is only valid when superseding an outcome.");
  return {
    emergencyId: validateIdentifier(input.emergencyId, "emergencyId"),
    category: category.data,
    categoryVersion: input.categoryVersion,
    provenance: input.provenance,
    dataClassification: input.dataClassification,
    survivalToDischarge: survival,
    observedAt,
    submittedByUserId: input.submittedByUserId ? validateIdentifier(input.submittedByUserId, "submitter id") : null,
    evidenceRefs,
    correctionReasonCode,
    idempotencyKey,
    supersedesOutcomeId: input.supersedesOutcomeId ? validateIdentifier(input.supersedesOutcomeId, "predecessor id") : null
  };
}
function normalizeOutcomeReview(input) {
  if (!["APPROVED", "REJECTED", "NEEDS_EVIDENCE"].includes(input.decision)) throw AppError.validation("Unsupported review decision.");
  if (input.eligibleForLearning && input.decision !== "APPROVED") throw AppError.validation("Only an approved review may mark an outcome eligible.");
  if (!OUTCOME_REVIEW_REASON_CODES.includes(input.eligibilityReasonCode)) throw AppError.validation("Unsupported eligibility reason code.");
  if (input.reviewReasonCode != null && !OUTCOME_REVIEW_REASON_CODES.includes(input.reviewReasonCode)) throw AppError.validation("Unsupported review reason code.");
  if (input.decision !== "APPROVED" && !input.reviewReasonCode) throw AppError.validation("Rejected or deferred reviews require a reason code.");
  const evidenceAssessment = input.evidenceAssessment == null ? null : JSON.parse(stableJson(input.evidenceAssessment));
  if (evidenceAssessment && stableJson(evidenceAssessment).length > 4096) throw AppError.validation("Evidence assessment metadata is too large.");
  return {
    outcomeRecordId: validateIdentifier(input.outcomeRecordId, "outcome record id"),
    reviewerUserId: validateIdentifier(input.reviewerUserId, "reviewer id"),
    decision: input.decision,
    reviewReasonCode: input.reviewReasonCode ?? null,
    eligibleForLearning: input.eligibleForLearning,
    eligibilityReasonCode: input.eligibilityReasonCode,
    evidenceAssessment,
    idempotencyKey: validateIdempotencyKey(input.idempotencyKey),
    supersedesReviewId: input.supersedesReviewId ? validateIdentifier(input.supersedesReviewId, "review predecessor id") : null
  };
}
function enforceOutcomeClassification(input, isSimulation) {
  if (isSimulation && (input.dataClassification !== "SIMULATION" || input.provenance !== "SIMULATION")) {
    throw AppError.validation("Simulation emergencies must be classified and labelled as simulation.");
  }
  if (!isSimulation && input.dataClassification === "SIMULATION") throw AppError.validation("Simulation outcome data requires a simulation emergency.");
  if (input.dataClassification === "OPERATIONAL" && input.provenance !== "REAL_OBSERVED") {
    throw AppError.validation("Operational outcome data must use REAL_OBSERVED provenance.");
  }
  if (input.dataClassification === "TEST" && input.provenance === "REAL_OBSERVED") {
    throw AppError.validation("Test outcome data cannot claim real observed provenance.");
  }
}
function validateIdempotencyKey(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/.test(value)) throw AppError.validation("Invalid idempotency key.");
  return value;
}
function validateIdentifier(value, label) {
  if (typeof value !== "string" || value.trim().length < 1 || value.trim().length > 128) throw AppError.validation(`Invalid ${label}.`);
  return value.trim();
}
function AppErrorConflict(message) {
  return new AppError(ErrorCode.CONFLICT, message, 409);
}
function sameAssertion(row, input) {
  return row.emergencyId === input.emergencyId && row.category === input.category && row.categoryVersion === input.categoryVersion && row.provenance === input.provenance && row.dataClassification === input.dataClassification && row.survivalToDischarge === input.survivalToDischarge && row.observedAt?.toISOString() === input.observedAt?.toISOString() && row.submittedByUserId === input.submittedByUserId && row.evidenceRefsJson === (input.evidenceRefs ? JSON.stringify(input.evidenceRefs) : null) && row.correctionReasonCode === input.correctionReasonCode && row.supersedesOutcomeId === input.supersedesOutcomeId;
}
function sameReview(row, input) {
  return row.outcomeRecordId === input.outcomeRecordId && row.reviewerUserId === input.reviewerUserId && row.decision === input.decision && row.reviewReasonCode === input.reviewReasonCode && row.eligibleForLearning === input.eligibleForLearning && row.eligibilityReasonCode === input.eligibilityReasonCode && row.evidenceAssessmentJson === (input.evidenceAssessment ? stableJson(input.evidenceAssessment) : null) && row.supersedesReviewId === input.supersedesReviewId;
}
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function mapOutcomeAssertion(row) {
  let evidenceRefs = null;
  if (row.evidenceRefsJson) {
    try {
      const parsed = JSON.parse(row.evidenceRefsJson);
      if (Array.isArray(parsed) && parsed.every((v) => typeof v === "string")) evidenceRefs = parsed;
    } catch {
      evidenceRefs = null;
    }
  }
  return {
    id: row.id,
    emergencyId: row.emergencyId,
    category: outcomeStatusSchema.parse(row.category),
    categoryVersion: row.categoryVersion,
    provenance: row.provenance,
    dataClassification: row.dataClassification,
    survivalToDischarge: row.survivalToDischarge,
    observedAt: row.observedAt?.toISOString() ?? null,
    recordedAt: row.recordedAt.toISOString(),
    submittedByUserId: row.submittedByUserId,
    evidenceRefs,
    correctionReasonCode: row.correctionReasonCode,
    idempotencyKey: row.idempotencyKey,
    supersedesOutcomeId: row.supersedesOutcomeId
  };
}
function mapOutcomeReview(row) {
  let evidenceAssessment = null;
  if (row.evidenceAssessmentJson) {
    try {
      const parsed = JSON.parse(row.evidenceAssessmentJson);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) evidenceAssessment = parsed;
    } catch {
      evidenceAssessment = null;
    }
  }
  return {
    id: row.id,
    outcomeRecordId: row.outcomeRecordId,
    reviewerUserId: row.reviewerUserId,
    decision: row.decision,
    reviewReasonCode: row.reviewReasonCode,
    reviewedAt: row.reviewedAt.toISOString(),
    eligibleForLearning: row.eligibleForLearning,
    eligibilityReasonCode: row.eligibilityReasonCode,
    evidenceAssessment,
    idempotencyKey: row.idempotencyKey,
    supersedesReviewId: row.supersedesReviewId
  };
}
function mapOutcomeGrant(row) {
  return {
    id: row.id,
    emergencyId: row.emergencyId,
    granteeUserId: row.granteeUserId,
    capability: row.capability,
    grantedByUserId: row.grantedByUserId,
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    revokedByUserId: row.revokedByUserId,
    revokeReason: row.revokeReason
  };
}

// modules/module_11_database_event_system/src/api/routes.ts
var listEventsQuery = z3.object({
  emergencyId: z3.string().optional(),
  entityId: z3.string().optional(),
  // Fastify's query parser represents a comma-delimited value as an array.
  // Normalize that parsed form as well as the documented CSV form before
  // filtering event types, so clients can use the same query contract.
  types: z3.preprocess(
    (value) => Array.isArray(value) && value.every((item) => typeof item === "string") ? value.join(",") : value,
    z3.string().optional()
  ).transform(
    (value) => value ? value.split(",").map((item) => item.trim()).filter((item) => isSystemEventType(item)) : void 0
  ),
  sinceSequence: z3.coerce.number().int().nonnegative().optional(),
  since: z3.string().optional(),
  until: z3.string().optional(),
  limit: z3.coerce.number().int().min(1).max(500).optional(),
  offset: z3.coerce.number().int().min(0).optional()
});
var createEmergencyBody = z3.object({
  incidentType: incidentTypeSchema,
  severity: z3.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]),
  latitude: z3.number().min(-90).max(90),
  longitude: z3.number().min(-180).max(180),
  description: z3.string().max(2e3).nullish(),
  callerId: z3.string().max(64).nullish(),
  address: z3.string().max(300).nullish(),
  isSimulation: z3.boolean().default(false),
  /** Optional immediate classification. */
  classify: z3.boolean().default(false),
  classificationConfidence: z3.number().min(0).max(1).optional()
});
var updateEmergencyBody = z3.object({
  status: z3.enum([
    "CREATED",
    "CALL_ACTIVE",
    "CLASSIFIED",
    "PROTOCOL_ACTIVE",
    "AWAITING_AMBULANCE",
    "AMBULANCE_ASSIGNED",
    "EN_ROUTE",
    "ON_SCENE",
    "PATIENT_ONBOARD",
    "TRANSPORTING",
    "AT_HOSPITAL",
    "COMPLETED",
    "CANCELLED"
  ]).optional(),
  severity: z3.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]).optional(),
  /**
   * An operator-reviewed, normalized classification for an existing emergency.
   * Module 3 candidate vocabulary is never accepted as authoritative input here.
   */
  normalizedClassification: z3.object({
    incidentType: incidentTypeSchema,
    severity: z3.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]),
    confidence: z3.number().min(0).max(1).default(1)
  }).optional(),
  description: z3.string().max(2e3).nullish(),
  selectedHospitalId: z3.string().nullish()
}).superRefine((body, context) => {
  if (body.normalizedClassification && (body.status !== void 0 || body.severity !== void 0)) {
    context.addIssue({
      code: z3.ZodIssueCode.custom,
      message: "Use normalizedClassification alone for an operator classification decision.",
      path: ["normalizedClassification"]
    });
  }
});
var outcomeAssertionBody = z3.object({
  category: outcomeStatusSchema,
  categoryVersion: z3.literal("OUTCOME_V1"),
  survivalToDischarge: z3.boolean().nullable().optional(),
  observedAt: z3.string().datetime({ offset: true }).nullable().optional(),
  evidenceRefs: z3.array(z3.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/)).max(32).nullable().optional()
}).strict();
var outcomeCorrectionBody = outcomeAssertionBody.extend({
  correctionReasonCode: z3.enum(OUTCOME_CORRECTION_REASON_CODES)
}).strict();
var outcomeReviewBody = z3.object({
  decision: z3.enum(OUTCOME_REVIEW_DECISIONS),
  reasonCode: z3.enum(OUTCOME_REVIEW_REASON_CODES).optional(),
  eligibilityDecision: z3.enum(OUTCOME_ELIGIBILITY_DECISIONS),
  eligibilityReasonCode: z3.enum(OUTCOME_REVIEW_REASON_CODES),
  supersedesReviewId: z3.string().min(1).max(128).optional()
}).strict().superRefine((body, context) => {
  if (body.decision !== "APPROVED" && !body.reasonCode) {
    context.addIssue({ code: z3.ZodIssueCode.custom, message: "Rejected or deferred reviews require a reason code.", path: ["reasonCode"] });
  }
});
var outcomeHistoryQuery = z3.object({
  limit: z3.coerce.number().int().min(1).max(200).default(100),
  offset: z3.coerce.number().int().min(0).default(0)
});
var outcomeParams = z3.object({ id: z3.string().min(1).max(128) });
var outcomeReviewParams = z3.object({ id: z3.string().min(1).max(128), outcomeId: z3.string().min(1).max(128) });
var lifecycleMilestoneParams = z3.object({
  id: z3.string().min(1).max(128),
  milestone: z3.enum(["scene-arrival", "patient-onboard", "hospital-arrival", "operational-completion"])
});
var lifecycleMilestoneTypes = {
  "scene-arrival": "AMBULANCE_ARRIVED_SCENE",
  "patient-onboard": "PATIENT_ONBOARD",
  "hospital-arrival": "AMBULANCE_ARRIVED_HOSPITAL",
  "operational-completion": "EMERGENCY_COMPLETED"
};
var submitterRoles = ["OUTCOME_SUBMITTER"];
var reviewerRoles = ["OUTCOME_REVIEWER"];
var outcomeReadRoles = ["OUTCOME_SUBMITTER", "OUTCOME_REVIEWER"];
var grantManagerRoles = ["ADMIN"];
var outcomeGrantParams = z3.object({
  id: z3.string().min(1).max(128),
  grantId: z3.string().min(1).max(128)
});
var outcomeGrantBody = z3.object({
  granteeUserId: z3.string().min(1).max(128),
  capability: z3.enum(OUTCOME_ACCESS_CAPABILITIES)
}).strict();
var revokeGrantBody = z3.object({
  revokeReason: z3.string().trim().min(1).max(500).optional()
}).strict();
var outcomeGrantPageQuery = z3.object({
  limit: z3.coerce.number().int().min(1).max(100).optional(),
  offset: z3.coerce.number().int().min(0).optional()
});
function createModule11Routes(module11, options = {}) {
  const { emergencies, events, calls } = module11;
  return [
    {
      method: "GET",
      url: "/api/events",
      module: "module_11",
      summary: "Query the append-only system event log",
      auth: { roles: ["OPERATOR", "DISPATCHER", "CLINICAL_SUPERVISOR", "ADMIN"] },
      query: listEventsQuery,
      handler: async (request, reply) => {
        const query = listEventsQuery.parse(request.query);
        const result = await events.list({
          emergencyId: query.emergencyId,
          entityId: query.entityId,
          types: query.types,
          sinceSequence: query.sinceSequence,
          since: query.since,
          until: query.until,
          limit: query.limit,
          offset: query.offset
        });
        return reply.send({
          items: result.items,
          total: result.total,
          limit: query.limit ?? 100,
          offset: query.offset ?? 0,
          latestSequence: result.latestSequence
        });
      }
    },
    {
      method: "GET",
      url: "/api/events/types",
      module: "module_11",
      summary: "Event type vocabulary",
      auth: { public: true },
      handler: async (_request, reply) => reply.send({ types: SYSTEM_EVENT_TYPES })
    },
    {
      method: "GET",
      url: "/api/events/:id",
      module: "module_11",
      summary: "Fetch a single event by id",
      auth: { roles: ["OPERATOR", "DISPATCHER", "CLINICAL_SUPERVISOR", "ADMIN"] },
      handler: async (request, reply) => {
        const id = String(request.params.id ?? "");
        const event = await events.getById(id);
        if (!event) throw AppError.notFound("Event", id);
        return reply.send(event);
      }
    },
    {
      method: "GET",
      url: "/api/emergencies/:id/events",
      module: "module_11",
      summary: "Ordered timeline of one emergency (derived from the event log)",
      auth: { roles: ["OPERATOR", "DISPATCHER", "CLINICAL_SUPERVISOR", "ADMIN"] },
      handler: async (request, reply) => {
        const id = String(request.params.id ?? "");
        await emergencies.requireById(id);
        return reply.send({ emergencyId: id, events: await events.timeline(id) });
      }
    },
    {
      method: "GET",
      url: "/api/emergencies",
      module: "module_11",
      summary: "List emergencies",
      auth: { roles: ["OPERATOR", "DISPATCHER", "CLINICAL_SUPERVISOR", "ADMIN"] },
      query: z3.object({
        status: z3.string().optional(),
        includeSimulation: z3.coerce.boolean().default(false),
        limit: z3.coerce.number().int().min(1).max(200).optional(),
        offset: z3.coerce.number().int().min(0).optional()
      }),
      handler: async (request, reply) => {
        const query = request.query;
        const items = await emergencies.list({
          statuses: query.status ? query.status.split(",") : void 0,
          includeSimulation: query.includeSimulation,
          limit: query.limit,
          offset: query.offset
        });
        return reply.send(
          paginated(items, items.length, query.limit ?? 100, query.offset ?? 0)
        );
      }
    },
    {
      method: "GET",
      url: "/api/emergencies/:id",
      module: "module_11",
      summary: "Read one emergency",
      auth: { roles: ["OPERATOR", "DISPATCHER", "CLINICAL_SUPERVISOR", "ADMIN"] },
      handler: async (request, reply) => reply.send(await emergencies.requireById(String(request.params.id ?? "")))
    },
    {
      method: "POST",
      url: "/api/emergencies",
      module: "module_11",
      summary: "Create an emergency (writes the row and the EMERGENCY_CREATED event in one transaction)",
      auth: { roles: ["OPERATOR", "DISPATCHER", "ADMIN"] },
      body: createEmergencyBody,
      handler: async (request, reply) => {
        const body = createEmergencyBody.parse(request.body);
        const emergency = await emergencies.create({
          incidentType: body.incidentType,
          severity: body.severity,
          latitude: body.latitude,
          longitude: body.longitude,
          description: body.description ?? null,
          callerId: body.callerId ?? null,
          address: body.address ?? null,
          isSimulation: body.isSimulation,
          actor: { actorType: "OPERATOR", actorId: request.user?.userId ?? null }
        });
        const call = await calls.startSession({
          emergencyId: emergency.id,
          callerId: body.callerId ?? null,
          isSimulation: body.isSimulation
        });
        let classified = emergency;
        if (body.classify) {
          classified = await emergencies.setStatus(
            emergency.id,
            "CLASSIFIED",
            {
              type: "EMERGENCY_CLASSIFIED",
              payload: {
                incidentType: body.incidentType,
                severity: body.severity,
                confidence: body.classificationConfidence ?? 1,
                source: "OPERATOR"
              }
            },
            { actorType: "OPERATOR", actorId: request.user?.userId ?? null }
          );
        }
        return reply.status(201).send({ emergency: classified, callSession: call });
      }
    },
    {
      method: "PATCH",
      url: "/api/emergencies/:id",
      module: "module_11",
      summary: "Operator update or explicit normalized classification of an emergency",
      auth: { roles: ["OPERATOR", "DISPATCHER", "ADMIN"] },
      body: updateEmergencyBody,
      handler: async (request, reply) => {
        const id = String(request.params.id ?? "");
        const body = updateEmergencyBody.parse(request.body);
        if (body.normalizedClassification) {
          const current = await emergencies.requireById(id);
          const classification = body.normalizedClassification;
          const shouldMarkClassified = current.status === "CREATED" || current.status === "CALL_ACTIVE";
          const emergency2 = await emergencies.update(
            id,
            {
              incidentType: classification.incidentType,
              severity: classification.severity,
              ...shouldMarkClassified ? { status: "CLASSIFIED" } : {},
              description: body.description,
              selectedHospitalId: body.selectedHospitalId
            },
            {
              type: "EMERGENCY_CLASSIFIED",
              payload: {
                incidentType: classification.incidentType,
                severity: classification.severity,
                confidence: classification.confidence,
                source: "OPERATOR"
              }
            },
            { actorType: "OPERATOR", actorId: request.user?.userId ?? null }
          );
          return reply.send(emergency2);
        }
        const emergency = await emergencies.update(
          id,
          {
            status: body.status,
            severity: body.severity,
            description: body.description,
            selectedHospitalId: body.selectedHospitalId
          },
          body.status ? {
            type: "EMERGENCY_STATUS_CHANGED",
            payload: { from: (await emergencies.requireById(id)).status, to: body.status, source: "OPERATOR" }
          } : void 0,
          { actorType: "OPERATOR", actorId: request.user?.userId ?? null }
        );
        return reply.send(emergency);
      }
    },
    {
      method: "GET",
      url: "/api/emergencies/:id/transcripts",
      module: "module_11",
      summary: "Verbatim call transcript for an emergency",
      auth: { roles: ["OPERATOR", "DISPATCHER", "CLINICAL_SUPERVISOR", "ADMIN"] },
      handler: async (request, reply) => {
        const id = String(request.params.id ?? "");
        await emergencies.requireById(id);
        return reply.send({ emergencyId: id, transcripts: await calls.transcriptsFor(id) });
      }
    },
    {
      method: "POST",
      url: "/api/emergencies/:id/lifecycle-milestones/:milestone",
      module: "module_11",
      summary: "Record an explicit operator-reported operational lifecycle milestone",
      auth: { roles: ["OPERATOR", "DISPATCHER", "ADMIN"] },
      params: lifecycleMilestoneParams,
      handler: async (request, reply) => {
        const { id, milestone } = lifecycleMilestoneParams.parse(request.params);
        const result = await emergencies.recordLifecycleMilestone({
          emergencyId: id,
          milestone: lifecycleMilestoneTypes[milestone],
          actorId: request.user.userId,
          actorRole: request.user.role
        });
        return reply.status(result.duplicate ? 200 : 201).send({
          event: result.event,
          duplicate: result.duplicate,
          evidenceSource: "OPERATOR_REPORTED",
          operationalOnly: true
        });
      }
    },
    {
      method: "POST",
      url: "/api/emergencies/:id/outcomes",
      module: "module_11",
      summary: "Append an outcome assertion for independent review",
      auth: { roles: [...submitterRoles] },
      params: outcomeParams,
      body: outcomeAssertionBody,
      handler: async (request, reply) => {
        const { id } = outcomeParams.parse(request.params);
        const body = outcomeAssertionBody.parse(request.body);
        const idempotencyKey = readIdempotencyKey(request.headers);
        const emergency = await emergencies.requireById(id);
        await requireOutcomeScope(module11, request.user.userId, id, "SUBMIT");
        const classification = outcomeDataClassification(emergency.isSimulation, options.nodeEnv);
        const assertion = await module11.outcomes.recordAssertion({
          emergencyId: id,
          category: body.category,
          categoryVersion: body.categoryVersion,
          provenance: classification.provenance,
          dataClassification: classification.dataClassification,
          survivalToDischarge: body.survivalToDischarge,
          observedAt: body.observedAt,
          evidenceRefs: body.evidenceRefs,
          submittedByUserId: request.user.userId,
          idempotencyKey
        });
        const reviewStatus = await module11.outcomes.reviewStatusForAssertion(id, assertion.id);
        return reply.status(201).send(publicAssertion(assertion, reviewStatus ?? "PENDING"));
      }
    },
    {
      method: "GET",
      url: "/api/emergencies/:id/outcomes",
      module: "module_11",
      summary: "Read append-only outcome assertion and review history",
      auth: { roles: [...outcomeReadRoles] },
      params: outcomeParams,
      query: outcomeHistoryQuery,
      handler: async (request, reply) => {
        const { id } = outcomeParams.parse(request.params);
        const query = outcomeHistoryQuery.parse(request.query);
        await emergencies.requireById(id);
        await requireOutcomeScope(module11, request.user.userId, id, "READ");
        const history = await module11.outcomes.historyForEmergency(id, query.limit, query.offset);
        const legacyOutcome = await module11.outcomes.forEmergency(id);
        return reply.send({
          emergencyId: id,
          items: history.items.map((record) => ({
            ...publicAssertion(record, record.reviewStatus),
            isCurrent: record.isCurrent,
            predecessorId: record.predecessorId,
            successorId: record.successorId,
            reviews: record.reviews.map(publicReview)
          })),
          total: history.total,
          limit: query.limit,
          offset: query.offset,
          legacyOutcome: legacyOutcome ? {
            id: legacyOutcome.id,
            status: legacyOutcome.status,
            provenance: legacyOutcome.provenance,
            survivalToDischarge: legacyOutcome.survivalToDischarge,
            recordedAt: legacyOutcome.recordedAt,
            classification: "UNVERIFIED_LEGACY"
          } : null
        });
      }
    },
    {
      method: "POST",
      url: "/api/emergencies/:id/outcomes/:outcomeId/reviews",
      module: "module_11",
      summary: "Append an independent outcome review decision",
      auth: { roles: [...reviewerRoles] },
      params: outcomeReviewParams,
      body: outcomeReviewBody,
      handler: async (request, reply) => {
        const { id, outcomeId } = outcomeReviewParams.parse(request.params);
        const body = outcomeReviewBody.parse(request.body);
        const idempotencyKey = readIdempotencyKey(request.headers);
        await emergencies.requireById(id);
        await requireOutcomeScope(module11, request.user.userId, id, "REVIEW");
        const assertion = await module11.outcomes.assertionForEmergency(id, outcomeId);
        if (!assertion) throw AppError.notFound("Outcome assertion", outcomeId);
        const eligibleForLearning = body.eligibilityDecision === "ELIGIBLE";
        if (eligibleForLearning && (body.decision !== "APPROVED" || assertion.dataClassification !== "OPERATIONAL" || assertion.provenance !== "REAL_OBSERVED" || !["SURVIVED_TO_DISCHARGE", "DECEASED"].includes(assertion.category))) throw AppError.validation("Only an approved operational survival outcome with verified provenance may be marked learning eligible.");
        const review = await module11.outcomes.recordReview({
          outcomeRecordId: outcomeId,
          reviewerUserId: request.user.userId,
          decision: body.decision,
          reviewReasonCode: body.reasonCode,
          eligibleForLearning,
          eligibilityReasonCode: body.eligibilityReasonCode,
          idempotencyKey,
          supersedesReviewId: body.supersedesReviewId
        });
        const history = await module11.outcomes.historyForEmergency(id, 200, 0);
        const reviewedAssertion = history.items.find((item) => item.id === outcomeId);
        return reply.status(201).send({
          review: publicReview(review),
          reviewStatus: reviewedAssertion?.reviewStatus ?? review.decision,
          reviews: reviewedAssertion?.reviews.map(publicReview) ?? [publicReview(review)]
        });
      }
    },
    {
      method: "POST",
      url: "/api/emergencies/:id/outcomes/:outcomeId/supersessions",
      module: "module_11",
      summary: "Append a corrected outcome assertion that supersedes an earlier assertion",
      auth: { roles: [...submitterRoles] },
      params: outcomeReviewParams,
      body: outcomeCorrectionBody,
      handler: async (request, reply) => {
        const { id, outcomeId } = outcomeReviewParams.parse(request.params);
        const body = outcomeCorrectionBody.parse(request.body);
        const idempotencyKey = readIdempotencyKey(request.headers);
        const emergency = await emergencies.requireById(id);
        await requireOutcomeScope(module11, request.user.userId, id, "SUBMIT");
        if (!await module11.outcomes.assertionForEmergency(id, outcomeId)) {
          throw AppError.notFound("Outcome assertion", outcomeId);
        }
        const classification = outcomeDataClassification(emergency.isSimulation, options.nodeEnv);
        const assertion = await module11.outcomes.recordAssertion({
          emergencyId: id,
          category: body.category,
          categoryVersion: body.categoryVersion,
          provenance: classification.provenance,
          dataClassification: classification.dataClassification,
          survivalToDischarge: body.survivalToDischarge,
          observedAt: body.observedAt,
          evidenceRefs: body.evidenceRefs,
          correctionReasonCode: body.correctionReasonCode,
          submittedByUserId: request.user.userId,
          idempotencyKey,
          supersedesOutcomeId: outcomeId
        });
        const reviewStatus = await module11.outcomes.reviewStatusForAssertion(id, assertion.id);
        return reply.status(201).send(publicAssertion(assertion, reviewStatus ?? "PENDING"));
      }
    },
    {
      method: "POST",
      url: "/api/emergencies/:id/outcome-grants",
      module: "module_11",
      summary: "Grant an emergency-scoped outcome capability to a user",
      auth: { roles: [...grantManagerRoles] },
      params: outcomeParams,
      body: outcomeGrantBody,
      handler: async (request, reply) => {
        const { id } = outcomeParams.parse(request.params);
        const body = outcomeGrantBody.parse(request.body);
        await emergencies.requireById(id);
        await module11.users.requireById(body.granteeUserId);
        const grant = await module11.outcomes.recordGrant({
          emergencyId: id,
          granteeUserId: body.granteeUserId,
          capability: body.capability,
          grantedByUserId: request.user.userId
        });
        return reply.status(201).send(publicGrant(grant));
      }
    },
    {
      method: "DELETE",
      url: "/api/emergencies/:id/outcome-grants/:grantId",
      module: "module_11",
      summary: "Revoke an emergency-scoped outcome capability grant",
      auth: { roles: [...grantManagerRoles] },
      params: outcomeGrantParams,
      handler: async (request, reply) => {
        const { id, grantId } = outcomeGrantParams.parse(request.params);
        const parsedBody = revokeGrantBody.safeParse(request.body ?? {});
        if (!parsedBody.success) {
          throw AppError.validation("The request did not match the expected shape.", { issues: parsedBody.error.issues });
        }
        await emergencies.requireById(id);
        const grant = await module11.outcomes.revokeGrant(grantId, id, request.user.userId, parsedBody.data.revokeReason ?? null);
        if (!grant) throw AppError.notFound("Outcome access grant", grantId);
        return reply.send(publicGrant(grant));
      }
    },
    {
      method: "GET",
      url: "/api/emergencies/:id/outcome-grant-events",
      module: "module_11",
      summary: "ADMIN-only audit history of outcome access grant lifecycle events",
      auth: { roles: [...grantManagerRoles] },
      params: outcomeParams,
      query: outcomeGrantPageQuery,
      handler: async (request, reply) => {
        const { id } = outcomeParams.parse(request.params);
        const query = outcomeGrantPageQuery.parse(request.query);
        await emergencies.requireById(id);
        const result = await module11.outcomes.listGrantEvents(id, { limit: query.limit, offset: query.offset });
        return reply.send({
          emergencyId: id,
          items: result.items,
          total: result.total,
          limit: query.limit ?? 50,
          offset: query.offset ?? 0
        });
      }
    },
    {
      method: "GET",
      url: "/api/emergencies/:id/outcome-grants",
      module: "module_11",
      summary: "ADMIN-only list of current outcome access grant rows for one emergency",
      auth: { roles: [...grantManagerRoles] },
      params: outcomeParams,
      query: outcomeGrantPageQuery,
      handler: async (request, reply) => {
        const { id } = outcomeParams.parse(request.params);
        const query = outcomeGrantPageQuery.parse(request.query);
        await emergencies.requireById(id);
        const result = await module11.outcomes.listGrants(id, { limit: query.limit, offset: query.offset });
        return reply.send({
          emergencyId: id,
          items: result.items.map(publicGrant),
          total: result.total,
          limit: query.limit ?? 50,
          offset: query.offset ?? 0
        });
      }
    }
  ];
}
async function requireOutcomeScope(module11, userId, emergencyId, capability) {
  if (!await module11.outcomes.hasEmergencyAccess(userId, emergencyId, capability)) {
    throw new AppError(ErrorCode.FORBIDDEN, "You are not authorized to access outcome records for this emergency.", 403);
  }
}
function readIdempotencyKey(headers) {
  const value = headers["idempotency-key"] ?? headers["Idempotency-Key"];
  if (typeof value !== "string" || value.length < 8 || value.length > 200) {
    throw AppError.validation("A valid Idempotency-Key header is required.");
  }
  return value;
}
function outcomeDataClassification(isSimulation, nodeEnv = process.env.NODE_ENV) {
  if (isSimulation) return { dataClassification: "SIMULATION", provenance: "SIMULATION" };
  if (nodeEnv === "test") return { dataClassification: "TEST", provenance: "SIMULATION" };
  return { dataClassification: "OPERATIONAL", provenance: "REAL_OBSERVED" };
}
function publicAssertion(assertion, reviewStatus) {
  return {
    id: assertion.id,
    emergencyId: assertion.emergencyId,
    category: assertion.category,
    categoryVersion: assertion.categoryVersion,
    provenance: assertion.provenance,
    dataClassification: assertion.dataClassification,
    survivalToDischarge: assertion.survivalToDischarge,
    observedAt: assertion.observedAt,
    recordedAt: assertion.recordedAt,
    submittedByUserId: assertion.submittedByUserId,
    evidenceReferenceCount: assertion.evidenceRefs?.length ?? 0,
    correctionReasonCode: assertion.correctionReasonCode,
    supersedesOutcomeId: assertion.supersedesOutcomeId,
    reviewStatus
  };
}
function publicReview(review) {
  return {
    id: review.id,
    outcomeRecordId: review.outcomeRecordId,
    reviewerUserId: review.reviewerUserId,
    decision: review.decision,
    reviewReasonCode: review.reviewReasonCode,
    reviewedAt: review.reviewedAt,
    eligibleForLearning: review.eligibleForLearning,
    eligibilityReasonCode: review.eligibilityReasonCode,
    supersedesReviewId: review.supersedesReviewId,
    ...review.isCurrent === void 0 ? {} : { isCurrent: review.isCurrent }
  };
}
function publicGrant(grant) {
  return {
    id: grant.id,
    emergencyId: grant.emergencyId,
    granteeUserId: grant.granteeUserId,
    capability: grant.capability,
    grantedByUserId: grant.grantedByUserId,
    createdAt: grant.createdAt,
    revokedAt: grant.revokedAt,
    revokedByUserId: grant.revokedByUserId,
    revokeReason: grant.revokeReason
  };
}

// modules/module_11_database_event_system/src/events/eventService.ts
var EventService = class {
  db;
  bus;
  logger;
  maxPageSize;
  constructor(deps) {
    this.db = deps.db;
    this.bus = deps.bus;
    this.logger = deps.logger ?? noopLogger;
    this.maxPageSize = deps.maxPageSize ?? 500;
    registerCommitSink((records) => this.publishCommitted(records));
  }
  // -- write ------------------------------------------------------------------
  async record(event, context = {}) {
    return guardDatabase(async () => {
      const row = await this.db.systemEvent.create({ data: toCreateData(event, context) });
      const record = mapSystemEvent(row);
      this.afterCommit(record);
      return record;
    }, "Failed to append system event");
  }
  async recordMany(events, context = {}) {
    if (events.length === 0) return [];
    return guardDatabase(async () => {
      const rows = await this.db.$transaction(
        events.map((event) => this.db.systemEvent.create({ data: toCreateData(event, context) }))
      );
      const records = rows.map((row) => mapSystemEvent(row));
      records.forEach((record) => this.afterCommit(record));
      return records;
    }, "Failed to append system events");
  }
  /**
   * Joins the caller's transaction. Nothing is broadcast until the enclosing
   * `withTransaction` commits, so subscribers never observe an event for state
   * that was rolled back.
   *
   * When called outside a transaction the event is broadcast immediately, since
   * there is nothing to wait for.
   */
  async recordInTransaction(db, event) {
    const client = db;
    const row = await client.systemEvent.create({ data: toCreateData(event, {}) });
    const record = mapSystemEvent(row);
    if (currentScope()) {
      bufferRecord(record);
    } else {
      this.afterCommit(record);
    }
    return record;
  }
  /**
   * @deprecated Broadcasting is handled by the transaction scope. This is kept as
   * a no-op so existing call sites keep compiling; the buffer is drained and
   * broadcast by `withTransaction` on commit.
   */
  async flushPending() {
    const scope = currentScope();
    if (scope && scope.records.length > 0) return;
  }
  /**
   * Broadcasts records that a committed transaction buffered. Registered as the
   * scope's commit sink, so it runs only after a successful commit.
   */
  async publishCommitted(records) {
    for (const record of records) {
      this.afterCommit(record);
    }
  }
  // -- read -------------------------------------------------------------------
  async list(filter) {
    return guardDatabase(async () => {
      const where = {
        ...filter.emergencyId ? { emergencyId: filter.emergencyId } : {},
        ...filter.types?.length ? { type: { in: filter.types } } : {},
        ...filter.entityId ? { entityId: filter.entityId } : {},
        ...filter.sinceSequence !== void 0 ? { seq: { gt: filter.sinceSequence } } : {},
        ...filter.since || filter.until ? {
          recordedAt: {
            ...filter.since ? { gte: new Date(filter.since) } : {},
            ...filter.until ? { lte: new Date(filter.until) } : {}
          }
        } : {}
      };
      const limit = Math.min(filter.limit ?? 100, this.maxPageSize);
      const offset = filter.offset ?? 0;
      const [rows, total, latest] = await Promise.all([
        this.db.systemEvent.findMany({ where, orderBy: { seq: "asc" }, take: limit, skip: offset }),
        this.db.systemEvent.count({ where }),
        this.db.systemEvent.aggregate({ _max: { seq: true } })
      ]);
      return {
        items: rows.map((row) => mapSystemEvent(row)),
        total,
        latestSequence: latest._max.seq ?? 0
      };
    }, "Failed to query system events");
  }
  async getById(id) {
    return guardDatabase(async () => {
      const row = await this.db.systemEvent.findUnique({ where: { id } });
      return row ? mapSystemEvent(row) : null;
    }, "Failed to read system event");
  }
  /** Full ordered timeline for one emergency. Never hand-written. */
  async timeline(emergencyId) {
    const result = await this.list({ emergencyId, limit: this.maxPageSize });
    return result.items;
  }
  // -- internals --------------------------------------------------------------
  afterCommit(record) {
    this.bus.publish(record);
  }
};
function toCreateData(event, context) {
  if (!isSystemEventType(event.type)) {
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      `Unknown system event type '${String(event.type)}'.`,
      422
    );
  }
  return {
    id: event.eventId ?? createId("EVT"),
    type: event.type,
    emergencyId: event.emergencyId ?? context.emergencyId ?? null,
    entityType: event.entityType ?? null,
    entityId: event.entityId ?? null,
    payloadJson: JSON.stringify(event.payload ?? {}),
    metadataJson: context.metadata ? JSON.stringify(context.metadata) : null,
    actorType: event.actorType ?? "SYSTEM",
    actorId: event.actorId ?? null
  };
}

// modules/module_11_database_event_system/src/repositories/emergencyRepository.ts
import { createHash } from "node:crypto";
var EmergencyRepository = class {
  constructor(db, events, nodeEnv) {
    this.db = db;
    this.events = events;
    this.nodeEnv = nodeEnv;
  }
  async create(input) {
    if (!isValidCoordinate({ latitude: input.latitude, longitude: input.longitude })) {
      throw AppError.validation("Emergency coordinates are out of range.", {
        latitude: input.latitude,
        longitude: input.longitude
      });
    }
    const incidentType = incidentTypeSchema.parse(input.incidentType);
    const severity = emergencySeveritySchema.parse(input.severity);
    const id = createId("EMG");
    const row = await guardDatabase(
      async () => withTransaction(this.db, async (tx) => {
        const created = await tx.emergency.create({
          data: {
            id,
            incidentType,
            severity,
            status: "CREATED",
            latitude: input.latitude,
            longitude: input.longitude,
            description: input.description ?? null,
            callerId: input.callerId ?? null,
            address: input.address ?? null,
            isSimulation: input.isSimulation ?? false
          }
        });
        await this.events.recordInTransaction(
          tx,
          defineEvent("EMERGENCY_CREATED", {
            emergencyId: id,
            entityType: "emergency",
            entityId: id,
            actorType: input.actor?.actorType ?? "SYSTEM",
            actorId: input.actor?.actorId ?? null,
            payload: {
              incidentType,
              severity,
              latitude: input.latitude,
              longitude: input.longitude,
              description: input.description ?? null,
              isSimulation: input.isSimulation ?? false
            }
          })
        );
        return created;
      }),
      "Failed to create emergency"
    );
    return mapEmergency(row);
  }
  async findById(id) {
    return guardDatabase(async () => {
      const row = await this.db.emergency.findUnique({ where: { id } });
      return row ? mapEmergency(row) : null;
    }, "Failed to read emergency");
  }
  async requireById(id) {
    const emergency = await this.findById(id);
    if (!emergency) throw AppError.notFound("Emergency", id);
    return emergency;
  }
  /**
   * Records an explicit operator attestation in Module 11's append-only event
   * log. No emergency/ambulance status is changed and no operational action is
   * invoked. A stable event ID makes retries idempotent per emergency/milestone.
   */
  async recordLifecycleMilestone(input) {
    const eventId = `M10M-${createHash("sha256").update(`${input.emergencyId}:${input.milestone}`).digest("hex")}`;
    try {
      return await guardDatabase(async () => withTransaction(this.db, async (tx) => {
        const existing = await tx.systemEvent.findUnique({ where: { id: eventId } });
        if (existing) {
          const record2 = mapSystemEvent(existing);
          if (record2.emergencyId !== input.emergencyId || record2.type !== input.milestone) {
            throw new AppError(ErrorCode.CONFLICT, "The lifecycle milestone idempotency key is already in use.", 409);
          }
          return { event: record2, duplicate: true };
        }
        const emergency = await tx.emergency.findUnique({ where: { id: input.emergencyId } });
        if (!emergency) throw AppError.notFound("Emergency", input.emergencyId);
        const related = await tx.systemEvent.findMany({
          where: {
            emergencyId: input.emergencyId,
            type: { in: [
              "AMBULANCE_DISPATCHED",
              "AMBULANCE_ARRIVED_SCENE",
              "PATIENT_ONBOARD",
              "HOSPITAL_SELECTED",
              "AMBULANCE_ARRIVED_HOSPITAL"
            ] }
          },
          orderBy: { seq: "asc" }
        });
        const records = related.map((row) => mapSystemEvent(row));
        const payloadOf = (record2) => record2.payload;
        const ambulanceId = emergency.assignedAmbulanceId;
        if (!ambulanceId) throw new AppError(ErrorCode.CONFLICT, "A currently assigned ambulance is required to record this milestone.", 409);
        const selectedHospitalId = emergency.selectedHospitalId;
        const dispatchRecord = records.find((record2) => record2.type === "AMBULANCE_DISPATCHED" && payloadOf(record2).ambulanceId === ambulanceId);
        const sceneRecord = records.find((record2) => record2.type === "AMBULANCE_ARRIVED_SCENE" && payloadOf(record2).ambulanceId === ambulanceId);
        const onboardRecord = records.find((record2) => record2.type === "PATIENT_ONBOARD" && payloadOf(record2).ambulanceId === ambulanceId);
        const selectedHospitalRecord = records.find((record2) => record2.type === "HOSPITAL_SELECTED" && payloadOf(record2).hospitalId === selectedHospitalId);
        const hospitalArrivalRecord = records.find((record2) => record2.type === "AMBULANCE_ARRIVED_HOSPITAL" && payloadOf(record2).ambulanceId === ambulanceId && payloadOf(record2).hospitalId === selectedHospitalId);
        switch (input.milestone) {
          case "AMBULANCE_ARRIVED_SCENE":
            if (!dispatchRecord) throw new AppError(ErrorCode.CONFLICT, "A persisted dispatch for the currently assigned ambulance is required before scene arrival can be recorded.", 409);
            break;
          case "PATIENT_ONBOARD":
            if (!sceneRecord || !dispatchRecord || sceneRecord.sequence <= dispatchRecord.sequence) {
              throw new AppError(ErrorCode.CONFLICT, "An operator-reported scene arrival after dispatch for the currently assigned ambulance is required before patient onboard can be recorded.", 409);
            }
            break;
          case "AMBULANCE_ARRIVED_HOSPITAL":
            if (!onboardRecord || !sceneRecord || onboardRecord.sequence <= sceneRecord.sequence) {
              throw new AppError(ErrorCode.CONFLICT, "An operator-reported patient onboard milestone after scene arrival is required before hospital arrival can be recorded.", 409);
            }
            if (!selectedHospitalId || !selectedHospitalRecord) throw new AppError(ErrorCode.CONFLICT, "A persisted hospital selection event is required before hospital arrival can be recorded.", 409);
            break;
          case "EMERGENCY_COMPLETED":
            if (!hospitalArrivalRecord || !onboardRecord || hospitalArrivalRecord.sequence <= onboardRecord.sequence) {
              throw new AppError(ErrorCode.CONFLICT, "An operator-reported hospital arrival after patient onboard at the selected hospital is required before operational completion can be recorded.", 409);
            }
            break;
        }
        const observedAt = /* @__PURE__ */ new Date();
        const observedAtIso = observedAt.toISOString();
        const dispatchMs = dispatchRecord ? Date.parse(dispatchRecord.timestamp) : Number.NaN;
        const responseTimeMin = Number.isFinite(dispatchMs) ? Math.max(0, Math.round((observedAt.getTime() - dispatchMs) / 6e4 * 100) / 100) : 0;
        const totalDurationMin = Math.max(0, Math.round((observedAt.getTime() - emergency.createdAt.getTime()) / 6e4 * 100) / 100);
        const dataClassification = emergency.isSimulation ? "SIMULATION" : this.nodeEnv === "test" ? "TEST" : "OPERATIONAL";
        const payload = (() => {
          switch (input.milestone) {
            case "AMBULANCE_ARRIVED_SCENE":
              return { ambulanceId, emergencyId: input.emergencyId, responseTimeMin, evidenceSource: "OPERATOR_REPORTED", observedAt: observedAtIso, dataClassification };
            case "PATIENT_ONBOARD":
              return { ambulanceId, emergencyId: input.emergencyId, hospitalId: selectedHospitalId ?? null, evidenceSource: "OPERATOR_REPORTED", observedAt: observedAtIso, dataClassification };
            case "AMBULANCE_ARRIVED_HOSPITAL":
              return { ambulanceId, emergencyId: input.emergencyId, hospitalId: selectedHospitalId, evidenceSource: "OPERATOR_REPORTED", observedAt: observedAtIso, dataClassification };
            case "EMERGENCY_COMPLETED":
              return { emergencyId: input.emergencyId, totalDurationMin, status: "COMPLETED", isSimulation: emergency.isSimulation, evidenceSource: "OPERATOR_REPORTED", observedAt: observedAtIso, dataClassification };
          }
        })();
        const event = defineEvent(input.milestone, {
          eventId,
          emergencyId: input.emergencyId,
          entityType: "emergency",
          entityId: input.emergencyId,
          actorType: input.actorRole,
          actorId: input.actorId,
          payload
        });
        const record = await this.events.recordInTransaction(tx, event);
        return { event: record, duplicate: false };
      }), "Failed to record lifecycle milestone");
    } catch (error) {
      if (error instanceof AppError && error.statusCode === 409) {
        const existing = await this.events.getById(eventId);
        if (existing?.emergencyId === input.emergencyId && existing.type === input.milestone) {
          return { event: existing, duplicate: true };
        }
      }
      throw error;
    }
  }
  async list(filter = {}) {
    return guardDatabase(async () => {
      const where = {
        ...filter.statuses?.length ? { status: { in: filter.statuses } } : {},
        ...filter.includeSimulation ? {} : { isSimulation: false },
        ...filter.since ? { createdAt: { gte: new Date(filter.since) } } : {}
      };
      const rows = await this.db.emergency.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: Math.min(filter.limit ?? 100, 500),
        skip: filter.offset ?? 0
      });
      return rows.map((row) => mapEmergency(row));
    }, "Failed to list emergencies");
  }
  async active(includeSimulation = false) {
    return this.list({
      statuses: [
        "CREATED",
        "CALL_ACTIVE",
        "CLASSIFIED",
        "PROTOCOL_ACTIVE",
        "AWAITING_AMBULANCE",
        "AMBULANCE_ASSIGNED",
        "EN_ROUTE",
        "ON_SCENE",
        "PATIENT_ONBOARD",
        "TRANSPORTING",
        "AT_HOSPITAL"
      ],
      includeSimulation,
      limit: 200
    });
  }
  /** Field patch with optional co-committed event, inside one transaction. */
  async update(id, patch, event, actor = {}) {
    const data = {};
    const relations = {};
    if (patch.status !== void 0) data.status = emergencyStatusSchema.parse(patch.status);
    if (patch.incidentType !== void 0) data.incidentType = incidentTypeSchema.parse(patch.incidentType);
    if (patch.severity !== void 0) data.severity = emergencySeveritySchema.parse(patch.severity);
    if (patch.description !== void 0) data.description = patch.description;
    if (patch.address !== void 0) data.address = patch.address;
    if (patch.assignedAmbulanceId !== void 0) {
      relations.assignedAmbulance = patch.assignedAmbulanceId ? { connect: { id: patch.assignedAmbulanceId } } : { disconnect: true };
    }
    if (patch.selectedHospitalId !== void 0) {
      relations.selectedHospital = patch.selectedHospitalId ? { connect: { id: patch.selectedHospitalId } } : { disconnect: true };
    }
    return this.mutate(id, data, relations, event, actor);
  }
  async setStatus(id, status, event, actor = {}) {
    const parsed = emergencyStatusSchema.parse(status);
    return this.mutate(id, { status: parsed }, {}, event, actor);
  }
  async mutate(id, data, relations, event, actor) {
    const row = await guardDatabase(
      async () => withTransaction(this.db, async (tx) => {
        const updated = await tx.emergency.update({
          where: { id },
          data: { ...data, ...relations }
        });
        if (event) {
          await this.events.recordInTransaction(
            tx,
            this.toEnvelope(event, id, actor)
          );
        }
        return updated;
      }),
      "Failed to update emergency"
    );
    return mapEmergency(row);
  }
  toEnvelope(event, emergencyId, actor) {
    return defineEvent(event.type, {
      emergencyId,
      entityType: "emergency",
      entityId: emergencyId,
      actorType: actor.actorType ?? "SYSTEM",
      actorId: actor.actorId ?? null,
      payload: event.payload
    });
  }
  async groupedCount(field, includeSimulation) {
    return guardDatabase(async () => {
      const grouped = await this.db.emergency.groupBy({
        by: [field],
        where: includeSimulation ? {} : { isSimulation: false },
        _count: { _all: true }
      });
      return Object.fromEntries(grouped.map((g) => [String(g[field]), g._count._all]));
    }, `Failed to count emergencies by ${field}`);
  }
};

// modules/module_11_database_event_system/src/repositories/ambulanceRepository.ts
var AmbulanceRepository = class {
  constructor(db, events) {
    this.db = db;
    this.events = events;
  }
  async create(input) {
    const hasLat = input.latitude !== void 0 && input.latitude !== null;
    const hasLng = input.longitude !== void 0 && input.longitude !== null;
    if (hasLat !== hasLng) {
      throw AppError.validation("Both latitude and longitude must be supplied for an ambulance.");
    }
    if (hasLat && hasLng && !isValidCoordinate({ latitude: input.latitude, longitude: input.longitude })) {
      throw AppError.validation("Ambulance coordinates are out of range.");
    }
    const id = createId("AMB");
    const row = await guardDatabase(
      async () => withTransaction(this.db, async (tx) => {
        const created = await tx.ambulance.create({
          data: {
            id,
            vehicleNumber: input.vehicleNumber,
            status: input.status ?? "AVAILABLE",
            latitude: input.latitude ?? null,
            longitude: input.longitude ?? null,
            lastLocationUpdate: hasLat ? /* @__PURE__ */ new Date() : null,
            equipmentJson: JSON.stringify(input.equipment ?? []),
            stationName: input.stationName ?? null,
            isSimulation: input.isSimulation ?? false,
            crew: {
              create: (input.crew ?? []).map((member) => ({
                id: createId("CRW"),
                name: member.name,
                role: member.role,
                capabilitiesJson: JSON.stringify(member.capabilities ?? []),
                isOnDuty: member.isOnDuty ?? true
              }))
            }
          },
          include: { crew: true }
        });
        await this.events.recordInTransaction(
          tx,
          defineEvent("AMBULANCE_CREATED", {
            entityType: "ambulance",
            entityId: id,
            payload: {
              ambulanceId: id,
              vehicleNumber: input.vehicleNumber,
              isSimulation: input.isSimulation ?? false
            }
          })
        );
        return created;
      }),
      "Failed to create ambulance"
    );
    return mapAmbulance(row, row.crew ?? []);
  }
  async list(filter = {}) {
    return guardDatabase(async () => {
      const rows = await this.db.ambulance.findMany({
        where: {
          ...filter.includeSimulation ? {} : { isSimulation: false },
          ...filter.statuses?.length ? { status: { in: filter.statuses } } : {}
        },
        orderBy: { vehicleNumber: "asc" },
        include: { crew: true }
      });
      return rows.map((row) => mapAmbulance(row, row.crew ?? []));
    }, "Failed to list ambulances");
  }
  async findById(id) {
    return guardDatabase(async () => {
      const row = await this.db.ambulance.findUnique({ where: { id }, include: { crew: true } });
      return row ? mapAmbulance(row, row.crew ?? []) : null;
    }, "Failed to read ambulance");
  }
  async requireById(id) {
    const ambulance = await this.findById(id);
    if (!ambulance) throw new AppError(ErrorCode.AMBULANCE_NOT_FOUND, `Ambulance '${id}' was not found.`, 404);
    return ambulance;
  }
  async findByAssignedDriverId(driverId) {
    return guardDatabase(async () => {
      const row = await this.db.ambulance.findFirst({
        where: { assignedDriverId: driverId },
        include: { crew: true }
      });
      return row ? mapAmbulance(row, row.crew ?? []) : null;
    }, "Failed to read ambulance by driver");
  }
  async getAssignedAmbulanceForDriver(driverId) {
    return this.findByAssignedDriverId(driverId);
  }
  async update(id, patch) {
    const data = {};
    if (patch.status !== void 0) data.status = patch.status;
    if (patch.latitude !== void 0) data.latitude = patch.latitude;
    if (patch.longitude !== void 0) data.longitude = patch.longitude;
    if (patch.lastLocationUpdate !== void 0) data.lastLocationUpdate = patch.lastLocationUpdate;
    if (patch.stationName !== void 0) data.stationName = patch.stationName;
    if (patch.equipment !== void 0) data.equipmentJson = JSON.stringify(patch.equipment);
    if (patch.assignedAt !== void 0) data.assignedAt = patch.assignedAt;
    if (patch.availableAt !== void 0) data.availableAt = patch.availableAt;
    if (patch.currentEmergencyId !== void 0) {
      data.currentEmergency = patch.currentEmergencyId ? { connect: { id: patch.currentEmergencyId } } : { disconnect: true };
    }
    const row = await guardDatabase(
      async () => this.db.ambulance.update({ where: { id }, data, include: { crew: true } }),
      "Failed to update ambulance"
    );
    return mapAmbulance(row, row.crew ?? []);
  }
  /**
   * Soft delete. Ambulances are never hard-deleted: the event log and the GPS
   * trail reference them, so a unit is retired to UNAVAILABLE instead.
   */
  async retire(id) {
    const row = await guardDatabase(
      async () => this.db.ambulance.update({
        where: { id },
        data: { status: "UNAVAILABLE", currentEmergency: { disconnect: true } },
        include: { crew: true }
      }),
      "Failed to retire ambulance"
    );
    return mapAmbulance(row, row.crew ?? []);
  }
  /** Appends to the GPS trail and updates the cached position in one write. */
  async appendLocation(input) {
    if (!isValidCoordinate({ latitude: input.latitude, longitude: input.longitude })) {
      throw AppError.validation("Reported coordinates are out of range.", {
        latitude: input.latitude,
        longitude: input.longitude
      });
    }
    const id = createId("LOC");
    const recordedAt = input.recordedAt ?? /* @__PURE__ */ new Date();
    const isSimulation = input.isSimulation ?? false;
    await guardDatabase(
      async () => withTransaction(this.db, async (tx) => {
        await tx.ambulanceLocation.create({
          data: {
            id,
            ambulanceId: input.ambulanceId,
            latitude: input.latitude,
            longitude: input.longitude,
            speedKmh: input.speedKmh ?? null,
            headingDeg: input.headingDeg ?? null,
            accuracyM: input.accuracyM ?? null,
            source: input.source ?? "GPS",
            isSimulation,
            recordedAt
          }
        });
        await tx.ambulance.update({
          where: { id: input.ambulanceId },
          data: { latitude: input.latitude, longitude: input.longitude, lastLocationUpdate: recordedAt }
        });
        if (!isSimulation) {
          await this.events.recordInTransaction(
            tx,
            defineEvent("AMBULANCE_LOCATION_UPDATED", {
              entityType: "ambulance",
              entityId: input.ambulanceId,
              payload: {
                ambulanceId: input.ambulanceId,
                latitude: input.latitude,
                longitude: input.longitude,
                speedKmh: input.speedKmh ?? null,
                headingDeg: input.headingDeg ?? null,
                recordedAt: recordedAt.toISOString(),
                isSimulation: false
              }
            })
          );
        }
        return id;
      }),
      "Failed to record ambulance location"
    );
    return {
      id,
      ambulanceId: input.ambulanceId,
      latitude: input.latitude,
      longitude: input.longitude,
      speedKmh: input.speedKmh ?? null,
      headingDeg: input.headingDeg ?? null,
      accuracyM: input.accuracyM ?? null,
      recordedAt: recordedAt.toISOString(),
      source: input.source ?? "GPS",
      isSimulation
    };
  }
  async latestLocation(ambulanceId) {
    return guardDatabase(async () => {
      const row = await this.db.ambulanceLocation.findFirst({
        where: { ambulanceId },
        orderBy: { recordedAt: "desc" }
      });
      return row ? mapAmbulanceLocation(row) : null;
    }, "Failed to read latest location");
  }
  async locationTrail(ambulanceId, limit = 200) {
    return guardDatabase(async () => {
      const rows = await this.db.ambulanceLocation.findMany({
        where: { ambulanceId },
        orderBy: { recordedAt: "desc" },
        take: Math.min(limit, 1e3)
      });
      return rows.map((row) => mapAmbulanceLocation(row));
    }, "Failed to read location trail");
  }
  async createAssignment(input) {
    const id = createId("ASG");
    const row = await guardDatabase(
      async () => withTransaction(this.db, async (tx) => {
        const existingForEmergency = await tx.ambulanceAssignment.findFirst({
          where: { emergencyId: input.emergencyId, status: { in: ["ASSIGNED", "ACCEPTED", "DISPATCHED"] } }
        });
        if (existingForEmergency) {
          throw new AppError(ErrorCode.CONFLICT, `Emergency ${input.emergencyId} already has an active ambulance assignment`, 409);
        }
        const ambulance = await tx.ambulance.findUnique({ where: { id: input.ambulanceId } });
        if (!ambulance) throw new AppError(ErrorCode.AMBULANCE_NOT_FOUND, `Ambulance '${input.ambulanceId}' was not found.`, 404);
        if (ambulance.status !== "AVAILABLE" && input.source !== "MANUAL_OVERRIDE") {
          throw new AppError(ErrorCode.AMBULANCE_NOT_AVAILABLE, `Ambulance ${input.ambulanceId} is not available`, 409);
        }
        const active = await tx.ambulanceAssignment.findFirst({
          where: { ambulanceId: input.ambulanceId, status: { in: ["ASSIGNED", "ACCEPTED", "DISPATCHED"] } }
        });
        if (active) throw new AppError(ErrorCode.CONFLICT, `Ambulance ${input.ambulanceId} already has active assignment`, 409);
        const created = await tx.ambulanceAssignment.create({
          data: {
            id,
            emergencyId: input.emergencyId,
            ambulanceId: input.ambulanceId,
            status: "ASSIGNED",
            source: input.source,
            distanceKm: input.distanceKm,
            estimatedResponseTimeMin: input.estimatedResponseTimeMin,
            score: input.score,
            matchingFactorsJson: JSON.stringify(input.matchingFactors),
            rejectedReasonsJson: JSON.stringify(input.rejectedReasons),
            overrideReason: input.overrideReason ?? null,
            consideredCandidates: input.consideredCandidates,
            decidedByUserId: input.decidedByUserId ?? null
          }
        });
        await tx.ambulance.update({
          where: { id: input.ambulanceId },
          data: { status: "ASSIGNED", currentEmergencyId: input.emergencyId, assignedAt: /* @__PURE__ */ new Date() }
        });
        await tx.emergency.update({ where: { id: input.emergencyId }, data: { assignedAmbulanceId: input.ambulanceId } });
        const actorType = input.decidedByUserId ? "OPERATOR" : "MODULE";
        await this.events.recordInTransaction(tx, defineEvent("AMBULANCE_ASSIGNMENT_REQUESTED", {
          emergencyId: input.emergencyId,
          entityType: "ambulance",
          entityId: input.ambulanceId,
          actorType,
          actorId: input.decidedByUserId ?? null,
          payload: {
            emergencyId: input.emergencyId,
            candidatesEvaluated: input.consideredCandidates,
            requiredEquipment: [],
            requiredCapabilities: []
          }
        }));
        await this.events.recordInTransaction(tx, defineEvent("AMBULANCE_ASSIGNED", {
          emergencyId: input.emergencyId,
          entityType: "ambulance",
          entityId: input.ambulanceId,
          actorType,
          actorId: input.decidedByUserId ?? null,
          payload: {
            ambulanceId: input.ambulanceId,
            assignmentId: id,
            emergencyId: input.emergencyId,
            distanceKm: input.distanceKm,
            estimatedResponseTimeMin: input.estimatedResponseTimeMin,
            matchingFactors: input.matchingFactors,
            score: input.score,
            source: input.source,
            overrideReason: input.overrideReason ?? null,
            consideredCandidates: input.consideredCandidates
          }
        }));
        return created;
      }),
      "Failed to persist ambulance assignment"
    );
    return mapAssignment(row);
  }
  async activeAssignmentForDriver(driverId) {
    return guardDatabase(async () => {
      const row = await this.db.ambulanceAssignment.findFirst({
        where: {
          ambulance: { assignedDriverId: driverId },
          status: { in: ["ASSIGNED", "ACCEPTED", "DISPATCHED"] }
        },
        orderBy: { createdAt: "desc" },
        include: { ambulance: { include: { crew: true } } }
      });
      if (!row) return null;
      return {
        assignment: mapAssignment(row),
        ambulance: mapAmbulance(row.ambulance, row.ambulance.crew)
      };
    }, "Failed to read driver assignment");
  }
  async respondToAssignment(input) {
    const decidedAt = /* @__PURE__ */ new Date();
    const row = await guardDatabase(async () => withTransaction(this.db, async (tx) => {
      const current = await tx.ambulanceAssignment.findUnique({
        where: { id: input.assignmentId },
        include: { ambulance: true }
      });
      if (!current) throw AppError.notFound("Assignment", input.assignmentId);
      if (current.ambulance.assignedDriverId !== input.driverId) {
        throw new AppError(ErrorCode.FORBIDDEN, "This assignment does not belong to the authenticated driver.", 403);
      }
      if (current.status !== "ASSIGNED" || current.ambulance.status !== "ASSIGNED") {
        throw new AppError(ErrorCode.CONFLICT, "Only a pending, undispatched assignment can be accepted or declined.", 409);
      }
      const nextStatus = input.decision === "ACCEPT" ? "ACCEPTED" : "DECLINED";
      const changed = await tx.ambulanceAssignment.updateMany({
        where: { id: input.assignmentId, ambulanceId: current.ambulanceId, status: "ASSIGNED" },
        data: { status: nextStatus, ...input.decision === "DECLINE" ? { releasedAt: decidedAt } : {} }
      });
      if (changed.count !== 1) throw new AppError(ErrorCode.CONFLICT, "Assignment was already answered.", 409);
      if (input.decision === "DECLINE") {
        await tx.ambulance.update({
          where: { id: current.ambulanceId },
          data: { status: "AVAILABLE", currentEmergencyId: null, availableAt: decidedAt }
        });
        await tx.emergency.updateMany({
          where: { id: current.emergencyId, assignedAmbulanceId: current.ambulanceId },
          data: { assignedAmbulanceId: null }
        });
      }
      const event = input.decision === "ACCEPT" ? defineEvent("AMBULANCE_ASSIGNMENT_ACCEPTED", {
        emergencyId: current.emergencyId,
        entityType: "ambulance_assignment",
        entityId: current.id,
        actorType: "AMBULANCE",
        actorId: input.driverId,
        payload: { assignmentId: current.id, ambulanceId: current.ambulanceId, emergencyId: current.emergencyId, acceptedAt: decidedAt.toISOString() }
      }) : defineEvent("AMBULANCE_ASSIGNMENT_DECLINED", {
        emergencyId: current.emergencyId,
        entityType: "ambulance_assignment",
        entityId: current.id,
        actorType: "AMBULANCE",
        actorId: input.driverId,
        payload: { assignmentId: current.id, ambulanceId: current.ambulanceId, emergencyId: current.emergencyId, declinedAt: decidedAt.toISOString(), reason: input.reason ?? null }
      });
      await this.events.recordInTransaction(tx, event);
      return tx.ambulanceAssignment.findUniqueOrThrow({ where: { id: current.id } });
    }), "Failed to record driver assignment response");
    return mapAssignment(row);
  }
  async dispatchAssignment(input) {
    await guardDatabase(async () => withTransaction(this.db, async (tx) => {
      const ambulance = await tx.ambulance.findUnique({ where: { id: input.ambulanceId } });
      if (!ambulance) throw new AppError(ErrorCode.AMBULANCE_NOT_FOUND, `Ambulance '${input.ambulanceId}' was not found.`, 404);
      const assignment = await tx.ambulanceAssignment.findFirst({
        where: { ambulanceId: input.ambulanceId, emergencyId: input.emergencyId, status: { in: ["ASSIGNED", "ACCEPTED"] } }
      });
      if (!assignment) {
        const alreadyDispatched = await tx.ambulanceAssignment.findFirst({
          where: { ambulanceId: input.ambulanceId, emergencyId: input.emergencyId, status: "DISPATCHED" }
        });
        if (alreadyDispatched && ambulance.status === "EN_ROUTE") return;
        throw new AppError(ErrorCode.CONFLICT, "A pending or accepted assignment is required before dispatch.", 409);
      }
      if (ambulance.status !== "ASSIGNED") {
        throw new AppError(ErrorCode.CONFLICT, "Ambulance is not in an assigned state and cannot be dispatched.", 409);
      }
      const changed = await tx.ambulanceAssignment.updateMany({
        where: { id: assignment.id, status: { in: ["ASSIGNED", "ACCEPTED"] } },
        data: { status: "DISPATCHED" }
      });
      if (changed.count !== 1) throw new AppError(ErrorCode.CONFLICT, "Assignment changed before dispatch.", 409);
      await tx.ambulance.update({ where: { id: input.ambulanceId }, data: { status: "EN_ROUTE" } });
      await this.events.recordInTransaction(tx, defineEvent("AMBULANCE_DISPATCHED", {
        emergencyId: input.emergencyId,
        entityType: "ambulance",
        entityId: input.ambulanceId,
        actorType: "OPERATOR",
        actorId: input.dispatchedByUserId ?? null,
        payload: { ambulanceId: input.ambulanceId, emergencyId: input.emergencyId }
      }));
      await this.events.recordInTransaction(tx, defineEvent("AMBULANCE_STATUS_CHANGED", {
        entityType: "ambulance",
        entityId: input.ambulanceId,
        actorType: "OPERATOR",
        actorId: input.dispatchedByUserId ?? null,
        payload: { ambulanceId: input.ambulanceId, from: ambulance.status, to: "EN_ROUTE" }
      }));
    }), "Failed to dispatch ambulance");
  }
  async assignmentsForEmergency(emergencyId) {
    return guardDatabase(async () => {
      const rows = await this.db.ambulanceAssignment.findMany({
        where: { emergencyId },
        orderBy: { decidedAt: "asc" }
      });
      return rows.map((row) => mapAssignment(row));
    }, "Failed to read assignments");
  }
  async activeAssignmentFor(ambulanceId) {
    return guardDatabase(async () => {
      const row = await this.db.ambulanceAssignment.findFirst({
        where: { ambulanceId, status: { in: ["ASSIGNED", "ACCEPTED", "DISPATCHED"] } },
        orderBy: { decidedAt: "desc" }
      });
      return row ? mapAssignment(row) : null;
    }, "Failed to read active assignment");
  }
  async releaseAssignments(ambulanceId) {
    return guardDatabase(
      async () => this.db.ambulanceAssignment.updateMany({
        where: { ambulanceId, status: { in: ["ASSIGNED", "ACCEPTED", "DISPATCHED"] } },
        data: { status: "CANCELLED", releasedAt: /* @__PURE__ */ new Date() }
      }).then((result) => result.count),
      "Failed to release assignments"
    );
  }
  /**
   * Fleet utilisation derived from real rows: how many assignments each unit
   * received and how long it has spent reporting position since the fleet was
   * populated. Never invented.
   */
  async utilization(includeSimulation) {
    return guardDatabase(async () => {
      const rows = await this.db.ambulance.findMany({
        where: includeSimulation ? {} : { isSimulation: false },
        include: {
          assignments: { where: { status: { not: "CANCELLED" } }, select: { id: true } },
          locations: { orderBy: { recordedAt: "asc" }, select: { recordedAt: true } }
        }
      });
      return rows.map((a) => ({
        ambulanceId: a.id,
        vehicleNumber: a.vehicleNumber,
        status: a.status,
        assignmentCount: a.assignments.length,
        isSimulation: a.isSimulation,
        minutesInField: a.locations.length >= 2 ? Math.round(
          (a.locations[a.locations.length - 1].recordedAt.getTime() - a.locations[0].recordedAt.getTime()) / 6e4
        ) : 0
      }));
    }, "Failed to compute ambulance utilisation");
  }
  async countByStatus(includeSimulation) {
    return guardDatabase(async () => {
      const grouped = await this.db.ambulance.groupBy({
        by: ["status"],
        where: includeSimulation ? {} : { isSimulation: false },
        _count: { _all: true }
      });
      return Object.fromEntries(grouped.map((g) => [g.status, g._count._all]));
    }, "Failed to count ambulances by status");
  }
  async equipmentCodes() {
    const rows = await this.db.ambulance.findMany({ select: { id: true, equipmentJson: true } });
    return rows.map((r) => ({ ambulanceId: r.id, equipment: parseStringArray(r.equipmentJson) }));
  }
};

// modules/module_11_database_event_system/src/repositories/hospitalRepository.ts
var HospitalRepository = class {
  constructor(db, events) {
    this.db = db;
    this.events = events;
  }
  async list(filter = {}) {
    return guardDatabase(async () => {
      const rows = await this.db.hospital.findMany({
        where: filter.includeSimulation ? {} : { isSimulation: false },
        orderBy: { name: "asc" }
      });
      return rows.map((row) => mapHospital(row));
    }, "Failed to list hospitals");
  }
  /**
   * Hospitals together with their resource rows, in one query.
   *
   * Module 7 scores suitability against live bed/specialist/equipment counts, so
   * it needs the hospital and its `HospitalResource` rows together. Read-only:
   * this never writes availability.
   */
  async listWithResources(filter = {}) {
    return guardDatabase(async () => {
      const rows = await this.db.hospital.findMany({
        where: filter.includeSimulation ? {} : { isSimulation: false },
        include: { resources: true },
        orderBy: { name: "asc" }
      });
      return rows.map((row) => {
        const record = row;
        const resources = Array.isArray(record.resources) ? record.resources : [];
        return {
          ...mapHospital(record),
          resources: resources.map(
            (resource) => mapHospitalResource(resource)
          )
        };
      });
    }, "Failed to list hospitals with resources");
  }
  async findById(id) {
    return guardDatabase(async () => {
      const row = await this.db.hospital.findUnique({ where: { id } });
      return row ? mapHospital(row) : null;
    }, "Failed to read hospital");
  }
  async requireById(id) {
    const hospital = await this.findById(id);
    if (!hospital) throw AppError.notFound("Hospital", id);
    return hospital;
  }
  async setStatus(id, status) {
    const row = await guardDatabase(
      async () => this.db.hospital.update({
        where: { id },
        data: { status, acceptingEmergencies: status === "OPEN" }
      }),
      "Failed to update hospital status"
    );
    return mapHospital(row);
  }
  /**
   * Updates one existing resource row and records `HOSPITAL_RESOURCE_UPDATED`
   * in the same transaction. The row must already exist (seeded or created by
   * an approved path): this never fabricates capacity for an unknown
   * hospital/resource pair, and the event commits only with the write.
   */
  async updateResourceAvailability(input) {
    if (!HOSPITAL_RESOURCE_TYPES.includes(input.resourceType)) {
      throw AppError.validation(`Unknown hospital resource type '${input.resourceType}'.`);
    }
    if (!Number.isInteger(input.total) || input.total < 0) {
      throw AppError.validation("Resource total must be a non-negative integer.");
    }
    if (!Number.isInteger(input.available) || input.available < 0) {
      throw AppError.validation("Resource available must be a non-negative integer.");
    }
    if (input.available > input.total) {
      throw AppError.validation("Resource available cannot exceed total.");
    }
    const code = input.code ?? "";
    const row = await guardDatabase(
      async () => withTransaction(this.db, async (tx) => {
        const existing = await tx.hospitalResource.findUnique({
          where: {
            hospitalId_resourceType_code: {
              hospitalId: input.hospitalId,
              resourceType: input.resourceType,
              code
            }
          }
        });
        if (!existing) {
          throw AppError.notFound(
            "Hospital resource",
            `${input.hospitalId}/${input.resourceType}/${code || "default"}`
          );
        }
        const updated = await tx.hospitalResource.update({
          where: {
            hospitalId_resourceType_code: {
              hospitalId: input.hospitalId,
              resourceType: input.resourceType,
              code
            }
          },
          data: { total: input.total, available: input.available }
        });
        if (this.events) {
          await this.events.recordInTransaction(
            tx,
            defineEvent("HOSPITAL_RESOURCE_UPDATED", {
              entityType: "hospital",
              entityId: input.hospitalId,
              actorType: input.actor?.actorType ?? "OPERATOR",
              actorId: input.actor?.actorId ?? null,
              payload: {
                hospitalId: input.hospitalId,
                resourceType: input.resourceType,
                code,
                total: input.total,
                available: input.available
              }
            })
          );
        }
        return updated;
      }),
      "Failed to update hospital resource"
    );
    return mapHospitalResource(row);
  }
  async countByStatus(includeSimulation) {
    return guardDatabase(async () => {
      const grouped = await this.db.hospital.groupBy({
        by: ["status"],
        where: includeSimulation ? {} : { isSimulation: false },
        _count: { _all: true }
      });
      return Object.fromEntries(grouped.map((g) => [g.status, g._count._all]));
    }, "Failed to count hospitals by status");
  }
};

// modules/module_11_database_event_system/src/repositories/callRepository.ts
var CallRepository = class {
  constructor(db, events) {
    this.db = db;
    this.events = events;
  }
  async startSession(input) {
    const id = input.id ?? createId("CALL");
    const row = await guardDatabase(
      async () => withTransaction(this.db, async (tx) => {
        const created = await tx.callSession.create({
          data: {
            id,
            emergencyId: input.emergencyId,
            channel: input.channel ?? "VOICE",
            callerId: input.callerId ?? null,
            language: input.language ?? "en",
            isSimulation: input.isSimulation ?? false
          }
        });
        await this.events.recordInTransaction(
          tx,
          defineEvent("CALL_STARTED", {
            emergencyId: input.emergencyId,
            entityType: "call_session",
            entityId: id,
            payload: {
              callSessionId: id,
              channel: input.channel ?? "VOICE",
              callerId: input.callerId ?? null
            }
          })
        );
        return created;
      }),
      "Failed to start call session"
    );
    return toCallSession(row);
  }
  async appendTranscript(input) {
    const id = createId("TRN");
    const row = await guardDatabase(
      async () => withTransaction(this.db, async (tx) => {
        const last = await tx.transcript.findFirst({
          where: { callSessionId: input.callSessionId },
          orderBy: { sequence: "desc" },
          select: { sequence: true }
        });
        const sequence = (last?.sequence ?? 0) + 1;
        const created = await tx.transcript.create({
          data: {
            id,
            callSessionId: input.callSessionId,
            emergencyId: input.emergencyId,
            sequence,
            speaker: input.speaker,
            text: input.text,
            isFinal: input.isFinal ?? true,
            intent: input.intent ?? null,
            confidence: input.confidence ?? null,
            isSimulation: input.isSimulation ?? false
          }
        });
        await this.events.recordInTransaction(
          tx,
          defineEvent("TRANSCRIPT_UPDATED", {
            emergencyId: input.emergencyId,
            entityType: "transcript",
            entityId: id,
            payload: {
              transcriptId: id,
              speaker: input.speaker,
              text: input.text,
              isFinal: input.isFinal ?? true,
              sequence
            }
          })
        );
        return created;
      }),
      "Failed to append transcript"
    );
    return toTranscript(row);
  }
  async transcriptsFor(emergencyId) {
    return guardDatabase(async () => {
      const rows = await this.db.transcript.findMany({
        where: { emergencyId },
        orderBy: { sequence: "asc" }
      });
      return rows.map((row) => toTranscript(row));
    }, "Failed to list transcripts");
  }
  async sessionById(id) {
    return guardDatabase(async () => {
      const row = await this.db.callSession.findUnique({ where: { id } });
      return row ? toCallSession(row) : null;
    }, "Failed to read call session");
  }
  async requireSessionFor(emergencyId) {
    const row = await this.db.callSession.findFirst({
      where: { emergencyId },
      orderBy: { startedAt: "desc" }
    });
    if (!row) throw AppError.notFound("Call session for emergency", emergencyId);
    return toCallSession(row);
  }
  /**
   * Sessions still marked ACTIVE, oldest first.
   *
   * Scoped by status rather than by `endedAt` because a row can reach ACTIVE
   * without an end time when a process dies between the two writes; the status
   * column is the one that is always updated.
   */
  async activeSessions() {
    return guardDatabase(async () => {
      const rows = await this.db.callSession.findMany({
        where: { status: "ACTIVE" },
        orderBy: { startedAt: "asc" }
      });
      return rows.map((row) => toCallSession(row));
    }, "Failed to list active call sessions");
  }
  async endSession(id) {
    return guardDatabase(async () => {
      const row = await this.db.callSession.update({
        where: { id },
        data: { status: "ENDED", endedAt: /* @__PURE__ */ new Date() }
      });
      return toCallSession(row);
    }, "Failed to end call session");
  }
};
function toCallSession(row) {
  return {
    id: String(row.id),
    emergencyId: String(row.emergencyId),
    channel: String(row.channel),
    callerId: row.callerId ?? null,
    status: String(row.status),
    language: String(row.language),
    startedAt: new Date(row.startedAt).toISOString(),
    endedAt: row.endedAt ? new Date(row.endedAt).toISOString() : null,
    isSimulation: Boolean(row.isSimulation)
  };
}
function toTranscript(row) {
  return {
    id: String(row.id),
    callSessionId: String(row.callSessionId),
    emergencyId: String(row.emergencyId),
    sequence: Number(row.sequence),
    speaker: String(row.speaker),
    text: String(row.text),
    isFinal: Boolean(row.isFinal),
    intent: row.intent ?? null,
    confidence: row.confidence == null ? null : Number(row.confidence),
    recordedAt: new Date(row.recordedAt).toISOString(),
    isSimulation: Boolean(row.isSimulation)
  };
}
function routeCreateData(id, input) {
  return {
    id,
    emergencyId: input.emergencyId,
    ambulanceId: input.ambulanceId,
    hospitalId: input.hospitalId ?? null,
    originName: input.originName ?? "INCIDENT",
    destinationName: input.destinationName,
    originLat: input.origin.latitude,
    originLng: input.origin.longitude,
    destLat: input.destination.latitude,
    destLng: input.destination.longitude,
    distanceKm: input.distanceKm,
    polylineJson: JSON.stringify(input.polyline ?? []),
    estimatedMinutes: input.estimatedMinutes ?? null,
    isSimulation: input.isSimulation ?? false,
    provider: input.provider ?? "mock",
    isLiveTraffic: input.isLiveTraffic ?? false,
    trafficFactor: input.trafficFactor ?? null,
    alternativesJson: JSON.stringify(input.alternatives ?? []),
    selectionReasonJson: JSON.stringify(input.selectionReason ?? {})
  };
}
var RouteRepository = class {
  constructor(db, events) {
    this.db = db;
    this.events = events;
  }
  async createRoute(input) {
    if (!isValidCoordinate(input.origin) || !isValidCoordinate(input.destination)) {
      throw AppError.validation("Route endpoints are out of range.");
    }
    const id = createId("RTE");
    const row = await guardDatabase(
      async () => this.db.route.create({
        data: routeCreateData(id, input)
      }),
      "Failed to create route"
    );
    return toRoute(row);
  }
  /** Route row and its success event commit or roll back as one unit. */
  async createRouteWithEvent(input, eventFor) {
    if (!isValidCoordinate(input.origin) || !isValidCoordinate(input.destination)) {
      throw AppError.validation("Route endpoints are out of range.");
    }
    const id = createId("RTE");
    return guardDatabase(
      async () => withTransaction(this.db, async (tx) => {
        const row = await tx.route.create({ data: routeCreateData(id, input) });
        const route = toRoute(row);
        await this.events.recordInTransaction(tx, eventFor(route));
        return route;
      }),
      "Failed to create route and event"
    );
  }
  async updateProgress(input) {
    const clamped = Math.max(0, Math.min(100, input.progressPct));
    const row = await guardDatabase(
      async () => withTransaction(this.db, async (tx) => {
        const route = await tx.route.update({
          where: { id: input.routeId },
          data: { progressPct: clamped, status: clamped >= 100 ? "COMPLETED" : "ACTIVE" }
        });
        await tx.routeUpdate.create({
          data: {
            id: createId("RTU"),
            routeId: input.routeId,
            progressPct: clamped,
            positionLat: input.positionLat ?? null,
            positionLng: input.positionLng ?? null,
            remainingKm: input.remainingKm ?? null,
            note: input.note ?? null
          }
        });
        await this.events.recordInTransaction(
          tx,
          defineEvent("ROUTE_UPDATED", {
            emergencyId: input.emergencyId,
            entityType: "route",
            entityId: input.routeId,
            payload: { routeId: input.routeId, emergencyId: input.emergencyId, progressPct: clamped }
          })
        );
        return route;
      }),
      "Failed to update route progress"
    );
    return toRoute(row);
  }
  /**
   * Replaces an established route's geometry/ETA in place and records the
   * recalculation event in the same transaction. Route identity (id, emergency,
   * ambulance, hospital, leg labels) is preserved; only provider output fields
   * change and `recalculationCount` increments. The event commits only with
   * the replacement write.
   */
  async replaceRouteWithEvent(routeId, update, eventFor) {
    return guardDatabase(
      async () => withTransaction(this.db, async (tx) => {
        const current = await tx.route.findUnique({ where: { id: routeId } });
        if (!current) throw AppError.notFound("Route", routeId);
        const previous = {
          distanceKm: Number(current.distanceKm),
          estimatedMinutes: current.estimatedMinutes == null ? null : Number(current.estimatedMinutes)
        };
        const data = {
          distanceKm: update.distanceKm,
          recalculationCount: { increment: 1 }
        };
        if (update.polyline !== void 0) data.polylineJson = JSON.stringify(update.polyline);
        if (update.estimatedMinutes !== void 0) data.estimatedMinutes = update.estimatedMinutes;
        if (update.provider !== void 0) data.provider = update.provider;
        if (update.isLiveTraffic !== void 0) data.isLiveTraffic = update.isLiveTraffic;
        if (update.trafficFactor !== void 0) data.trafficFactor = update.trafficFactor;
        if (update.alternatives !== void 0) {
          data.alternativesJson = JSON.stringify(update.alternatives);
        }
        if (update.selectionReason !== void 0) {
          data.selectionReasonJson = JSON.stringify(update.selectionReason ?? {});
        }
        const updated = await tx.route.update({ where: { id: routeId }, data });
        const route = toRoute(updated);
        await this.events.recordInTransaction(
          tx,
          eventFor(route, previous)
        );
        return route;
      }),
      "Failed to replace route"
    );
  }
  async routesForEmergency(emergencyId) {
    return guardDatabase(async () => {
      const rows = await this.db.route.findMany({
        where: { emergencyId },
        orderBy: { createdAt: "asc" }
      });
      return rows.map((row) => toRoute(row));
    }, "Failed to list routes");
  }
  async findById(id) {
    return guardDatabase(async () => {
      const row = await this.db.route.findUnique({ where: { id } });
      return row ? toRoute(row) : null;
    }, "Failed to read route");
  }
  async requireById(id) {
    const route = await this.findById(id);
    if (!route) throw AppError.notFound("Route", id);
    return route;
  }
  /**
   * Activates (or re-activates) the emergency corridor.
   *
   * Idempotent: when an `ACTIVE` corridor already exists for the emergency, no
   * write and **no event** occur, so a retried or duplicated activation cannot
   * append a second `CORRIDOR_ACTIVATED`. The row and its event are written in
   * one transaction, so a failed write can never emit a success event.
   */
  async activateCorridor(input) {
    const geofenceJson = JSON.stringify(
      (input.geofence ?? []).map((point) => [point.latitude, point.longitude])
    );
    const roadUsersJson = JSON.stringify(input.roadUsers ?? []);
    const signalsJson = JSON.stringify(input.signals ?? []);
    const priorityMode = input.priorityMode ?? "SIMULATED";
    const radiusM = input.radiusM ?? 150;
    return guardDatabase(
      async () => withTransaction(this.db, async (tx) => {
        const existing = await tx.corridor.findUnique({
          where: { emergencyId: input.emergencyId }
        });
        if (existing && existing.isActive && existing.status === "ACTIVE") {
          return { id: existing.id, status: existing.status, isActive: true, activated: false };
        }
        const now = /* @__PURE__ */ new Date();
        const data = {
          ambulanceId: input.ambulanceId,
          hospitalId: input.hospitalId,
          fromLabel: input.fromLabel,
          toLabel: input.toLabel,
          estimatedMinutes: input.estimatedMinutes,
          isActive: true,
          status: "ACTIVE",
          priorityMode,
          radiusM,
          geofenceJson,
          roadUsersJson,
          signalsJson,
          isSimulation: input.isSimulation ?? false,
          activatedAt: now,
          releasedAt: null
        };
        const row = existing ? await tx.corridor.update({ where: { emergencyId: input.emergencyId }, data }) : await tx.corridor.create({
          data: { id: createId("COR"), emergencyId: input.emergencyId, ...data }
        });
        await this.events.recordInTransaction(
          tx,
          defineEvent("CORRIDOR_ACTIVATED", {
            emergencyId: input.emergencyId,
            entityType: "corridor",
            entityId: row.id,
            payload: {
              emergencyId: input.emergencyId,
              ambulanceId: input.ambulanceId,
              hospitalId: input.hospitalId,
              from: input.fromLabel,
              to: input.toLabel,
              estimatedMinutes: input.estimatedMinutes
            }
          })
        );
        return { id: row.id, status: "ACTIVE", isActive: true, activated: true };
      }),
      "Failed to activate corridor"
    );
  }
  /**
   * Releases the emergency corridor.
   *
   * Idempotent: releasing when no corridor is active is a no-op that emits no
   * event. The state change and its `CORRIDOR_RELEASED` event share a
   * transaction, so a rolled-back release cannot announce itself.
   */
  async releaseCorridor(emergencyId, reason = "RELEASED") {
    return guardDatabase(
      async () => withTransaction(this.db, async (tx) => {
        const existing = await tx.corridor.findUnique({ where: { emergencyId } });
        if (!existing || !existing.isActive) return { released: false };
        const now = /* @__PURE__ */ new Date();
        const durationMs2 = Math.max(0, now.getTime() - existing.activatedAt.getTime());
        await tx.corridor.update({
          where: { emergencyId },
          data: { isActive: false, status: "RELEASED", releasedAt: now }
        });
        await this.events.recordInTransaction(
          tx,
          defineEvent("CORRIDOR_RELEASED", {
            emergencyId,
            entityType: "corridor",
            entityId: existing.id,
            payload: { corridorId: existing.id, emergencyId, durationMs: durationMs2, reason }
          })
        );
        return { released: true };
      }),
      "Failed to release corridor"
    );
  }
  /** Full persisted corridor state for an emergency, or null. */
  async getCorridor(emergencyId) {
    return guardDatabase(async () => {
      const row = await this.db.corridor.findUnique({ where: { emergencyId } });
      return row ? toCorridor(row) : null;
    }, "Failed to read corridor");
  }
  async activeCorridorFor(emergencyId) {
    return guardDatabase(async () => {
      const row = await this.db.corridor.findUnique({ where: { emergencyId } });
      if (!row || !row.isActive) return null;
      return { id: row.id, estimatedMinutes: row.estimatedMinutes };
    }, "Failed to read corridor");
  }
};
function toRoute(row) {
  return {
    id: String(row.id),
    emergencyId: String(row.emergencyId),
    ambulanceId: String(row.ambulanceId),
    hospitalId: row.hospitalId ?? null,
    originName: String(row.originName),
    destinationName: String(row.destinationName),
    originLat: Number(row.originLat),
    originLng: Number(row.originLng),
    destLat: Number(row.destLat),
    destLng: Number(row.destLng),
    distanceKm: Number(row.distanceKm),
    polyline: JSON.parse(String(row.polylineJson ?? "[]")),
    progressPct: Number(row.progressPct),
    status: String(row.status),
    estimatedMinutes: row.estimatedMinutes == null ? null : Number(row.estimatedMinutes),
    isSimulation: Boolean(row.isSimulation),
    provider: String(row.provider ?? "mock"),
    isLiveTraffic: Boolean(row.isLiveTraffic),
    trafficFactor: row.trafficFactor == null ? null : Number(row.trafficFactor),
    alternatives: parseJsonArray(row.alternativesJson),
    selectionReason: parseJsonObject(row.selectionReasonJson),
    recalculationCount: Number(row.recalculationCount ?? 0)
  };
}
function toCorridor(row) {
  return {
    id: String(row.id),
    emergencyId: String(row.emergencyId),
    ambulanceId: String(row.ambulanceId),
    hospitalId: String(row.hospitalId),
    fromLabel: String(row.fromLabel),
    toLabel: String(row.toLabel),
    estimatedMinutes: Number(row.estimatedMinutes),
    isActive: Boolean(row.isActive),
    activatedAt: new Date(row.activatedAt).toISOString(),
    releasedAt: row.releasedAt == null ? null : new Date(row.releasedAt).toISOString(),
    isSimulation: Boolean(row.isSimulation),
    status: String(row.status),
    priorityMode: String(row.priorityMode),
    radiusM: Number(row.radiusM),
    geofence: parseJsonArray(row.geofenceJson),
    roadUsers: parseJsonArray(row.roadUsersJson),
    signals: parseJsonArray(row.signalsJson),
    renegotiationCount: Number(row.renegotiationCount ?? 0)
  };
}
function parseJsonArray(value) {
  if (value == null) return [];
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function parseJsonObject(value) {
  if (value == null) return null;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// modules/module_11_database_event_system/src/repositories/notificationRepository.ts
import { createHash as createHash2 } from "node:crypto";
var NotificationRepository = class {
  constructor(db, events) {
    this.db = db;
    this.events = events;
  }
  async create(input) {
    return guardDatabase(
      async () => withTransaction(this.db, async (tx) => {
        const id = createId("NTF");
        const row = await tx.notification.create({
          data: {
            id,
            emergencyId: input.emergencyId,
            corridorId: input.corridorId ?? null,
            channel: input.channel,
            audience: input.audience,
            status: input.status,
            provider: input.provider,
            delivered: input.delivered,
            body: input.body,
            latitude: input.latitude ?? null,
            longitude: input.longitude ?? null,
            failureReason: input.failureReason ?? null
          }
        });
        await this.events.recordInTransaction(
          tx,
          defineEvent("NOTIFICATION_SENT", {
            emergencyId: input.emergencyId,
            entityType: "notification",
            entityId: id,
            payload: {
              notificationId: id,
              emergencyId: input.emergencyId,
              channel: input.channel,
              audience: input.audience,
              status: input.status,
              provider: input.provider,
              delivered: input.delivered
            }
          })
        );
        return toNotification(row);
      }),
      "Failed to record notification"
    );
  }
  async listForEmergency(emergencyId) {
    return guardDatabase(async () => {
      const rows = await this.db.notification.findMany({
        where: { emergencyId },
        orderBy: { createdAt: "asc" }
      });
      return rows.map((row) => toNotification(row));
    }, "Failed to list notifications");
  }
  /** Persists a local mock-control-room notice. No provider or network call is made. */
  async createPoliceRouteNotification(input) {
    const id = `NTF-${createHash2("sha256").update(`${input.emergencyId}:${input.routeId}:MOCK_POLICE_CONTROL_ROOM`).digest("hex").slice(0, 24).toUpperCase()}`;
    try {
      return await guardDatabase(async () => withTransaction(this.db, async (tx) => {
        const existing = await tx.notification.findUnique({ where: { id } });
        if (existing) {
          const details = parsePoliceBody(existing.body);
          if (details?.routeId !== input.routeId || details?.simulation !== true || details?.recipient !== "MOCK_POLICE_CONTROL_ROOM") {
            throw new AppError(ErrorCode.CONFLICT, "A deterministic notification id is already associated with different route details.", 409);
          }
          return toNotification(existing);
        }
        const previous = await tx.notification.findMany({
          where: { emergencyId: input.emergencyId, audience: "MOCK_POLICE_CONTROL_ROOM", provider: "MOCK_POLICE_CONTROL_ROOM", status: "SIMULATED_SENT" },
          orderBy: { createdAt: "asc" }
        });
        const supersededAt = /* @__PURE__ */ new Date();
        for (const candidate of previous) {
          const details = parsePoliceBody(candidate.body);
          if (details?.routeId === input.routeId) continue;
          const changed = await tx.notification.updateMany({
            where: { id: candidate.id, status: "SIMULATED_SENT" },
            data: { status: "SUPERSEDED" }
          });
          if (changed.count === 1) {
            await this.events.recordInTransaction(tx, defineEvent("SIMULATED_POLICE_NOTIFICATION_SUPERSEDED", {
              emergencyId: input.emergencyId,
              entityType: "notification",
              entityId: candidate.id,
              actorType: "MODULE",
              payload: {
                notificationId: candidate.id,
                emergencyId: input.emergencyId,
                supersededByNotificationId: id,
                supersededAt: supersededAt.toISOString(),
                simulation: true
              }
            }));
          }
        }
        const createdAt = /* @__PURE__ */ new Date();
        const body = JSON.stringify({
          version: 1,
          emergencyId: input.emergencyId,
          ambulanceId: input.ambulanceId,
          routeId: input.routeId,
          provider: input.provider,
          isLiveTraffic: input.isLiveTraffic,
          routeIsSimulation: input.routeIsSimulation,
          estimatedMinutes: input.estimatedMinutes,
          geometry: input.geometry,
          createdAt: createdAt.toISOString(),
          simulation: true,
          recipient: "MOCK_POLICE_CONTROL_ROOM",
          delivered: false
        });
        const row = await tx.notification.create({
          data: {
            id,
            emergencyId: input.emergencyId,
            channel: "IN_APP",
            audience: "MOCK_POLICE_CONTROL_ROOM",
            status: "SIMULATED_SENT",
            provider: "MOCK_POLICE_CONTROL_ROOM",
            delivered: false,
            body,
            createdAt
          }
        });
        await this.events.recordInTransaction(tx, defineEvent("SIMULATED_POLICE_NOTIFICATION_CREATED", {
          emergencyId: input.emergencyId,
          entityType: "notification",
          entityId: id,
          actorType: "OPERATOR",
          actorId: input.createdByUserId,
          payload: {
            notificationId: id,
            emergencyId: input.emergencyId,
            ambulanceId: input.ambulanceId,
            routeId: input.routeId,
            provider: "MOCK_POLICE_CONTROL_ROOM",
            createdAt: createdAt.toISOString(),
            routeIsSimulation: input.routeIsSimulation,
            simulation: true,
            delivered: false
          }
        }));
        return toNotification(row);
      }), "Failed to persist simulated police notification");
    } catch (error) {
      const existing = await this.findById(id);
      const details = existing ? parsePoliceBody(existing.body) : null;
      if (existing && details?.routeId === input.routeId && details.simulation === true && details.recipient === "MOCK_POLICE_CONTROL_ROOM") return existing;
      throw error;
    }
  }
  async acknowledgePoliceRouteNotification(input) {
    return guardDatabase(async () => withTransaction(this.db, async (tx) => {
      const current = await tx.notification.findUnique({ where: { id: input.notificationId } });
      if (!current || current.emergencyId !== input.emergencyId || current.audience !== "MOCK_POLICE_CONTROL_ROOM" || current.provider !== "MOCK_POLICE_CONTROL_ROOM") {
        throw AppError.notFound("Simulated police notification", input.notificationId);
      }
      if (current.status !== "SIMULATED_SENT") {
        throw new AppError(ErrorCode.CONFLICT, "Only a pending simulated notification can be acknowledged.", 409);
      }
      const details = parsePoliceBody(current.body);
      if (details?.simulation !== true || details.recipient !== "MOCK_POLICE_CONTROL_ROOM" || typeof details.routeId !== "string") {
        throw new AppError(ErrorCode.CONFLICT, "Notification is not a recognized simulated control-room request.", 409);
      }
      const acknowledgedAt = /* @__PURE__ */ new Date();
      const updated = await tx.notification.updateMany({
        where: { id: input.notificationId, status: "SIMULATED_SENT" },
        data: { status: "ACKNOWLEDGED_SIMULATED" }
      });
      if (updated.count !== 1) throw new AppError(ErrorCode.CONFLICT, "Notification status changed before acknowledgement.", 409);
      await this.events.recordInTransaction(tx, defineEvent("SIMULATED_POLICE_NOTIFICATION_ACKNOWLEDGED", {
        emergencyId: input.emergencyId,
        entityType: "notification",
        entityId: input.notificationId,
        actorType: "OPERATOR",
        actorId: input.acknowledgedByUserId,
        payload: {
          notificationId: input.notificationId,
          emergencyId: input.emergencyId,
          routeId: details.routeId,
          acknowledgedByUserId: input.acknowledgedByUserId,
          acknowledgedAt: acknowledgedAt.toISOString(),
          simulation: true
        }
      }));
      const row = await tx.notification.findUniqueOrThrow({ where: { id: input.notificationId } });
      return toNotification(row);
    }), "Failed to acknowledge simulated police notification");
  }
  async findById(id) {
    return guardDatabase(async () => {
      const row = await this.db.notification.findUnique({ where: { id } });
      return row ? toNotification(row) : null;
    }, "Failed to read notification");
  }
};
function parsePoliceBody(body) {
  try {
    const value = JSON.parse(body);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}
function toNotification(row) {
  return {
    id: String(row.id),
    emergencyId: String(row.emergencyId),
    corridorId: row.corridorId ?? null,
    channel: String(row.channel),
    audience: String(row.audience),
    status: String(row.status),
    provider: String(row.provider),
    delivered: Boolean(row.delivered),
    body: String(row.body),
    latitude: row.latitude == null ? null : Number(row.latitude),
    longitude: row.longitude == null ? null : Number(row.longitude),
    failureReason: row.failureReason ?? null,
    createdAt: new Date(row.createdAt).toISOString(),
    sentAt: row.sentAt == null ? null : new Date(row.sentAt).toISOString()
  };
}

// modules/module_11_database_event_system/src/repositories/userRepository.ts
var UserRepository = class {
  constructor(db) {
    this.db = db;
  }
  async create(input) {
    const id = createId("USR");
    const row = await guardDatabase(
      async () => this.db.user.create({
        data: {
          id,
          email: input.email.toLowerCase(),
          displayName: input.displayName,
          passwordHash: input.passwordHash,
          role: userRoleSchema.parse(input.role ?? "OPERATOR")
        }
      }),
      "Failed to create user"
    );
    return row;
  }
  async findByEmail(email) {
    return guardDatabase(async () => {
      const row = await this.db.user.findUnique({ where: { email: email.toLowerCase() } });
      return row ?? null;
    }, "Failed to read user");
  }
  async findById(id) {
    return guardDatabase(async () => {
      const row = await this.db.user.findUnique({ where: { id } });
      if (!row) return null;
      const { passwordHash: _ignored, ...rest } = row;
      return rest;
    }, "Failed to read user");
  }
  async list() {
    return guardDatabase(async () => {
      const rows = await this.db.user.findMany({ orderBy: { createdAt: "asc" } });
      return rows.map((row) => {
        const { passwordHash: _ignored, ...rest } = row;
        return rest;
      });
    }, "Failed to list users");
  }
  async requireById(id) {
    const user = await this.findById(id);
    if (!user) throw AppError.notFound("User", id);
    return user;
  }
};

// modules/module_11_database_event_system/src/repositories/analyticsRepository.ts
var EVENT_MARKERS = {
  created: null,
  classified: "EMERGENCY_CLASSIFIED",
  protocolStarted: "PROTOCOL_STARTED",
  assigned: "AMBULANCE_ASSIGNED",
  dispatched: "AMBULANCE_DISPATCHED",
  arrivedScene: "AMBULANCE_ARRIVED_SCENE",
  onboard: "PATIENT_ONBOARD",
  hospitalSelected: "HOSPITAL_SELECTED",
  arrivedHospital: "AMBULANCE_ARRIVED_HOSPITAL",
  completed: "EMERGENCY_COMPLETED"
};
var diffMin = (from, to) => {
  if (!from || !to) return null;
  const value = (Date.parse(to) - Date.parse(from)) / 6e4;
  return value < 0 ? null : Math.round(value * 100) / 100;
};
var AnalyticsReadRepository = class {
  constructor(db) {
    this.db = db;
  }
  /**
   * Recomputes timing intervals from the append-only event log. This is the
   * only place response/dispatch/transport times come from — nothing is stored
   * twice and nothing is estimated unless the log is incomplete.
   */
  async emergencyDurations(windowDays, includeSimulation) {
    return guardDatabase(async () => {
      const since = new Date(Date.now() - windowDays * 864e5);
      const rows = await this.db.emergency.findMany({
        where: {
          createdAt: { gte: since },
          ...includeSimulation ? {} : { isSimulation: false }
        },
        orderBy: { createdAt: "desc" },
        take: 1e3,
        select: {
          id: true,
          createdAt: true,
          updatedAt: true,
          status: true,
          incidentType: true,
          severity: true,
          isSimulation: true,
          assignedAmbulanceId: true,
          selectedHospitalId: true,
          systemEvents: {
            orderBy: { seq: "asc" },
            select: { type: true, recordedAt: true, payloadJson: true }
          },
          protocolSessions: { select: { protocolId: true, escalationRequired: true }, take: 1 }
        }
      });
      return rows.map((row) => {
        const marks = {};
        for (const event of row.systemEvents) {
          const key = Object.keys(EVENT_MARKERS).find(
            (candidate) => EVENT_MARKERS[candidate] === event.type
          );
          if (key && marks[key] === void 0) marks[key] = event.recordedAt.toISOString();
        }
        const createdAt = row.createdAt.toISOString();
        const assigned = marks.assigned ?? null;
        const onboard = marks.onboard ?? null;
        const arrivedHospital = marks.arrivedHospital ?? null;
        const completedAt = marks.completed ?? (row.status === "COMPLETED" ? row.updatedAt.toISOString() : null);
        return {
          emergencyId: row.id,
          createdAt,
          completedAt,
          status: row.status,
          incidentType: row.incidentType,
          severity: row.severity,
          isSimulation: row.isSimulation,
          responseTimeMin: diffMin(assigned, marks.arrivedScene ?? null),
          dispatchTimeMin: diffMin(assigned, marks.dispatched ?? null),
          ambulanceTravelMin: diffMin(marks.dispatched ?? null, marks.arrivedScene ?? null),
          transportTimeMin: diffMin(onboard, arrivedHospital),
          totalDurationMin: diffMin(createdAt, arrivedHospital ?? completedAt),
          hospitalId: row.selectedHospitalId,
          ambulanceId: row.assignedAmbulanceId,
          protocolId: row.protocolSessions[0]?.protocolId ?? null,
          escalationRequired: row.protocolSessions[0]?.escalationRequired ?? false
        };
      });
    }, "Failed to derive emergency durations");
  }
  async liveState(includeSimulation) {
    return guardDatabase(async () => {
      const [emergencyRows, ambulanceRows, corridorRows] = await Promise.all([
        this.db.emergency.findMany({
          where: {
            isSimulation: includeSimulation ? void 0 : false,
            status: { notIn: ["COMPLETED", "CANCELLED"] }
          },
          orderBy: { createdAt: "asc" },
          take: 200,
          select: {
            id: true,
            status: true,
            incidentType: true,
            severity: true,
            latitude: true,
            longitude: true,
            createdAt: true,
            assignedAmbulanceId: true,
            selectedHospitalId: true,
            isSimulation: true
          }
        }),
        this.db.ambulance.findMany({
          where: includeSimulation ? void 0 : { isSimulation: false },
          orderBy: { vehicleNumber: "asc" },
          select: {
            id: true,
            vehicleNumber: true,
            status: true,
            latitude: true,
            longitude: true,
            lastLocationUpdate: true,
            currentEmergencyId: true,
            isSimulation: true,
            equipmentJson: true,
            _count: { select: { crew: true } }
          }
        }),
        this.db.corridor.findMany({
          where: { isActive: true, ...includeSimulation ? {} : { isSimulation: false } },
          select: {
            id: true,
            emergencyId: true,
            ambulanceId: true,
            hospitalId: true,
            fromLabel: true,
            toLabel: true,
            estimatedMinutes: true,
            activatedAt: true,
            isSimulation: true
          }
        })
      ]);
      return {
        emergencies: emergencyRows.map((row) => ({
          id: row.id,
          status: row.status,
          incidentType: row.incidentType,
          severity: row.severity,
          latitude: row.latitude,
          longitude: row.longitude,
          createdAt: row.createdAt.toISOString(),
          assignedAmbulanceId: row.assignedAmbulanceId,
          selectedHospitalId: row.selectedHospitalId,
          isSimulation: row.isSimulation
        })),
        ambulances: ambulanceRows.map((row) => ({
          id: row.id,
          vehicleNumber: row.vehicleNumber,
          status: row.status,
          latitude: row.latitude,
          longitude: row.longitude,
          lastLocationUpdate: row.lastLocationUpdate?.toISOString() ?? null,
          currentEmergencyId: row.currentEmergencyId,
          isSimulation: row.isSimulation,
          crewCount: row._count.crew,
          equipment: parseJsonColumn(row.equipmentJson, [])
        })),
        corridors: corridorRows.map((row) => ({
          id: row.id,
          emergencyId: row.emergencyId,
          ambulanceId: row.ambulanceId,
          hospitalId: row.hospitalId,
          fromLabel: row.fromLabel,
          toLabel: row.toLabel,
          estimatedMinutes: row.estimatedMinutes,
          activatedAt: row.activatedAt.toISOString(),
          isSimulation: row.isSimulation
        }))
      };
    }, "Failed to read live state");
  }
  async eventBreakdown(windowDays, includeSimulation) {
    return guardDatabase(async () => {
      const since = new Date(Date.now() - windowDays * 864e5);
      const rows = await this.db.systemEvent.findMany({
        where: { recordedAt: { gte: since } },
        orderBy: { recordedAt: "desc" },
        take: 5e3,
        select: { type: true, recordedAt: true, emergencyId: true }
      });
      const emergencyIds = new Set(rows.map((r) => r.emergencyId).filter((id) => Boolean(id)));
      const simulationEmergencies = /* @__PURE__ */ new Set();
      if (!includeSimulation && emergencyIds.size > 0) {
        const sims = await this.db.emergency.findMany({
          where: { id: { in: [...emergencyIds] }, isSimulation: true },
          select: { id: true }
        });
        sims.forEach((s) => simulationEmergencies.add(s.id));
      }
      const counts = /* @__PURE__ */ new Map();
      for (const row of rows) {
        if (row.emergencyId && simulationEmergencies.has(row.emergencyId)) continue;
        const entry = counts.get(row.type);
        const at = row.recordedAt.toISOString();
        if (entry) {
          entry.count += 1;
          if (at > entry.latestAt) entry.latestAt = at;
        } else {
          counts.set(row.type, { count: 1, latestAt: at });
        }
      }
      return [...counts.entries()].map(([type, value]) => ({ type, ...value })).sort((a, b) => b.count - a.count);
    }, "Failed to aggregate event breakdown");
  }
  async learningSamples(options) {
    return guardDatabase(async () => {
      const since = new Date(Date.now() - options.windowDays * 864e5);
      const rows = await this.db.learningSample.findMany({
        where: {
          recordedAt: { gte: since },
          ...options.includeSimulation ? {} : { emergency: { isSimulation: false } }
        },
        orderBy: { recordedAt: "desc" },
        take: 2e3,
        select: {
          emergencyId: true,
          outcomeAssertionId: true,
          emergencyType: true,
          severity: true,
          responseTimeMin: true,
          dispatchTimeMin: true,
          ambulanceDistanceKm: true,
          hospitalDistanceKm: true,
          protocolUsed: true,
          protocolVersion: true,
          escalationRequired: true,
          routeDurationMin: true,
          transportTimeMin: true,
          totalDurationMin: true,
          outcomeStatus: true,
          survivalToDischarge: true,
          featuresJson: true,
          provenance: true,
          recordedAt: true,
          emergency: {
            select: {
              isSimulation: true,
              outcomeAssertions: {
                where: { successor: null },
                include: { reviews: { where: { successor: null } } }
              }
            }
          }
        }
      });
      const eligibleRows = rows.filter((row) => {
        if (row.emergency.isSimulation) return options.includeSimulation && row.provenance === "SIMULATION";
        if (row.provenance !== "REAL_OBSERVED") return false;
        const currentAssertions = row.emergency.outcomeAssertions;
        if (currentAssertions.length !== 1) return false;
        const assertion = currentAssertions[0];
        const currentReview = assertion?.reviews[0];
        return Boolean(assertion && row.outcomeAssertionId === assertion.id && currentReview && assertion.dataClassification === "OPERATIONAL" && assertion.provenance === "REAL_OBSERVED" && assertion.category === row.outcomeStatus && assertion.survivalToDischarge === row.survivalToDischarge && currentReview.decision === "APPROVED" && currentReview.eligibleForLearning);
      });
      return eligibleRows.map((row) => ({
        emergencyId: row.emergencyId,
        emergencyType: row.emergencyType,
        severity: row.severity,
        responseTimeMin: row.responseTimeMin,
        dispatchTimeMin: row.dispatchTimeMin,
        ambulanceDistanceKm: row.ambulanceDistanceKm,
        hospitalDistanceKm: row.hospitalDistanceKm,
        protocolUsed: row.protocolUsed,
        protocolVersion: row.protocolVersion,
        escalationRequired: row.escalationRequired,
        routeDurationMin: row.routeDurationMin,
        transportTimeMin: row.transportTimeMin,
        totalDurationMin: row.totalDurationMin,
        outcomeStatus: row.outcomeStatus,
        survivalToDischarge: row.survivalToDischarge,
        features: parseRecord(row.featuresJson),
        provenance: row.provenance,
        recordedAt: row.recordedAt.toISOString(),
        isSimulation: row.emergency.isSimulation
      }));
    }, "Failed to read learning samples");
  }
  async insertLearningSample(input) {
    await guardDatabase(
      async () => withTransaction(this.db, async (tx) => {
        const emergency = await tx.emergency.findUnique({
          where: { id: input.emergencyId },
          select: { isSimulation: true }
        });
        if (!emergency) throw AppError.validation("Learning sample emergency was not found.");
        if (emergency.isSimulation ? input.provenance !== "SIMULATION" : input.provenance !== "REAL_OBSERVED") {
          throw AppError.validation("Learning sample provenance must match the persisted emergency simulation classification.");
        }
        let outcomeAssertionId = null;
        if (input.provenance === "REAL_OBSERVED") {
          const currentAssertions = await tx.outcomeAssertion.findMany({
            where: { emergencyId: input.emergencyId, successor: null },
            include: { reviews: { where: { successor: null } } }
          });
          if (currentAssertions.length !== 1) {
            throw AppError.validation("A real learning sample requires exactly one current, reviewed outcome assertion.");
          }
          const assertion = currentAssertions[0];
          if (!assertion) throw AppError.validation("A real learning sample requires one eligible current outcome.");
          const review = assertion.reviews[0];
          if (assertion.dataClassification !== "OPERATIONAL" || assertion.provenance !== "REAL_OBSERVED" || assertion.category !== input.outcomeStatus || assertion.survivalToDischarge !== (input.survivalToDischarge ?? null) || !review || review.decision !== "APPROVED" || !review.eligibleForLearning) {
            throw AppError.validation("Only the matching approved operational outcome may become a real learning sample.");
          }
          outcomeAssertionId = assertion.id;
        }
        await tx.learningSample.upsert({
          where: { emergencyId: input.emergencyId },
          // Both branches must name the mapped columns explicitly. Spreading
          // `input` here passed `features`, which is not a column on the model
          // (it is `featuresJson`), so every first-time insert failed with
          // "Unknown argument `features`" and only the update path ever worked.
          create: {
            id: `LS-${input.emergencyId}`,
            emergencyId: input.emergencyId,
            outcomeAssertionId,
            hospitalId: input.hospitalId ?? null,
            emergencyType: input.emergencyType,
            severity: input.severity,
            responseTimeMin: input.responseTimeMin ?? null,
            dispatchTimeMin: input.dispatchTimeMin ?? null,
            ambulanceDistanceKm: input.ambulanceDistanceKm ?? null,
            hospitalDistanceKm: input.hospitalDistanceKm ?? null,
            protocolUsed: input.protocolUsed ?? null,
            protocolVersion: input.protocolVersion ?? null,
            escalationRequired: input.escalationRequired,
            routeDurationMin: input.routeDurationMin ?? null,
            transportTimeMin: input.transportTimeMin ?? null,
            totalDurationMin: input.totalDurationMin ?? null,
            outcomeStatus: input.outcomeStatus,
            survivalToDischarge: input.survivalToDischarge ?? null,
            featuresJson: JSON.stringify(input.features),
            provenance: input.provenance,
            recordedAt: /* @__PURE__ */ new Date()
          },
          update: {
            outcomeAssertionId,
            emergencyType: input.emergencyType,
            severity: input.severity,
            responseTimeMin: input.responseTimeMin ?? null,
            dispatchTimeMin: input.dispatchTimeMin ?? null,
            ambulanceDistanceKm: input.ambulanceDistanceKm ?? null,
            hospitalDistanceKm: input.hospitalDistanceKm ?? null,
            protocolUsed: input.protocolUsed ?? null,
            protocolVersion: input.protocolVersion ?? null,
            escalationRequired: input.escalationRequired,
            routeDurationMin: input.routeDurationMin ?? null,
            transportTimeMin: input.transportTimeMin ?? null,
            totalDurationMin: input.totalDurationMin ?? null,
            outcomeStatus: input.outcomeStatus,
            survivalToDischarge: input.survivalToDischarge ?? null,
            featuresJson: JSON.stringify(input.features),
            provenance: input.provenance,
            recordedAt: /* @__PURE__ */ new Date()
          }
        });
      }),
      "Failed to store learning sample"
    );
  }
  async modelVersions(limit = 10) {
    return guardDatabase(
      async () => this.db.learningModelVersion.findMany({
        orderBy: { version: "desc" },
        take: limit
      }),
      "Failed to read model versions"
    );
  }
  async insertModelVersion(input) {
    await guardDatabase(
      async () => {
        const existing = await this.db.learningModelVersion.findUnique({ where: { version: input.version } });
        if (existing) return;
        await this.db.learningModelVersion.create({
          data: {
            id: `LMV-${input.version}`,
            version: input.version,
            samples: input.samples,
            priorAlpha: input.priorAlpha,
            priorBeta: input.priorBeta,
            posteriorJson: JSON.stringify(input.posterior),
            strataJson: JSON.stringify(input.strata),
            method: input.method,
            note: input.note ?? null
          }
        });
      },
      "Failed to store model version"
    );
  }
  async saveSnapshot(input) {
    const id = `SNP-${Date.now()}`;
    await guardDatabase(
      async () => {
        await this.db.analyticsSnapshot.create({
          data: {
            id,
            windowDays: input.windowDays,
            metricsJson: JSON.stringify(input.metrics),
            sampleSize: input.sampleSize
          }
        });
      },
      "Failed to store analytics snapshot"
    );
    return id;
  }
  async snapshotSeries(days) {
    return guardDatabase(
      async () => this.db.analyticsSnapshot.findMany({
        where: { computedAt: { gte: new Date(Date.now() - days * 864e5) } },
        orderBy: { computedAt: "asc" },
        take: 200
      }),
      "Failed to read snapshot series"
    );
  }
};

// modules/module_11_database_event_system/src/module.ts
function createModule11(options) {
  const logger2 = options.logger ?? createConsoleLogger("info", "module_11");
  const db = options.db;
  const bus = new DomainEventBus({ realtime: options.realtime, logger: logger2 });
  const events = new EventService({ db, bus, logger: logger2 });
  const module = {
    db,
    database: db,
    bus,
    events,
    eventPublisher: events,
    eventQuery: events,
    emergencies: new EmergencyRepository(db, events, options.nodeEnv),
    ambulances: new AmbulanceRepository(db, events),
    hospitals: new HospitalRepository(db, events),
    protocols: new ProtocolRepository(db, events, logger2),
    decisions: new DecisionRepository(db),
    outcomes: new OutcomeRepository(db, events),
    calls: new CallRepository(db, events),
    routes: new RouteRepository(db, events),
    notifications: new NotificationRepository(db, events),
    users: new UserRepository(db),
    analyticsRead: new AnalyticsReadRepository(db),
    routeDefinitions: () => createModule11Routes(module, { nodeEnv: options.nodeEnv }),
    dispose: async () => {
      if (options.ownsClient !== false) await db.$disconnect();
    }
  };
  return module;
}

// modules/module_01_emergency_call/src/config.ts
import "dotenv/config";
var LANGUAGES = ["en", "ml"];
function parseHostPort(value, variable) {
  const match = /^(?<host>[^:\s]+):(?<port>\d{1,5})$/.exec(value.trim());
  const host = match?.groups?.host;
  const port = match?.groups?.port ? Number(match.groups.port) : NaN;
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${variable} must be in host:port form, received '${value}'.`);
  }
  return { host, port };
}
function loadModule1Config() {
  const provider = readEnum("TRANSPORT_PROVIDER", ["loopback", "asterisk", "sip", "webrtc"], "loopback");
  const signallingUrl = readOptionalString("TRANSPORT_SIGNALLING_URL") ?? "";
  if (provider !== "loopback" && !signallingUrl) {
    throw new Error(
      `TRANSPORT_PROVIDER="${provider}" requires TRANSPORT_SIGNALLING_URL to be set. This repository ships no SIP or WebRTC signalling stack; set TRANSPORT_PROVIDER=loopback for local development, or point TRANSPORT_SIGNALLING_URL at your own signalling service.`
    );
  }
  const base = {
    provider,
    signallingUrl,
    defaultTransport: provider === "sip" ? "SIP" : provider === "webrtc" ? "WEBRTC" : provider === "asterisk" ? "SIP" : "LOOPBACK",
    defaultLanguage: readString("CALL_DEFAULT_LANGUAGE", "en"),
    supportedLanguages: LANGUAGES,
    maxCallDurationMinutes: readNumber("CALL_MAX_DURATION_MINUTES", 30),
    timeoutMs: readNumber("CALL_PROVIDER_TIMEOUT_MS", 1e4)
  };
  if (provider !== "asterisk") {
    return { telephony: base };
  }
  return {
    telephony: {
      ...base,
      asterisk: loadAsteriskConfig(signallingUrl, base.timeoutMs)
    }
  };
}
function loadAsteriskConfig(signallingUrl, providerTimeoutMs) {
  const { host, port } = parseHostPort(signallingUrl, "TRANSPORT_SIGNALLING_URL");
  const secret = readOptionalString("ASTERISK_AMI_SECRET");
  if (!secret) {
    throw new Error(
      'TRANSPORT_PROVIDER="asterisk" requires ASTERISK_AMI_SECRET. Create a manager account in `/etc/asterisk/manager.conf` and set the same secret here.'
    );
  }
  const latitude = readNumber("ASTERISK_INBOUND_LAT", Number.NaN);
  const longitude = readNumber("ASTERISK_INBOUND_LNG", Number.NaN);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new Error(
      'TRANSPORT_PROVIDER="asterisk" requires ASTERISK_INBOUND_LAT and ASTERISK_INBOUND_LNG. An inbound call carries no location; the emergency is opened at these service-area coordinates and flagged for the operator to confirm.'
    );
  }
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    throw new Error(
      `ASTERISK_INBOUND_LAT/ASTERISK_INBOUND_LNG are out of range: received ${latitude}, ${longitude}.`
    );
  }
  return {
    ami: {
      host,
      port,
      username: readString("ASTERISK_AMI_USERNAME", "resus"),
      secret,
      connectTimeoutMs: readNumber("ASTERISK_AMI_CONNECT_TIMEOUT_MS", 5e3),
      actionTimeoutMs: readNumber("ASTERISK_AMI_ACTION_TIMEOUT_MS", providerTimeoutMs)
    },
    audioSocket: {
      bindHost: readString("ASTERISK_AUDIOSOCKET_BIND_HOST", "0.0.0.0"),
      bindPort: readNumber("ASTERISK_AUDIOSOCKET_BIND_PORT", 9092),
      advertiseHost: readString("ASTERISK_AUDIOSOCKET_ADVERTISE_HOST", "127.0.0.1")
    },
    dialplan: {
      context: readString("ASTERISK_DIALPLAN_CONTEXT", "resus"),
      exten: readString("ASTERISK_DIALPLAN_EXTEN", "s"),
      priority: readNumber("ASTERISK_DIALPLAN_PRIORITY", 1)
    },
    defaultEndpoint: readString("ASTERISK_DEFAULT_ENDPOINT", "PJSIP/1001"),
    inbound: {
      uuidVariable: readString("ASTERISK_INBOUND_UUID_VARIABLE", "RESUS_INBOUND_UUID"),
      extension: readString("ASTERISK_INBOUND_EXTEN", "1000"),
      language: readString("CALL_DEFAULT_LANGUAGE", "en"),
      latitude,
      longitude
    }
  };
}

// modules/module_01_emergency_call/src/callService.ts
var CallService = class {
  constructor(deps) {
    this.deps = deps;
    this.logger = deps.logger ?? noopLogger;
  }
  logger;
  syntheticTimingMarkerSink = null;
  /** Installed only by the live Asterisk runtime; simulation and ACTIVE checks remain mandatory. */
  setSyntheticTimingMarkerSink(sink) {
    this.syntheticTimingMarkerSink = sink;
  }
  async markSyntheticSpeechTiming(callSessionId, marker) {
    const session = await this.deps.calls.sessionById(callSessionId);
    if (!session || session.status !== "ACTIVE" || !session.isSimulation) {
      throw AppError.notFound("Active synthetic call", callSessionId);
    }
    if (!this.syntheticTimingMarkerSink) throw AppError.notFound("Synthetic AudioSocket timing diagnostics");
    return this.syntheticTimingMarkerSink(callSessionId, marker);
  }
  /**
   * Opens a call.
   *
   * The emergency is created first (when not supplied) because a call session
   * must belong to one: `CallSession.emergencyId` is mandatory, and a session
   * without an emergency would be a transcript nothing can be attached to during
   * an incident review.
   */
  async open(input) {
    const language = normaliseLanguage(input.language ?? this.deps.config.telephony.defaultLanguage);
    if (input.emergencyId) {
      const emergency2 = await this.deps.emergencies.requireById(input.emergencyId);
      const active = await this.activeSession(emergency2.id);
      if (active) {
        this.logger.debug(
          { emergencyId: emergency2.id, callSessionId: active.id },
          "reusing already-active call session"
        );
        return {
          emergency: emergency2,
          session: active,
          isLiveTransport: this.deps.telephony.isLive,
          provider: this.deps.telephony.providerName,
          transport: active.channel,
          reused: true
        };
      }
      return this.startFor(emergency2, input, language);
    }
    if (input.latitude === void 0 || input.longitude === void 0) {
      throw AppError.validation(
        "A new emergency needs a latitude and longitude. Pass `emergencyId` to attach the call to an emergency that already has a location."
      );
    }
    const emergency = await this.deps.emergencies.create({
      incidentType: input.incidentType ?? "OTHER",
      severity: input.severity ?? "MEDIUM",
      latitude: input.latitude,
      longitude: input.longitude,
      description: input.description ?? null,
      callerId: input.callerId ?? null,
      isSimulation: input.isSimulation ?? false,
      actor: input.actor
    });
    return this.startFor(emergency, input, language);
  }
  async startFor(emergency, input, language) {
    const handle = await this.originate(input);
    const session = await this.deps.calls.startSession({
      // The transport's own id for this call leg, so a later `hangup()` can
      // address the correct channel. See `CallSessionStore.startSession`.
      id: handle.callSessionId,
      emergencyId: emergency.id,
      channel: input.channel ?? handle.transport,
      callerId: input.callerId ?? null,
      language,
      isSimulation: input.isSimulation ?? emergency.isSimulation
    });
    await this.deps.events.record(
      defineEvent("CALL_CONNECTED", {
        emergencyId: emergency.id,
        entityType: "call_session",
        entityId: session.id,
        actorType: input.actor?.actorType ?? "CALLER",
        payload: {
          callSessionId: session.id,
          emergencyId: emergency.id,
          channel: session.channel,
          provider: handle.providerName,
          transport: handle.transport,
          callerId: session.callerId,
          isLiveTransport: handle.isLive
        }
      }),
      { emergencyId: emergency.id }
    );
    this.logger.info(
      {
        emergencyId: emergency.id,
        callSessionId: session.id,
        transport: handle.transport,
        provider: handle.providerName,
        isLiveTransport: handle.isLive,
        language
      },
      "emergency call opened"
    );
    return {
      emergency,
      session,
      isLiveTransport: handle.isLive,
      provider: handle.providerName,
      transport: handle.transport,
      reused: false
    };
  }
  /**
   * Closes a call.
   *
   * Provider hangup is attempted first and its failure is logged but not
   * propagated: the local session must be closed even if the carrier is already
   * gone, because leaving `CallSession.status = ACTIVE` forever would make every
   * later "is this call still live?" check wrong.
   */
  async close(callSessionId, reason = "Call ended.") {
    const session = await this.deps.calls.sessionById(callSessionId);
    if (!session) {
      throw new AppError(ErrorCode.CALL_NOT_FOUND, `Call session '${callSessionId}' was not found.`, 404, {
        callSessionId
      });
    }
    if (session.status !== "ACTIVE") {
      return { session, durationMs: durationMsOf(session), closed: false };
    }
    try {
      await this.deps.telephony.hangup(callSessionId, reason);
    } catch (error) {
      this.logger.warn(
        { callSessionId, reason: error.message },
        "transport hangup failed; closing the local session anyway"
      );
    }
    const ended = await this.deps.calls.endSession(callSessionId);
    const finalSession = ended ?? session;
    const durationMs2 = durationMsOf(finalSession);
    await this.deps.events.record(
      defineEvent("CALL_DISCONNECTED", {
        emergencyId: finalSession.emergencyId,
        entityType: "call_session",
        entityId: callSessionId,
        payload: { callSessionId, emergencyId: finalSession.emergencyId, durationMs: durationMs2, reason }
      }),
      { emergencyId: finalSession.emergencyId }
    );
    this.logger.info(
      { callSessionId, emergencyId: finalSession.emergencyId, durationMs: durationMs2 },
      "emergency call closed"
    );
    return { session: finalSession, durationMs: durationMs2, closed: true };
  }
  /** Records what was said. Wording interpretation belongs to Module 3. */
  async recordUtterance(input) {
    const session = await this.deps.calls.sessionById(input.callSessionId);
    if (!session) {
      throw new AppError(ErrorCode.CALL_NOT_FOUND, `Call session '${input.callSessionId}' was not found.`, 404);
    }
    if (session.status !== "ACTIVE") {
      throw new AppError(
        ErrorCode.CONVERSATION_CLOSED,
        `Call session '${input.callSessionId}' has ended and cannot accept more speech.`,
        409,
        { callSessionId: input.callSessionId, status: session.status }
      );
    }
    return this.deps.calls.appendTranscript({
      callSessionId: input.callSessionId,
      emergencyId: session.emergencyId,
      speaker: input.speaker,
      text: input.text,
      isFinal: input.isFinal ?? true,
      intent: input.intent ?? null,
      confidence: input.confidence ?? null,
      isSimulation: session.isSimulation
    });
  }
  /**
   * Ends any call still open on an emergency.
   *
   * Called when the emergency reaches a terminal state, so a caller is never left
   * connected to a line nobody is listening to. Safe to call more than once.
   */
  async closeForEmergency(emergencyId, reason) {
    const session = await this.activeSession(emergencyId);
    if (!session) return null;
    return this.close(session.id, reason);
  }
  /**
   * Ends any call that has exceeded the configured maximum duration.
   *
   * A deployment runs this on a timer. It is a method rather than a timer here
   * so Module 10 can schedule it and tests can drive it without waiting on a
   * clock. Only sessions that are still ACTIVE and genuinely over the limit are
   * closed, so the call is never dropped early because of clock skew.
   *
   * `notBefore` is a lower bound on the session start time. A session that
   * started before it is never touched, which lets a scheduler that begins
   * watching part-way through a process lifetime leave calls that predate it
   * alone. The filter lives here, not in the caller, so every caller gets it.
   */
  async enforceMaxDuration(now = /* @__PURE__ */ new Date(), notBefore) {
    const limitMs = this.deps.config.telephony.maxCallDurationMinutes * 6e4;
    const closed = [];
    for (const session of await this.deps.calls.activeSessions()) {
      const startedAt = new Date(session.startedAt).getTime();
      if (notBefore && startedAt < notBefore.getTime()) continue;
      const elapsed = now.getTime() - startedAt;
      if (elapsed < limitMs) continue;
      const result = await this.close(session.id, "Maximum call duration reached.");
      if (result.closed) closed.push(result);
    }
    if (closed.length > 0) {
      this.logger.warn(
        { count: closed.length, maxCallDurationMinutes: this.deps.config.telephony.maxCallDurationMinutes },
        "closed call(s) that exceeded the maximum duration"
      );
    }
    return closed;
  }
  async transcript(emergencyId) {
    return this.deps.calls.transcriptsFor(emergencyId);
  }
  async currentSession(emergencyId) {
    const session = await this.activeSession(emergencyId);
    if (session) return session;
    return this.deps.calls.requireSessionFor(emergencyId);
  }
  /** Reports the transport for the health endpoint. */
  async transportStatus() {
    try {
      const probe = await this.deps.telephony.probe();
      return {
        provider: this.deps.telephony.providerName,
        isLive: this.deps.telephony.isLive,
        reachable: probe.reachable,
        detail: probe.detail
      };
    } catch (error) {
      return {
        provider: this.deps.telephony.providerName,
        isLive: this.deps.telephony.isLive,
        reachable: false,
        detail: error.message
      };
    }
  }
  /** True when the configured transport is real. Used by the health endpoint. */
  get isLiveTransport() {
    return this.deps.telephony.isLive;
  }
  // -- internals --------------------------------------------------------------
  async originate(input) {
    try {
      return await this.deps.telephony.originate({
        callerId: input.callerId ?? null,
        channel: input.channel,
        language: input.language
      });
    } catch (error) {
      if (input.emergencyId) {
        await this.deps.events.record(
          defineEvent("CALL_FAILED", {
            emergencyId: input.emergencyId,
            payload: {
              emergencyId: input.emergencyId,
              provider: this.deps.telephony.providerName,
              reason: error.message,
              fallback: null
            }
          }),
          { emergencyId: input.emergencyId }
        ).catch((recordError) => {
          this.logger.error({ reason: recordError.message }, "could not record CALL_FAILED");
        });
      }
      throw new AppError(
        ErrorCode.PROVIDER_UNAVAILABLE,
        `The call transport '${this.deps.telephony.providerName}' could not establish the call: ${error.message}`,
        503,
        { provider: this.deps.telephony.providerName }
      );
    }
  }
  /**
   * The newest session for an emergency when that session is still open, else
   * null. `requireSessionFor` returns the newest row regardless of status, so the
   * status check has to happen here rather than being assumed.
   */
  async activeSession(emergencyId) {
    try {
      const session = await this.deps.calls.requireSessionFor(emergencyId);
      return session.status === "ACTIVE" ? session : null;
    } catch {
      return null;
    }
  }
};
function normaliseLanguage(language) {
  const base = language.trim().toLowerCase().split(/[-_]/)[0] ?? "";
  return base === "" ? "en" : base;
}
function durationMsOf(session) {
  if (!session.endedAt) return 0;
  return Math.max(0, new Date(session.endedAt).getTime() - new Date(session.startedAt).getTime());
}

// modules/module_01_emergency_call/src/api/routes.ts
import { z as z4 } from "zod";
var openCallSchema = z4.object({
  emergencyId: z4.string().min(1).optional(),
  incidentType: incidentTypeSchema.optional(),
  severity: emergencySeveritySchema.optional(),
  latitude: z4.number().min(-90).max(90).optional(),
  longitude: z4.number().min(-180).max(180).optional(),
  description: z4.string().max(4e3).nullish(),
  callerId: z4.string().max(64).nullish(),
  channel: z4.string().max(32).optional(),
  language: z4.string().max(8).optional(),
  isSimulation: z4.boolean().optional()
}).refine(
  (value) => value.emergencyId !== void 0 || value.latitude !== void 0 && value.longitude !== void 0,
  {
    message: "Supply `emergencyId` to attach to an existing emergency, or both `latitude` and `longitude` to create one.",
    path: ["latitude"]
  }
).refine((value) => value.latitude === void 0 === (value.longitude === void 0), {
  message: "`latitude` and `longitude` must be supplied together.",
  path: ["longitude"]
});
var utteranceSchema = z4.object({
  speaker: z4.enum(["CALLER", "SYSTEM", "OPERATOR"]),
  text: z4.string().min(1).max(4e3),
  isFinal: z4.boolean().optional()
});
var paramsSchema = z4.object({ id: z4.string().min(1) });
var timingMarkerSchema = z4.object({ marker: z4.enum(["speech-start", "speech-end"]) });
function createModule1Routes(service) {
  return [
    {
      method: "POST",
      url: "/calls",
      module: "module_01",
      summary: "Open an emergency call, creating the emergency if one is not supplied",
      // Public: a bystander calling for help has no credentials.
      auth: { public: true },
      body: openCallSchema,
      handler: async (request, reply) => {
        const result = await service.open(request.body);
        reply.status(result.reused ? 200 : 201).send(result);
      }
    },
    {
      method: "POST",
      url: "/calls/:id/hangup",
      module: "module_01",
      summary: "End a call and record its duration",
      auth: { roles: ["CALL_CENTRE", "OPERATOR", "ADMIN"] },
      params: paramsSchema,
      body: z4.object({ reason: z4.string().max(500).optional() }).optional(),
      handler: async (request, reply) => {
        const { id } = request.params;
        const reason = request.body?.reason;
        reply.send(await service.close(id, reason ?? "Call ended."));
      }
    },
    {
      method: "POST",
      url: "/calls/:id/timing-markers",
      module: "module_01",
      summary: "Record a server-timestamped marker for an active synthetic AudioSocket call",
      auth: { roles: ["CALL_CENTRE", "OPERATOR", "ADMIN"] },
      params: paramsSchema,
      body: timingMarkerSchema,
      handler: async (request, reply) => {
        const { id } = request.params;
        const { marker } = request.body;
        const receipt = await service.markSyntheticSpeechTiming(id, marker);
        reply.status(receipt.accepted ? 200 : 422).send(receipt);
      }
    },
    {
      method: "POST",
      url: "/calls/:id/utterances",
      module: "module_01",
      summary: "Append an utterance to a live call transcript",
      auth: { roles: ["CALL_CENTRE", "OPERATOR", "ADMIN"] },
      params: paramsSchema,
      body: utteranceSchema,
      handler: async (request, reply) => {
        const { id } = request.params;
        reply.status(201).send(
          await service.recordUtterance({
            callSessionId: id,
            ...request.body
          })
        );
      }
    },
    {
      method: "GET",
      url: "/emergencies/:id/transcript",
      module: "module_01",
      summary: "Read the ordered transcript for an emergency",
      auth: { roles: ["CALL_CENTRE", "OPERATOR", "ADMIN", "PARAMEDIC", "DOCTOR"] },
      params: paramsSchema,
      handler: async (request, reply) => {
        const { id } = request.params;
        reply.send({ emergencyId: id, transcripts: await service.transcript(id) });
      }
    },
    {
      method: "GET",
      url: "/calls/:id",
      module: "module_01",
      summary: "Read the current call session for an emergency",
      auth: { roles: ["CALL_CENTRE", "OPERATOR", "ADMIN"] },
      params: paramsSchema,
      handler: async (request, reply) => {
        const { id } = request.params;
        reply.send(await service.currentSession(id));
      }
    },
    {
      method: "GET",
      url: "/calls/transport/status",
      module: "module_01",
      summary: "Report the telephony transport and whether it is live",
      auth: { public: true },
      handler: async (_request, reply) => {
        const status = await service.transportStatus();
        reply.status(status.reachable ? 200 : 503).send(status);
      }
    }
  ];
}

// modules/module_01_emergency_call/src/telephony/loopbackProvider.ts
var LoopbackTelephonyProvider = class {
  constructor(now = () => /* @__PURE__ */ new Date()) {
    this.now = now;
  }
  providerName = "loopback";
  isLive = false;
  sessions = /* @__PURE__ */ new Map();
  async originate(invite) {
    const id = createId("CALL");
    const handle = {
      callSessionId: id,
      transport: "LOOPBACK",
      providerName: this.providerName,
      isLive: false,
      startedAt: this.now().toISOString()
    };
    this.sessions.set(id, { startedAt: this.now(), handle });
    return handle;
  }
  async hangup(callSessionId, reason) {
    if (!this.sessions.has(callSessionId)) {
      throw new AppError(ErrorCode.CALL_NOT_FOUND, `Call session '${callSessionId}' is not active.`, 404, {
        callSessionId,
        reason
      });
    }
    this.sessions.delete(callSessionId);
  }
  async probe() {
    return {
      reachable: true,
      detail: `Loopback transport, ${this.sessions.size} active session(s). No telephone network is involved.`
    };
  }
  /** Test/diagnostic helper: sessions this provider still considers active. */
  activeSessions() {
    return [...this.sessions.keys()];
  }
};

// modules/module_01_emergency_call/src/telephony/asteriskProvider.ts
import { randomUUID } from "node:crypto";

// modules/module_01_emergency_call/src/telephony/asterisk/amiClient.ts
import net from "node:net";

// modules/module_01_emergency_call/src/telephony/asterisk/amiMessage.ts
var TERMINATOR = "\r\n\r\n";
function parseAmiBuffer(buffer) {
  const messages = [];
  let rest = buffer;
  let boundary = rest.indexOf(TERMINATOR);
  while (boundary !== -1) {
    const block = rest.slice(0, boundary);
    rest = rest.slice(boundary + TERMINATOR.length);
    if (block.trim() !== "") messages.push(parseAmiMessage(block));
    boundary = rest.indexOf(TERMINATOR);
  }
  return { messages, rest };
}
function parseAmiMessage(block) {
  const fields = {};
  for (const line of block.split("\r\n")) {
    if (line === "") continue;
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).replace(/^ /, "");
    if (!(key in fields)) fields[key] = value;
  }
  return {
    fields,
    event: fields.Event,
    response: fields.Response,
    actionId: fields.ActionID
  };
}
function serializeAmiAction(verb, params = {}) {
  let out = `Action: ${verb}\r
`;
  for (const [key, value] of Object.entries(params)) {
    if (value === void 0) continue;
    out += `${key}: ${value}\r
`;
  }
  return `${out}\r
`;
}

// modules/module_01_emergency_call/src/telephony/asterisk/amiClient.ts
var DEFAULT_CONNECT_TIMEOUT_MS = 5e3;
var DEFAULT_ACTION_TIMEOUT_MS = 1e4;
var AmiClient = class {
  logger;
  options;
  socket = null;
  /**
   * Id of the connection currently allowed to touch this client.
   *
   * A replaced socket keeps emitting events for a while after it was written
   * off — `close` in particular arrives asynchronously. Comparing against a
   * token taken per connection means those late events are ignored instead of
   * tearing down the connection that replaced them.
   */
  connectionToken = 0;
  buffer = "";
  loginInFlight = null;
  pending = /* @__PURE__ */ new Map();
  eventHandlers = /* @__PURE__ */ new Set();
  sequence = 0;
  closed = false;
  constructor(options) {
    this.options = {
      connectTimeoutMs: DEFAULT_CONNECT_TIMEOUT_MS,
      actionTimeoutMs: DEFAULT_ACTION_TIMEOUT_MS,
      ...options
    };
    this.logger = options.logger ?? noopLogger;
  }
  get connected() {
    return this.socket !== null && !this.closed;
  }
  /** Subscribes to asynchronous events. Returns an unsubscribe function. */
  onEvent(handler) {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }
  /** Connects and authenticates. Idempotent while a login is in flight. */
  async connect() {
    if (this.connected) return;
    if (this.loginInFlight) return this.loginInFlight;
    this.loginInFlight = this.doConnect().finally(() => {
      this.loginInFlight = null;
    });
    return this.loginInFlight;
  }
  async doConnect() {
    const token = this.connectionToken += 1;
    const create = this.options.createConnection ?? ((opts) => net.createConnection(opts));
    const socket = create({ host: this.options.host, port: this.options.port });
    socket.setEncoding("utf8");
    this.closed = false;
    socket.on("data", (chunk) => {
      if (this.connectionToken !== token) return;
      this.onData(chunk);
    });
    socket.on("error", (error) => {
      if (this.connectionToken !== token) return;
      this.failAll(error);
    });
    socket.on("close", () => {
      if (this.connectionToken !== token) return;
      this.socket = null;
      this.failAll(new AppError(ErrorCode.PROVIDER_UNAVAILABLE, "The AMI connection closed.", 503));
    });
    await new Promise((resolve2, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(
          new AppError(
            ErrorCode.PROVIDER_UNAVAILABLE,
            `Timed out connecting to Asterisk AMI at ${this.options.host}:${this.options.port}.`,
            503,
            { host: this.options.host, port: this.options.port }
          )
        );
      }, this.options.connectTimeoutMs);
      const onError = (error) => {
        clearTimeout(timer);
        reject(
          new AppError(
            ErrorCode.PROVIDER_UNAVAILABLE,
            `Could not reach Asterisk AMI at ${this.options.host}:${this.options.port}: ${error.message}`,
            503,
            { host: this.options.host, port: this.options.port }
          )
        );
      };
      socket.once("error", onError);
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.off("error", onError);
        resolve2();
      });
    });
    this.socket = socket;
    const login = await this.sendAction("Login", { Username: this.options.username, Secret: this.options.secret });
    if (login.Response !== "Success") {
      const message = login.Message ?? "AMI login was rejected.";
      socket.destroy();
      this.socket = null;
      throw new AppError(ErrorCode.PROVIDER_UNAVAILABLE, `Asterisk rejected the AMI login: ${message}`, 503);
    }
    await this.sendAction("Events", { EventMask: "on" }).catch((error) => {
      this.logger.warn({ reason: error.message }, "could not enable AMI events");
    });
    this.logger.info({ host: this.options.host, port: this.options.port }, "connected to Asterisk AMI");
  }
  /** A fresh id for correlating an action with its asynchronous event. */
  newActionId() {
    this.sequence += 1;
    return `${process.pid}-${this.sequence}`;
  }
  /** Sends one action and resolves with its reply headers. */
  async sendAction(verb, params = {}, timeoutMs = this.options.actionTimeoutMs) {
    const socket = this.socket;
    if (!socket) {
      throw new AppError(ErrorCode.PROVIDER_UNAVAILABLE, "The AMI connection is not open.", 503);
    }
    const actionId = typeof params.ActionID === "string" ? params.ActionID : this.newActionId();
    const reply = new Promise((resolve2, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(actionId);
        reject(
          new AppError(
            ErrorCode.PROVIDER_TIMEOUT,
            `Asterisk did not answer the '${verb}' action within ${timeoutMs} ms.`,
            504,
            { action: verb, actionId }
          )
        );
      }, timeoutMs);
      this.pending.set(actionId, { resolve: resolve2, reject, timer });
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
  waitForEvent(predicate, timeoutMs = this.options.actionTimeoutMs) {
    return new Promise((resolve2, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(
          new AppError(ErrorCode.PROVIDER_TIMEOUT, `No matching AMI event arrived within ${timeoutMs} ms.`, 504)
        );
      }, timeoutMs);
      const off = this.onEvent((event) => {
        if (!predicate(event)) return;
        clearTimeout(timer);
        off();
        resolve2(event);
      });
    });
  }
  /** Liveness probe. Resolves when Asterisk answers `Ping`. */
  async ping(timeoutMs) {
    if (!this.connected) await this.connect();
    const reply = await this.sendAction("Ping", {}, timeoutMs);
    if (reply.Response !== "Success") {
      throw new AppError(ErrorCode.PROVIDER_UNAVAILABLE, `Asterisk answered Ping with '${reply.Response ?? "nothing"}'.`, 503);
    }
  }
  /** Closes the socket and fails anything still waiting. */
  async close() {
    this.closed = true;
    const socket = this.socket;
    this.socket = null;
    this.failAll(new AppError(ErrorCode.PROVIDER_UNAVAILABLE, "The AMI client was closed.", 503));
    if (!socket) return;
    await new Promise((resolve2) => socket.end(() => resolve2()));
  }
  onData(chunk) {
    this.buffer += chunk;
    if (this.buffer.startsWith("Asterisk Call Manager")) {
      const newline = this.buffer.indexOf("\r\n");
      if (newline !== -1) this.buffer = this.buffer.slice(newline + 2);
    }
    const { messages, rest } = parseAmiBuffer(this.buffer);
    this.buffer = rest;
    for (const message of messages) this.dispatch(message);
  }
  dispatch(message) {
    if (message.response !== void 0 && message.actionId) {
      const pending = this.pending.get(message.actionId);
      if (pending) {
        this.pending.delete(message.actionId);
        clearTimeout(pending.timer);
        pending.resolve(message.fields);
        return;
      }
    }
    if (message.event !== void 0) {
      const event = { name: message.event, fields: message.fields };
      for (const handler of this.eventHandlers) {
        try {
          handler(event);
        } catch (error) {
          this.logger.error({ event: message.event, reason: error.message }, "AMI event handler threw");
        }
      }
    }
  }
  failAll(error) {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
};

// modules/module_01_emergency_call/src/telephony/asteriskProvider.ts
var AsteriskTelephonyProvider = class {
  constructor(config) {
    this.config = config;
    this.logger = config.logger ?? noopLogger;
    this.client = config.client ?? new AmiClient({ ...config.ami, logger: this.logger });
  }
  providerName = "asterisk";
  isLive = true;
  logger;
  client;
  calls = /* @__PURE__ */ new Map();
  byChannel = /* @__PURE__ */ new Map();
  byUuid = /* @__PURE__ */ new Map();
  /** Opens the AMI connection up front so a dead PBX fails at boot, not on the first call. */
  async start() {
    await this.client.connect();
  }
  async stop() {
    await this.client.close();
  }
  /** Subscribe to raw AMI events; used by the inbound-call intake. */
  onAmiEvent(handler) {
    return this.client.onEvent(handler);
  }
  async originate(invite) {
    await this.connectIfNeeded();
    const requestedChannel = invite.channel?.trim();
    if (requestedChannel) {
      const existingId = this.byChannel.get(requestedChannel);
      const tracked2 = existingId ? this.calls.get(existingId) : void 0;
      if (tracked2) return this.toHandle(tracked2);
    }
    const callSessionId = createId("CALL");
    const uuid = randomUUID();
    const endpoint = requestedChannel && requestedChannel !== "" ? requestedChannel : this.config.defaultEndpoint;
    const actionId = this.client.newActionId();
    const outcome = this.client.waitForEvent(
      (event2) => event2.name === "OriginateResponse" && event2.fields.ActionID === actionId,
      this.config.ami.actionTimeoutMs
    );
    let reply;
    try {
      reply = await this.client.sendAction("Originate", {
        Channel: endpoint,
        Context: this.config.context,
        Exten: this.config.exten,
        Priority: this.config.priority,
        CallerID: invite.callerId ?? void 0,
        // Two variables travel with the leg: the key we will hang up by, and the
        // UUID the dialplan hands to AudioSocket.
        Variable: `RESUS_CALL_KEY=${callSessionId},RESUS_CALL_UUID=${uuid}`,
        // File a hangup in the manager's event stream even if the dialplan path
        // never reaches AudioSocket.
        Async: "true",
        ActionID: actionId
      });
    } catch (error) {
      throw this.providerError("originate", error);
    }
    if (reply.Response !== "Success") {
      throw new AppError(
        ErrorCode.PROVIDER_UNAVAILABLE,
        `Asterisk refused to originate on '${endpoint}': ${reply.Message ?? reply.Response ?? "unknown reason"}.`,
        503,
        { endpoint, response: reply.Response }
      );
    }
    let event;
    try {
      event = await outcome;
    } catch (error) {
      throw this.providerError("originate", error);
    }
    if (event.fields.Response !== "Success") {
      throw new AppError(
        ErrorCode.PROVIDER_UNAVAILABLE,
        `Asterisk could not establish the call to '${endpoint}': ${event.fields.Reason ?? event.fields.Message ?? "no reason given"}.`,
        503,
        { endpoint, response: event.fields.Response, reason: event.fields.Reason }
      );
    }
    const tracked = {
      callSessionId,
      channel: event.fields.Channel ?? endpoint,
      uuid,
      direction: "outbound",
      startedAt: /* @__PURE__ */ new Date(),
      hungUp: false
    };
    this.register(tracked);
    this.logger.info(
      { callSessionId, channel: tracked.channel, endpoint, uuid },
      "originated an Asterisk call leg"
    );
    return this.toHandle(tracked);
  }
  /**
   * Registers a channel Asterisk already owns, returning the call-session id
   * Module 1 should store. Called by the inbound intake *before* it opens the
   * session, so `CallService.open()` -> `originate({ channel })` finds it.
   */
  trackInbound(input) {
    this.prune();
    const existingId = this.byChannel.get(input.channel);
    if (existingId) return existingId;
    const callSessionId = createId("CALL");
    const tracked = {
      callSessionId,
      channel: input.channel,
      uuid: input.uuid ?? null,
      direction: "inbound",
      startedAt: /* @__PURE__ */ new Date(),
      hungUp: false
    };
    this.register(tracked);
    this.logger.info(
      { callSessionId, channel: input.channel, uuid: tracked.uuid, callerId: input.callerId ?? null },
      "tracked an inbound Asterisk channel"
    );
    return callSessionId;
  }
  /** Binds a late-arriving AudioSocket UUID to an already tracked channel. */
  bindUuid(callSessionId, uuid) {
    const tracked = this.calls.get(callSessionId);
    if (!tracked) return;
    tracked.uuid = uuid;
    this.byUuid.set(uuid, callSessionId);
  }
  /** Marks a tracked call hung up when AMI reports the channel went away. */
  markHungUpByChannel(channel) {
    const callSessionId = this.byChannel.get(channel);
    const tracked = callSessionId ? this.calls.get(callSessionId) : void 0;
    if (tracked) tracked.hungUp = true;
  }
  callSessionIdForUuid(uuid) {
    return this.byUuid.get(uuid) ?? null;
  }
  callSessionIdForChannel(channel) {
    return this.byChannel.get(channel) ?? null;
  }
  async hangup(callSessionId, reason) {
    const tracked = this.calls.get(callSessionId);
    if (!tracked) {
      this.logger.debug({ callSessionId, reason }, "hangup for an unknown call leg; treating as already ended");
      return;
    }
    if (tracked.hungUp) return;
    await this.connectIfNeeded();
    if (tracked.channel) {
      await this.client.sendAction("Hangup", { Channel: tracked.channel }).catch((error) => {
        this.logger.warn(
          { callSessionId, channel: tracked.channel, reason: error.message },
          "Asterisk rejected the Hangup action; the channel may already be gone"
        );
      });
    }
    tracked.hungUp = true;
    this.release(tracked.callSessionId);
  }
  async probe() {
    try {
      await this.client.ping();
      return { reachable: true, detail: `Asterisk AMI reachable; ${this.calls.size} call leg(s) tracked.` };
    } catch (error) {
      return { reachable: false, detail: error.message };
    }
  }
  // -- internals --------------------------------------------------------------
  register(tracked) {
    this.calls.set(tracked.callSessionId, tracked);
    if (tracked.channel) this.byChannel.set(tracked.channel, tracked.callSessionId);
    if (tracked.uuid) this.byUuid.set(tracked.uuid, tracked.callSessionId);
  }
  release(callSessionId) {
    const tracked = this.calls.get(callSessionId);
    if (!tracked) return;
    this.calls.delete(callSessionId);
    this.byChannel.delete(tracked.channel);
    if (tracked.uuid) this.byUuid.delete(tracked.uuid);
  }
  /** Bounds the maps: a leg that has been hung up for over an hour is not coming back. */
  prune(now = Date.now()) {
    for (const [id, tracked] of this.calls) {
      if (tracked.hungUp && now - tracked.startedAt.getTime() > 36e5) this.release(id);
    }
  }
  toHandle(tracked) {
    return {
      callSessionId: tracked.callSessionId,
      transport: "SIP",
      providerName: this.providerName,
      isLive: this.isLive,
      startedAt: tracked.startedAt.toISOString()
    };
  }
  async connectIfNeeded() {
    if (!this.client.connected) await this.client.connect();
  }
  providerError(operation, error) {
    if (error instanceof AppError) return error;
    return new AppError(
      ErrorCode.PROVIDER_UNAVAILABLE,
      `Asterisk ${operation} failed: ${error.message}`,
      503,
      { provider: this.providerName, operation }
    );
  }
};

// modules/module_01_emergency_call/src/module.ts
function createTelephonyProvider(config, logger2) {
  const asterisk = config.telephony.asterisk;
  if (config.telephony.provider === "asterisk" && asterisk) {
    return new AsteriskTelephonyProvider({
      context: asterisk.dialplan.context,
      exten: asterisk.dialplan.exten,
      priority: asterisk.dialplan.priority,
      defaultEndpoint: asterisk.defaultEndpoint,
      audioSocketAddress: `${asterisk.audioSocket.advertiseHost}:${asterisk.audioSocket.bindPort}`,
      inboundChannelPrefix: "PJSIP/",
      inboundExtension: asterisk.inbound.extension,
      ami: asterisk.ami,
      logger: logger2
    });
  }
  return new LoopbackTelephonyProvider();
}
var Module1 = class {
  calls;
  telephony;
  config;
  logger;
  constructor(deps) {
    this.config = deps.config ?? loadModule1Config();
    this.logger = deps.logger ?? noopLogger;
    this.telephony = deps.telephony ?? createTelephonyProvider(this.config, this.logger);
    this.calls = new CallService({
      config: this.config,
      telephony: this.telephony,
      emergencies: deps.emergencies,
      calls: deps.calls,
      events: deps.events,
      logger: this.logger
    });
  }
  routes() {
    return createModule1Routes(this.calls);
  }
  register(table) {
    table.addAll(this.routes());
  }
};

// modules/module_01_emergency_call/src/telephony/asteriskIntake.ts
var AsteriskCallIntake = class {
  constructor(deps) {
    this.deps = deps;
    this.logger = deps.logger ?? noopLogger;
  }
  logger;
  handledChannels = /* @__PURE__ */ new Set();
  /**
   * The `open()` currently in flight per channel, published as a promise that
   * always settles.
   *
   * `CallService.open()` writes the emergency, the session and the event before
   * it returns, while Asterisk can report a hangup faster than that. A `Hangup`
   * that ran `close()` against a row that does not exist yet would log
   * `CALL_NOT_FOUND` and leave `CallSession.status = ACTIVE` on a call that has
   * actually ended. Holding the promise lets the hangup wait for the row instead.
   */
  opening = /* @__PURE__ */ new Map();
  unsubscribe = null;
  /** Subscribes to the AMI event stream. Idempotent. */
  start() {
    if (this.unsubscribe) return;
    this.unsubscribe = this.deps.provider.onAmiEvent((event) => {
      void this.onEvent(event);
    });
    this.logger.info(
      { variable: this.deps.config.inboundUuidVariable },
      "listening for inbound Asterisk calls"
    );
  }
  stop() {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
  async onEvent(event) {
    if (event.name === "VarSet") {
      await this.onVarSet(event);
      return;
    }
    if (event.name === "Hangup") {
      await this.onHangup(event);
    }
  }
  async onVarSet(event) {
    if (event.fields.Variable !== this.deps.config.inboundUuidVariable) return;
    const channel = event.fields.Channel;
    const uuid = event.fields.Value;
    if (!channel || !uuid) return;
    if (this.handledChannels.has(channel)) return;
    this.handledChannels.add(channel);
    const callerId = event.fields.CallerIDNum ?? this.deps.config.defaultCallerId;
    this.deps.provider.trackInbound({ channel, uuid, callerId });
    const opening = this.deps.calls.open({
      latitude: this.deps.config.latitude,
      longitude: this.deps.config.longitude,
      channel,
      callerId,
      language: this.deps.config.defaultLanguage,
      description: "Inbound emergency call. Location is the configured service-area centroid (provisional); confirm the caller's actual position."
    }).then(
      (result) => ({ ok: true, result }),
      (error) => ({ ok: false, error })
    );
    this.opening.set(channel, opening);
    try {
      const outcome = await opening;
      if (!outcome.ok) throw outcome.error;
      this.logOpened(outcome.result, channel, uuid);
    } catch (error) {
      this.handledChannels.delete(channel);
      this.logger.error(
        { channel, uuid, reason: error.message },
        "failed to open a session for an inbound Asterisk call"
      );
    } finally {
      this.opening.delete(channel);
    }
  }
  async onHangup(event) {
    const channel = event.fields.Channel;
    if (!channel) return;
    this.deps.provider.markHungUpByChannel(channel);
    const callSessionId = this.deps.provider.callSessionIdForChannel(channel);
    if (!callSessionId) return;
    const opening = this.opening.get(channel);
    if (opening) await opening;
    try {
      await this.deps.calls.close(callSessionId, event.fields.Cause ? `Caller hung up (${event.fields.Cause}).` : "Caller hung up.");
    } catch (error) {
      this.logger.warn(
        { channel, callSessionId, reason: error.message },
        "could not close the session for a hung-up Asterisk call"
      );
    }
  }
  logOpened(result, channel, uuid) {
    this.logger.info(
      {
        callSessionId: result.session.id,
        emergencyId: result.emergency.id,
        channel,
        uuid,
        language: result.session.language
      },
      "inbound Asterisk call opened a session"
    );
  }
};

// modules/module_01_emergency_call/src/telephony/asterisk/audioSocket.ts
import net2 from "node:net";
var KIND_TERMINATE = 0;
var KIND_UUID = 1;
var KIND_DTMF = 3;
var KIND_ERROR = 255;
var SLIN_SAMPLE_RATES = {
  16: 8e3,
  17: 12e3,
  18: 16e3,
  19: 24e3,
  20: 32e3,
  21: 44100,
  22: 48e3,
  23: 96e3,
  24: 192e3
};
var AUDIO_FRAME_BYTES = 320;
var AUDIO_FRAME_INTERVAL_MS = 20;
var outboundWriters = /* @__PURE__ */ new WeakMap();
var AudioSocketServer = class {
  constructor(options) {
    this.options = options;
    this.logger = options.logger ?? noopLogger;
    this.handlers = options;
  }
  logger;
  handlers;
  server = null;
  active = /* @__PURE__ */ new Map();
  get listening() {
    return this.server !== null;
  }
  /** UUIDs of connections currently open. */
  get sessionCount() {
    return this.active.size;
  }
  async listen() {
    if (this.server) return { host: this.options.host, port: this.options.port };
    const create = this.options.createServer ?? ((listener) => net2.createServer(listener));
    const server = create((socket) => this.handleConnection(socket));
    this.server = server;
    await new Promise((resolve2, reject) => {
      server.once("error", reject);
      server.listen(this.options.port, this.options.host, () => {
        server.off("error", reject);
        resolve2();
      });
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : this.options.port;
    this.logger.info({ host: this.options.host, port }, "AudioSocket server listening");
    return { host: this.options.host, port };
  }
  async close() {
    const server = this.server;
    this.server = null;
    for (const session of [...this.active.values()]) session.close();
    this.active.clear();
    if (!server) return;
    await new Promise((resolve2, reject) => server.close((error) => error ? reject(error) : resolve2()));
  }
  handleConnection(socket) {
    let buffer = Buffer.alloc(0);
    let session = null;
    const remote = `${socket.remoteAddress ?? "unknown"}:${socket.remotePort ?? 0}`;
    const finish = () => {
      if (session && this.active.get(session.uuid) === session) this.active.delete(session.uuid);
      socket.destroy();
    };
    socket.on("error", (error) => {
      this.logger.warn({ remote, reason: error.message }, "AudioSocket connection error");
      finish();
    });
    socket.on("close", () => {
      if (session) {
        this.active.delete(session.uuid);
        this.handlers.onClose?.(session);
      }
    });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        if (buffer.length < 3) return;
        const kind = buffer[0];
        const length = buffer.readUInt16BE(1);
        if (buffer.length < 3 + length) return;
        const payload = buffer.subarray(3, 3 + length);
        buffer = buffer.subarray(3 + length);
        if (kind === KIND_UUID) {
          if (payload.length !== 16) {
            this.logger.warn({ remote, bytes: payload.length }, "AudioSocket UUID frame was not 16 bytes");
            continue;
          }
          session = this.createSession(socket, formatUuid(payload), remote);
          this.active.set(session.uuid, session);
          this.logger.info({ uuid: session.uuid, remote }, "AudioSocket channel connected");
          this.handlers.onConnect?.(session);
          continue;
        }
        if (!session) {
          this.logger.warn({ remote, kind }, "AudioSocket frame before the UUID was ignored");
          continue;
        }
        const sampleRate = SLIN_SAMPLE_RATES[kind];
        if (sampleRate !== void 0) {
          this.handlers.onAudio?.(session, { sampleRate, pcm: Buffer.from(payload), receivedAt: Date.now() });
        } else if (kind === KIND_DTMF) {
          this.handlers.onDtmf?.(session, payload.toString("ascii"));
        } else if (kind === KIND_ERROR) {
          this.handlers.onError?.(session, payload.length > 0 ? payload[0] : 0);
        } else if (kind === KIND_TERMINATE) {
          finish();
          return;
        } else {
          this.logger.warn({ remote, kind }, "unknown AudioSocket frame type ignored");
        }
      }
    });
  }
  createSession(socket, uuid, remote) {
    return {
      uuid,
      remote,
      sendAudio: (pcm, onDrained) => writeAudio(socket, pcm, onDrained),
      sendHangup: () => {
        writeFrame(socket, KIND_TERMINATE, Buffer.alloc(0));
        socket.end();
      },
      close: () => socket.destroy()
    };
  }
};
function writeAudio(socket, pcm, onDrained) {
  const buffer = Buffer.from(pcm);
  if (buffer.length === 0) {
    safelyComplete(onDrained);
    return;
  }
  const writer = outboundWriters.get(socket) ?? { frames: [], next: 0, timer: null, completions: [] };
  outboundWriters.set(socket, writer);
  for (let offset = 0; offset < buffer.length; offset += AUDIO_FRAME_BYTES) {
    writer.frames.push(buffer.subarray(offset, offset + AUDIO_FRAME_BYTES));
  }
  if (onDrained) writer.completions.push({ afterFrame: writer.frames.length, callback: onDrained });
  if (!writer.timer) {
    writer.timer = setInterval(() => drainFrame(socket, writer), AUDIO_FRAME_INTERVAL_MS);
  }
}
function drainFrame(socket, writer) {
  if (socket.destroyed) {
    if (writer.timer) clearInterval(writer.timer);
    writer.timer = null;
    outboundWriters.delete(socket);
    writer.completions.length = 0;
    return;
  }
  if (writer.next >= writer.frames.length) {
    if (writer.timer) clearInterval(writer.timer);
    writer.timer = null;
    outboundWriters.delete(socket);
    for (const completion of writer.completions.splice(0)) safelyComplete(completion.callback);
    return;
  }
  writeFrame(socket, 16, writer.frames[writer.next]);
  writer.next += 1;
  while (writer.completions[0] && writer.completions[0].afterFrame <= writer.next) {
    safelyComplete(writer.completions.shift()?.callback);
  }
}
function safelyComplete(callback) {
  try {
    callback?.();
  } catch {
  }
}
function writeFrame(socket, kind, payload) {
  const header = Buffer.alloc(3);
  header[0] = kind;
  header.writeUInt16BE(payload.length, 1);
  socket.write(Buffer.concat([header, payload]));
}
function formatUuid(bytes) {
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// modules/module_01_emergency_call/src/telephony/asterisk/audioBridge.ts
import { performance } from "node:perf_hooks";
var BYTES_PER_MS_AT_8K = 16;
var EXPECTED_SAMPLE_RATE = 8e3;
var MAX_SYNTHETIC_DIAGNOSTIC_SEGMENTS_PER_CALL = 64;
var MAX_SYNTHETIC_TIMING_MARKERS_PER_CALL = 64;
var AudioBridge = class {
  constructor(deps) {
    this.deps = deps;
    this.logger = deps.logger ?? noopLogger;
    this.monotonicNow = deps.monotonicNow ?? (() => performance.now());
    const { bindHost, bindPort } = deps.config;
    this.server = new AudioSocketServer({
      host: bindHost,
      port: bindPort,
      logger: this.logger,
      onConnect: (session) => this.onConnect(session),
      onAudio: (session, frame) => this.onAudio(session, frame),
      onDtmf: (session, digit) => this.onDtmf(session, digit),
      onError: (session, code) => {
        this.logger.warn({ uuid: session.uuid, code }, "Asterisk reported an AudioSocket error");
      },
      onClose: (session) => this.onClose(session)
    });
  }
  logger;
  server;
  connections = /* @__PURE__ */ new Map();
  monotonicNow;
  async start() {
    const address = await this.server.listen();
    this.logger.info(
      { greeting: this.deps.config.greeting !== "" },
      "audio bridge listening for Asterisk media"
    );
    return address;
  }
  async stop() {
    for (const connection of this.connections.values()) {
      connection.state = "closed";
      this.clearSilenceTimer(connection);
    }
    this.connections.clear();
    await this.server.close();
  }
  /** Number of Asterisk channels currently streaming media. */
  get activeConnections() {
    return this.connections.size;
  }
  /** Records operator input on the server clock shared by all call diagnostics. */
  recordSyntheticSpeechMarker(callSessionId, marker) {
    const connection = [...this.connections.values()].find((item) => item.callSessionId === callSessionId);
    if (!connection || connection.state !== "active" || !connection.isSimulation || connection.monotonicOriginMs === null) {
      return { accepted: false, reason: "no-active-audio-stream" };
    }
    if (connection.timingMarkerCount >= MAX_SYNTHETIC_TIMING_MARKERS_PER_CALL) {
      return { accepted: false, reason: "limit-reached" };
    }
    if (marker === "speech-start") {
      if (connection.speechStarted || connection.speechEnded) {
        return { accepted: false, reason: "duplicate" };
      }
      if (connection.completedPromptCount < 1 || connection.promptOpen) {
        return { accepted: false, reason: "invalid-order" };
      }
      connection.speechStarted = true;
    } else {
      if (connection.speechEnded) return { accepted: false, reason: "duplicate" };
      if (!connection.speechStarted) return { accepted: false, reason: "invalid-order" };
      connection.speechEnded = true;
    }
    return this.recordTimingMarker(connection, marker);
  }
  // -- lifecycle --------------------------------------------------------------
  onConnect(session) {
    const connection = {
      uuid: session.uuid,
      remote: session.remote,
      callSessionId: null,
      emergencyId: null,
      queue: [],
      state: "resolving",
      utterance: [],
      utteranceMs: 0,
      utteranceFrameCount: 0,
      utteranceFrameBytes: [],
      utteranceSampleRates: /* @__PURE__ */ new Set(),
      segmentSequence: 0,
      diagnosticSegmentCount: 0,
      isSimulation: false,
      activeSegment: null,
      trailingSilenceMs: 0,
      trailingSilenceFrameCount: 0,
      inSpeech: false,
      warnedRate: false,
      silenceTimer: null,
      promptOutstanding: false,
      monotonicOriginMs: null,
      timingMarkerCount: 0,
      completedPromptCount: 0,
      promptOpen: false,
      speechStarted: false,
      speechEnded: false,
      timingSequence: 0
    };
    this.connections.set(session.uuid, connection);
    void this.attach(connection, session);
  }
  async attach(connection, session) {
    const deadline = Date.now() + this.deps.config.resolveTimeoutMs;
    const callSessionId = await this.resolveCallSession(connection.uuid, deadline);
    if (!callSessionId) {
      this.logger.warn(
        { uuid: connection.uuid },
        "an Asterisk media stream arrived but no call session was bound to it; dropping the stream"
      );
      connection.state = "closed";
      this.connections.delete(connection.uuid);
      session.sendHangup();
      return;
    }
    const record = await this.waitForSession(callSessionId, deadline);
    if (!record || record.status !== "ACTIVE") {
      this.logger.warn(
        { uuid: connection.uuid, callSessionId, status: record?.status ?? "missing" },
        "an Asterisk media stream bound to a call session that is not active; dropping the stream"
      );
      connection.state = "closed";
      this.connections.delete(connection.uuid);
      session.sendHangup();
      return;
    }
    connection.callSessionId = callSessionId;
    connection.emergencyId = record.emergencyId;
    connection.isSimulation = record.isSimulation;
    connection.state = "active";
    connection.monotonicOriginMs = this.monotonicNow();
    this.logger.info(
      { uuid: connection.uuid, callSessionId, emergencyId: record.emergencyId, remote: connection.remote },
      "Asterisk media stream bound to a call session"
    );
    const queued = connection.queue;
    connection.queue = [];
    for (const frame of queued) this.processFrame(session, connection, frame, EXPECTED_SAMPLE_RATE);
    await this.beginConversation(session, connection, record);
  }
  /**
   * Polls the provider for the UUID binding.
   *
   * Polling rather than an event subscription because the provider is already
   * the authority on the map and a short, bounded wait is simpler than wiring a
   * second event path for a race that only exists for a few milliseconds.
   */
  async resolveCallSession(uuid, deadline) {
    for (; ; ) {
      const found = this.deps.provider.callSessionIdForUuid(uuid);
      if (found) return found;
      if (Date.now() >= deadline) return null;
      await new Promise((resolve2) => setTimeout(resolve2, 50));
    }
  }
  /**
   * Waits for the `CallSession` row the binding points at.
   *
   * `CallService.open()` registers the channel with the provider before it has
   * written the row, so the binding is known a moment before the session exists.
   * Reading the row once at that point drops a call that is being opened
   * correctly, and Asterisk hangs the leg up while it is still being answered.
   * The row is therefore waited for inside the same deadline as the binding.
   *
   * An existing row is returned straight away whatever its status: the caller
   * checks `ACTIVE`, and polling a closed session would only delay reporting
   * that the call already ended.
   */
  async waitForSession(callSessionId, deadline) {
    for (; ; ) {
      const record = await this.deps.calls.sessionById(callSessionId);
      if (record) return record;
      if (Date.now() >= deadline) return null;
      await new Promise((resolve2) => setTimeout(resolve2, 50));
    }
  }
  async playGreeting(session, connection, record) {
    const greeting = this.deps.config.greeting.trim();
    if (greeting === "") return;
    if (!connection.callSessionId || !connection.emergencyId) return;
    if (this.isStreamClosed(connection)) return;
    try {
      const spoken = await this.deps.speech.speak({
        text: greeting,
        language: record.language,
        tone: this.deps.config.greetingTone,
        // The greeting is configured prose, not the protocol catalogue's wording,
        // and the transcript must not later claim the caller heard reviewed text.
        verbatimProtocolText: false,
        emergencyId: connection.emergencyId,
        callSessionId: connection.callSessionId
      });
      if (this.isStreamClosed(connection)) {
        this.logger.debug(
          { callSessionId: connection.callSessionId },
          "discarding a greeting synthesised after the call ended"
        );
        return;
      }
      if (spoken.isAudible && spoken.audio.length > 0) {
        this.sendDiagnosticPrompt(session, connection, spoken.audio);
        this.logger.info(
          {
            callSessionId: connection.callSessionId,
            voice: spoken.voice,
            provider: spoken.provider,
            durationMs: spoken.durationMs
          },
          "played the intake greeting to the caller"
        );
      } else {
        this.logger.warn(
          { callSessionId: connection.callSessionId },
          "the greeting produced no audio; the caller will hear silence"
        );
      }
    } catch (error) {
      this.logger.error(
        { callSessionId: connection.callSessionId, reason: error.message },
        "could not play the intake greeting"
      );
    }
  }
  /**
   * Starts the spoken half of the call.
   *
   * With a conversation port the caller hears the protocol's first instruction,
   * not the configured greeting, so the two prompts cannot both play and repeat
   * each other. The greeting remains the fallback for a build without a
   * conversation port and for the case where no protocol session could be
   * started — silence would be worse.
   */
  async beginConversation(session, connection, record) {
    const conversation = this.deps.conversation;
    const callSessionId = connection.callSessionId;
    const emergencyId = connection.emergencyId;
    if (!conversation || !callSessionId || !emergencyId) {
      await this.playGreeting(session, connection, record);
      return;
    }
    if (this.isStreamClosed(connection)) return;
    try {
      const turn = await conversation.onCallConnected({
        callSessionId,
        emergencyId,
        language: record.language
      });
      if (!turn) {
        await this.playGreeting(session, connection, record);
        return;
      }
      await this.deliverTurn(session, connection, turn, record.language);
    } catch (error) {
      this.logger.error(
        { callSessionId, emergencyId, reason: error.message },
        "could not start the protocol conversation; falling back to the greeting"
      );
      await this.playGreeting(session, connection, record);
    }
  }
  /**
   * Advances the protocol after a caller utterance and speaks the next turn.
   *
   * Called only for a stored, final utterance: a rejected or empty transcription
   * is not something the caller said, and feeding it to the protocol would let a
   * recogniser mistake steer a clinical step.
   */
  async advanceConversation(session, connection, language, text) {
    const conversation = this.deps.conversation;
    const callSessionId = connection.callSessionId;
    const emergencyId = connection.emergencyId;
    if (!conversation || !callSessionId || !emergencyId) return;
    if (this.isStreamClosed(connection)) return;
    try {
      const turn = await conversation.onCallerUtterance({
        callSessionId,
        emergencyId,
        language,
        text
      });
      if (!turn) return;
      if (this.isStreamClosed(connection)) return;
      await this.deliverTurn(session, connection, turn, language);
    } catch (error) {
      this.logger.error(
        { callSessionId, emergencyId, reason: error.message },
        "could not advance the protocol conversation"
      );
    }
  }
  /** Speaks one turn over the live socket, using Module 2 and the paced writer. */
  async speakTurn(session, connection, turn, language) {
    const callSessionId = connection.callSessionId;
    const emergencyId = connection.emergencyId;
    if (!callSessionId || !emergencyId) return;
    if (turn.speech.trim() === "") return;
    if (this.isStreamClosed(connection)) return;
    try {
      const spoken = await this.deps.speech.speak({
        text: turn.speech,
        language,
        tone: turn.tone,
        verbatimProtocolText: turn.verbatimProtocolText,
        emergencyId,
        callSessionId
      });
      if (this.isStreamClosed(connection)) {
        this.logger.debug({ callSessionId }, "discarding speech synthesised after the call ended");
        return;
      }
      if (spoken.isAudible && spoken.audio.length > 0) {
        this.sendDiagnosticPrompt(session, connection, spoken.audio);
        this.logger.info(
          {
            callSessionId,
            emergencyId,
            terminal: turn.terminal,
            provider: spoken.provider,
            durationMs: spoken.durationMs
          },
          "spoke a protocol instruction to the caller"
        );
      } else {
        this.logger.warn(
          { callSessionId },
          "the protocol instruction produced no audio; the caller will hear silence"
        );
      }
    } catch (error) {
      this.logger.error(
        { callSessionId, reason: error.message },
        "could not speak the protocol instruction"
      );
    }
  }
  // -- silence ----------------------------------------------------------------
  /**
   * Speaks one turn and arms the caller-silence timer against it.
   *
   * Every turn the caller hears goes through here so the silence budget is tied to
   * the prompt that is actually outstanding. A terminal turn arms nothing: the
   * protocol has finished, so there is no question left to answer or repeat.
   */
  async deliverTurn(session, connection, turn, language) {
    connection.promptOutstanding = !turn.terminal;
    await this.speakTurn(session, connection, turn, language);
    this.armSilenceTimer(session, connection);
  }
  /** (Re)arms the silence timer for the prompt currently outstanding. */
  armSilenceTimer(session, connection) {
    this.clearSilenceTimer(connection);
    const port = this.deps.conversation;
    const timeoutMs = this.deps.config.silenceTimeoutMs ?? 0;
    if (timeoutMs <= 0) return;
    if (!connection.promptOutstanding) return;
    if (this.isStreamClosed(connection)) return;
    if (typeof port?.onCallerSilence !== "function") return;
    connection.silenceTimer = setTimeout(() => {
      connection.silenceTimer = null;
      void this.handleCallerSilence(session, connection);
    }, timeoutMs);
    connection.silenceTimer.unref?.();
  }
  clearSilenceTimer(connection) {
    if (connection.silenceTimer) {
      clearTimeout(connection.silenceTimer);
      connection.silenceTimer = null;
    }
  }
  /**
   * Handles one silent window: ask the conversation what, if anything, to repeat.
   *
   * The call is re-read before acting, so a caller who hung up during the wait is
   * not prompted. The conversation's reply is only spoken if the stream is still
   * open, exactly like any other turn.
   */
  async handleCallerSilence(session, connection) {
    if (this.isStreamClosed(connection)) return;
    const port = this.deps.conversation;
    const callSessionId = connection.callSessionId;
    const emergencyId = connection.emergencyId;
    if (typeof port?.onCallerSilence !== "function" || !callSessionId || !emergencyId) return;
    let language;
    try {
      const record = await this.deps.calls.sessionById(callSessionId);
      if (!record || record.status !== "ACTIVE") return;
      language = record.language;
    } catch (error) {
      this.logger.warn(
        { callSessionId, reason: error.message },
        "could not re-read the call session before handling caller silence"
      );
      return;
    }
    if (this.isStreamClosed(connection)) return;
    let turn;
    try {
      turn = await port.onCallerSilence({ callSessionId, emergencyId, language });
    } catch (error) {
      this.logger.error(
        { callSessionId, emergencyId, reason: error.message },
        "could not handle caller silence"
      );
      return;
    }
    if (this.isStreamClosed(connection)) {
      this.logger.debug(
        { callSessionId },
        "discarding silence handling that finished after the call ended"
      );
      return;
    }
    if (!turn) {
      connection.promptOutstanding = false;
      return;
    }
    await this.deliverTurn(session, connection, turn, language);
  }
  // -- media ------------------------------------------------------------------
  onAudio(session, frame) {
    const connection = this.connections.get(session.uuid);
    if (!connection || this.isStreamClosed(connection)) return;
    if (frame.sampleRate !== EXPECTED_SAMPLE_RATE && !connection.warnedRate) {
      connection.warnedRate = true;
      this.logger.warn(
        { uuid: session.uuid, sampleRate: frame.sampleRate, expected: EXPECTED_SAMPLE_RATE },
        "AudioSocket delivered an unexpected sample rate; transcription quality may degrade"
      );
    }
    if (connection.state === "resolving") {
      connection.queue.push(frame.pcm);
      return;
    }
    this.processFrame(session, connection, frame.pcm, frame.sampleRate);
  }
  processFrame(session, connection, pcm, sampleRate) {
    const frameMs = Math.round(pcm.length / BYTES_PER_MS_AT_8K * (EXPECTED_SAMPLE_RATE / sampleRate));
    const level = rms(pcm);
    const loud = level >= this.deps.config.speechRmsThreshold;
    if (!connection.inSpeech) {
      if (!loud) return;
      connection.inSpeech = true;
      connection.utterance = [pcm];
      connection.utteranceMs = frameMs;
      connection.utteranceFrameCount = 1;
      connection.utteranceFrameBytes = [pcm.length];
      connection.utteranceSampleRates = /* @__PURE__ */ new Set([sampleRate]);
      connection.segmentSequence += 1;
      const diagnosticEnabled = connection.isSimulation && connection.diagnosticSegmentCount < MAX_SYNTHETIC_DIAGNOSTIC_SEGMENTS_PER_CALL;
      if (diagnosticEnabled) connection.diagnosticSegmentCount += 1;
      const framePeak = diagnosticEnabled ? peak(pcm) : 0;
      connection.activeSegment = {
        segmentId: `${connection.callSessionId ?? connection.uuid}:SEG-${String(connection.segmentSequence).padStart(4, "0")}`,
        startedAtMs: Date.now(),
        startedAtMonotonicMs: this.monotonicNow(),
        diagnosticEnabled,
        frameCount: 1,
        frameRmsMin: level,
        frameRmsMax: level,
        frameRmsSum: level,
        frameRmsAboveThreshold: 1,
        framePeakMin: framePeak,
        framePeakMax: framePeak,
        framePeakSum: framePeak
      };
      connection.trailingSilenceMs = 0;
      connection.trailingSilenceFrameCount = 0;
      this.clearSilenceTimer(connection);
      return;
    }
    connection.utterance.push(pcm);
    connection.utteranceMs += frameMs;
    connection.utteranceFrameCount += 1;
    connection.utteranceFrameBytes.push(pcm.length);
    connection.utteranceSampleRates.add(sampleRate);
    const segment = connection.activeSegment;
    if (segment?.diagnosticEnabled) {
      const framePeak = peak(pcm);
      segment.frameCount += 1;
      segment.frameRmsMin = Math.min(segment.frameRmsMin, level);
      segment.frameRmsMax = Math.max(segment.frameRmsMax, level);
      segment.frameRmsSum += level;
      segment.framePeakMin = Math.min(segment.framePeakMin, framePeak);
      segment.framePeakMax = Math.max(segment.framePeakMax, framePeak);
      segment.framePeakSum += framePeak;
      if (loud) segment.frameRmsAboveThreshold += 1;
    }
    connection.trailingSilenceMs = loud ? 0 : connection.trailingSilenceMs + frameMs;
    connection.trailingSilenceFrameCount = loud ? 0 : connection.trailingSilenceFrameCount + 1;
    const reachedMaxDuration = connection.utteranceMs >= this.deps.config.maxUtteranceMs;
    if (connection.trailingSilenceMs >= this.deps.config.hangoverMs || reachedMaxDuration) {
      this.finaliseUtterance(session, connection, reachedMaxDuration ? "max-duration" : "silence-hangover");
    }
  }
  finaliseUtterance(session, connection, boundaryReason) {
    const utterance = connection.utterance;
    const utteranceMs = connection.utteranceMs;
    const frameCount = connection.utteranceFrameCount;
    const frameBytes = connection.utteranceFrameBytes;
    const sampleRates = [...connection.utteranceSampleRates].sort((a, b) => a - b);
    const segment = connection.activeSegment;
    const endedAtMs = Date.now();
    const endedAtMonotonicMs = this.monotonicNow();
    const pcm = Buffer.concat(utterance);
    const transcriptionOutcome = utteranceMs < this.deps.config.minUtteranceMs ? "dropped-too-short" : connection.callSessionId && connection.emergencyId ? "submitted" : "dropped-missing-session";
    const segmentDiagnostics = segment?.diagnosticEnabled ? buildSegmentDiagnostics(segment, endedAtMs, this.callRelativeMs(connection, segment.startedAtMonotonicMs), this.callRelativeMs(connection, endedAtMonotonicMs), utteranceMs, pcm.length, boundaryReason, transcriptionOutcome, connection.trailingSilenceFrameCount) : void 0;
    connection.utterance = [];
    connection.utteranceMs = 0;
    connection.utteranceFrameCount = 0;
    connection.utteranceFrameBytes = [];
    connection.utteranceSampleRates.clear();
    connection.activeSegment = null;
    connection.trailingSilenceMs = 0;
    connection.trailingSilenceFrameCount = 0;
    connection.inSpeech = false;
    if (utterance.length === 0) return;
    if (connection.isSimulation && segmentDiagnostics) {
      safeDiagnosticInfo(
        this.logger,
        {
          callSessionId: connection.callSessionId,
          emergencyId: connection.emergencyId,
          scope: "synthetic-test",
          ...measurePcm(pcm, sampleRates, { frameCount, frameBytes, vadDurationMs: utteranceMs }),
          ...segmentDiagnostics
        },
        "synthetic test audio ingress diagnostics"
      );
    }
    if (utteranceMs < this.deps.config.minUtteranceMs) {
      this.logger.debug(
        { uuid: session.uuid, utteranceMs },
        "discarding a short audio burst that is not an utterance"
      );
      return;
    }
    if (!connection.callSessionId || !connection.emergencyId) return;
    void this.transcribe(session, connection, pcm, segmentDiagnostics);
  }
  async transcribe(session, connection, pcm, segmentDiagnostics) {
    if (this.isStreamClosed(connection)) return;
    const callSessionId = connection.callSessionId;
    const emergencyId = connection.emergencyId;
    if (!callSessionId || !emergencyId) return;
    const record = await this.deps.calls.sessionById(callSessionId);
    if (!record || record.status !== "ACTIVE") {
      this.logger.debug({ callSessionId }, "dropping an utterance for a call session that already ended");
      return;
    }
    try {
      const transcriptionStartedAt = Date.now();
      const result = await this.deps.speech.transcribe({
        callSessionId,
        emergencyId,
        audio: pcm,
        language: record.language,
        speaker: "CALLER",
        isFinal: true,
        ...record.isSimulation && segmentDiagnostics ? { diagnosticScope: "synthetic-test", segmentDiagnostics } : {}
      });
      if (record.isSimulation && segmentDiagnostics) {
        safeDiagnosticInfo(
          this.logger,
          {
            callSessionId,
            emergencyId,
            scope: "synthetic-test",
            ...segmentDiagnostics,
            transcriptionRoundTripMs: Date.now() - transcriptionStartedAt,
            accepted: result.accepted,
            confidence: result.confidence
          },
          "synthetic test transcription diagnostics"
        );
      }
      this.logger.info(
        {
          callSessionId,
          emergencyId,
          accepted: result.accepted,
          confidence: result.confidence,
          band: result.band,
          characters: result.text.length
        },
        "transcribed a caller utterance from the live call"
      );
      if (this.isStreamClosed(connection)) {
        this.logger.debug(
          { callSessionId },
          "discarding a transcription that finished after the call ended"
        );
        return;
      }
      if (result.accepted && result.text.trim() !== "") {
        const stillLive = await this.deps.calls.sessionById(callSessionId);
        if (!stillLive || stillLive.status !== "ACTIVE") {
          this.logger.debug(
            { callSessionId },
            "dropping an utterance for a call session that ended during transcription"
          );
          return;
        }
        await this.advanceConversation(session, connection, record.language, result.text);
      }
    } catch (error) {
      this.logger.warn(
        { callSessionId, emergencyId, reason: error.message },
        "could not transcribe a caller utterance"
      );
    } finally {
      this.armSilenceTimer(session, connection);
    }
  }
  onDtmf(session, digit) {
    const connection = this.connections.get(session.uuid);
    this.logger.info(
      { uuid: session.uuid, digit, callSessionId: connection?.callSessionId ?? null },
      "received DTMF from the caller"
    );
  }
  sendDiagnosticPrompt(session, connection, audio) {
    if (!connection.isSimulation) {
      session.sendAudio(audio);
      return;
    }
    this.recordPromptTiming(connection, "prompt-start");
    session.sendAudio(audio, () => this.recordPromptTiming(connection, "prompt-end"));
  }
  recordPromptTiming(connection, marker) {
    if (marker === "prompt-start") {
      if (connection.promptOpen || connection.timingMarkerCount >= MAX_SYNTHETIC_TIMING_MARKERS_PER_CALL) return;
      connection.promptOpen = true;
    } else {
      if (!connection.promptOpen || connection.timingMarkerCount >= MAX_SYNTHETIC_TIMING_MARKERS_PER_CALL) return;
      connection.promptOpen = false;
      connection.completedPromptCount += 1;
    }
    this.recordTimingMarker(connection, marker);
  }
  recordTimingMarker(connection, marker) {
    const origin = connection.monotonicOriginMs;
    if (!connection.isSimulation || origin === null) {
      return { accepted: false, reason: "no-active-audio-stream" };
    }
    if (connection.timingMarkerCount >= MAX_SYNTHETIC_TIMING_MARKERS_PER_CALL) {
      return { accepted: false, reason: "limit-reached" };
    }
    const callRelativeMs = Math.max(0, this.monotonicNow() - origin);
    connection.timingMarkerCount += 1;
    connection.timingSequence += 1;
    safeDiagnosticInfo(
      this.logger,
      {
        callSessionId: connection.callSessionId,
        emergencyId: connection.emergencyId,
        scope: "synthetic-test",
        marker,
        markerSequence: connection.timingSequence,
        promptOrdinal: marker.startsWith("prompt-") ? connection.completedPromptCount + (marker === "prompt-start" ? 1 : 0) : void 0,
        callRelativeMs
      },
      "synthetic call audio timing marker"
    );
    return { accepted: true, callRelativeMs };
  }
  callRelativeMs(connection, timestamp) {
    return connection.monotonicOriginMs === null ? 0 : Math.max(0, timestamp - connection.monotonicOriginMs);
  }
  /**
   * True once the stream has closed.
   *
   * Read through a method rather than comparing `connection.state` inline: a
   * direct comparison would let the compiler narrow the property to its
   * pre-await value and treat the post-await re-check as dead code, which is
   * exactly the mistake this guard exists to catch.
   */
  isStreamClosed(connection) {
    return connection.state === "closed";
  }
  onClose(session) {
    const connection = this.connections.get(session.uuid);
    this.connections.delete(session.uuid);
    if (!connection) return;
    connection.state = "closed";
    this.clearSilenceTimer(connection);
    if (connection.isSimulation && connection.activeSegment?.diagnosticEnabled) {
      const pcm = Buffer.concat(connection.utterance);
      const endedAtMs = Date.now();
      const endedAtMonotonicMs = this.monotonicNow();
      const frameBytes = connection.utteranceFrameBytes;
      const frameCount = connection.utteranceFrameCount;
      const sampleRates = [...connection.utteranceSampleRates].sort((a, b) => a - b);
      const segmentDiagnostics = buildSegmentDiagnostics(
        connection.activeSegment,
        endedAtMs,
        this.callRelativeMs(connection, connection.activeSegment.startedAtMonotonicMs),
        this.callRelativeMs(connection, endedAtMonotonicMs),
        connection.utteranceMs,
        pcm.length,
        "call-ended",
        "discarded-call-ended",
        connection.trailingSilenceFrameCount
      );
      safeDiagnosticInfo(
        this.logger,
        {
          callSessionId: connection.callSessionId,
          emergencyId: connection.emergencyId,
          scope: "synthetic-test",
          ...measurePcm(pcm, sampleRates, {
            frameCount,
            frameBytes,
            vadDurationMs: connection.utteranceMs
          }),
          ...segmentDiagnostics
        },
        "synthetic test audio ingress diagnostics"
      );
    }
    if (connection.callSessionId) {
      this.deps.conversation?.forget?.(connection.callSessionId);
    }
    this.logger.info(
      { uuid: session.uuid, callSessionId: connection.callSessionId },
      "Asterisk media stream ended"
    );
  }
};
function buildSegmentDiagnostics(segment, endedAtMs, callRelativeStartMs, callRelativeEndMs, durationMs2, payloadBytes, boundaryReason, transcriptionOutcome, trailingSilenceFrameCount) {
  const frameCount = Math.max(1, segment.frameCount);
  return {
    segmentId: segment.segmentId,
    callRelativeStartMs,
    callRelativeEndMs,
    startedAt: new Date(segment.startedAtMs).toISOString(),
    endedAt: new Date(endedAtMs).toISOString(),
    durationMs: durationMs2,
    sampleCount: Math.floor(payloadBytes / 2),
    boundaryReason,
    transcriptionOutcome,
    frameCount,
    trailingSilenceFrameCount,
    frameRmsMin: Math.round(segment.frameRmsMin),
    frameRmsMean: Math.round(segment.frameRmsSum / frameCount),
    frameRmsMax: Math.round(segment.frameRmsMax),
    frameRmsAboveThreshold: segment.frameRmsAboveThreshold,
    framePeakMin: Math.round(segment.framePeakMin),
    framePeakMean: Math.round(segment.framePeakSum / frameCount),
    framePeakMax: Math.round(segment.framePeakMax)
  };
}
function safeDiagnosticInfo(logger2, fields, message) {
  try {
    logger2.info(fields, message);
  } catch {
  }
}
function measurePcm(pcm, sampleRates, framing) {
  const sampleCount = Math.floor(pcm.length / 2);
  let sumSquares = 0;
  let peak2 = 0;
  let clipped = 0;
  for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
    const sample = pcm.readInt16LE(offset);
    const magnitude = Math.abs(sample);
    sumSquares += sample * sample;
    peak2 = Math.max(peak2, magnitude);
    if (magnitude >= 32760) clipped += 1;
  }
  const oneRate = sampleRates.length === 1 ? sampleRates[0] : null;
  const frameBytes = framing.frameBytes;
  return {
    sampleRates,
    channels: 1,
    sampleFormat: "signed-int16-le",
    sampleCount,
    payloadBytes: pcm.length,
    durationMs: oneRate ? sampleCount / oneRate * 1e3 : null,
    vadDurationMs: framing.vadDurationMs,
    frameCount: framing.frameCount,
    minFrameBytes: frameBytes.length ? Math.min(...frameBytes) : 0,
    maxFrameBytes: frameBytes.length ? Math.max(...frameBytes) : 0,
    rms: sampleCount ? Math.round(Math.sqrt(sumSquares / sampleCount)) : 0,
    peak: peak2,
    clippedSampleRatio: sampleCount ? clipped / sampleCount : 0
  };
}
function rms(pcm) {
  const samples = pcm.length >> 1;
  if (samples === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples; i += 1) {
    const sample = pcm.readInt16LE(i * 2);
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples);
}
function peak(pcm) {
  const samples = pcm.length >> 1;
  let maximum = 0;
  for (let i = 0; i < samples; i += 1) {
    maximum = Math.max(maximum, Math.abs(pcm.readInt16LE(i * 2)));
  }
  return maximum;
}

// modules/module_02_speech_processing/src/config.ts
import "dotenv/config";
function loadModule2Config() {
  const provider = readEnum("SPEECH_PROVIDER", ["loopback", "whisper"], "loopback");
  const synthesisProvider = readEnum("SPEECH_SYNTHESIS_PROVIDER", ["loopback", "espeak"], "loopback");
  const minConfidence = readNumber("SPEECH_MIN_CONFIDENCE", VOICE_CONFIDENCE.DISCARD_BELOW);
  if (minConfidence < 0 || minConfidence > 1) {
    throw new Error(`SPEECH_MIN_CONFIDENCE must be between 0 and 1, received '${minConfidence}'.`);
  }
  const maxAudioBytes = readNumber("SPEECH_MAX_AUDIO_BYTES", 512e3);
  if (maxAudioBytes <= 0) {
    throw new Error(`SPEECH_MAX_AUDIO_BYTES must be positive, received '${maxAudioBytes}'.`);
  }
  const real = loadRealSpeechConfig(provider, synthesisProvider);
  return {
    speech: {
      provider,
      synthesisProvider,
      minConfidence,
      emitPartials: readString("SPEECH_EMIT_PARTIALS", "true") !== "false",
      maxAudioBytes,
      timeoutMs: readNumber("SPEECH_TIMEOUT_MS", 15e3),
      maxSynthesisChars: readNumber("SPEECH_MAX_SYNTHESIS_CHARS", 2e3),
      ...real ? { real } : {}
    }
  };
}
function loadRealSpeechConfig(provider, synthesisProvider) {
  const needsRealEngine = provider === "whisper" || synthesisProvider === "espeak";
  if (!needsRealEngine) return void 0;
  return {
    ffmpeg: readString("FFMPEG_BINARY", "ffmpeg"),
    whisper: provider === "whisper" ? {
      binary: readString("WHISPER_CPP_BINARY"),
      model: readString("WHISPER_CPP_MODEL"),
      threads: readNumber("WHISPER_CPP_THREADS", 4),
      language: readString("WHISPER_CPP_LANGUAGE", "auto")
    } : { binary: "", model: "", threads: 0, language: "auto" },
    espeak: synthesisProvider === "espeak" ? {
      binary: readString("ESPEAK_NG_BINARY", "espeak-ng"),
      voice: readString("ESPEAK_NG_VOICE", "en-gb"),
      speedWpm: readNumber("ESPEAK_NG_SPEED_WPM", 145)
    } : { binary: "", voice: "", speedWpm: 0 }
  };
}

// modules/module_02_speech_processing/src/speechService.ts
var SpeechService = class {
  constructor(deps) {
    this.deps = deps;
    this.logger = deps.logger ?? noopLogger;
  }
  logger;
  /**
   * Latest interim text per session, so the service can tell a caller what it
   * currently thinks it heard. Deliberately in-memory: interim guesses are not
   * evidence, and a restart must not resurrect them.
   */
  interim = /* @__PURE__ */ new Map();
  async transcribe(input) {
    const { callSessionId, emergencyId } = input;
    const isFinal = input.isFinal ?? true;
    const speaker = input.speaker ?? "CALLER";
    const session = await this.requireLiveSession(callSessionId, emergencyId);
    const language = await this.resolveLanguage(input.language ?? session.language, callSessionId, emergencyId);
    if (input.audio.length === 0) {
      await this.recordTranscriptionFailure({
        callSessionId,
        emergencyId,
        language,
        failureKind: "EMPTY_AUDIO",
        reason: "No audio was supplied."
      });
      throw new AppError(ErrorCode.SPEECH_TRANSCRIPTION_FAILED, "No audio was supplied for transcription.", 422, {
        callSessionId
      });
    }
    const maxBytes = this.deps.config.speech.maxAudioBytes;
    if (input.audio.length > maxBytes) {
      await this.recordTranscriptionFailure({
        callSessionId,
        emergencyId,
        language,
        failureKind: "INVALID_AUDIO",
        reason: `Audio is ${input.audio.length} bytes; the limit is ${maxBytes}.`
      });
      throw new AppError(
        ErrorCode.SPEECH_TRANSCRIPTION_FAILED,
        `Audio is ${input.audio.length} bytes, which exceeds the ${maxBytes} byte limit.`,
        413,
        { callSessionId, bytes: input.audio.length, limitBytes: maxBytes }
      );
    }
    let result;
    try {
      result = await this.deps.speech.transcribe({
        callSessionId,
        emergencyId,
        language,
        audio: input.audio,
        isFinal,
        ...session.isSimulation && input.diagnosticScope === "synthetic-test" ? {
          diagnosticScope: "synthetic-test",
          ...input.segmentDiagnostics ? { segmentDiagnostics: input.segmentDiagnostics } : {}
        } : {}
      });
    } catch (error) {
      const isLanguage = error instanceof AppError && error.code === ErrorCode.SPEECH_LANGUAGE_UNSUPPORTED;
      await this.recordTranscriptionFailure({
        callSessionId,
        emergencyId,
        language,
        failureKind: isLanguage ? "UNSUPPORTED_LANGUAGE" : "PROVIDER_ERROR",
        reason: error.message
      });
      throw error;
    }
    const band = confidenceBand(result.confidence, this.deps.config.speech.minConfidence);
    const base = {
      text: result.text,
      language: result.language,
      confidence: result.confidence,
      band,
      isFinal,
      provider: result.providerName,
      isLive: result.isLive
    };
    if (band === "UNUSABLE") {
      this.interim.delete(this.interimKey(callSessionId, speaker));
      await this.recordTranscriptionFailure({
        callSessionId,
        emergencyId,
        language,
        failureKind: "LOW_CONFIDENCE",
        reason: `Confidence ${result.confidence.toFixed(2)} is below the ${this.deps.config.speech.minConfidence} threshold.`
      });
      this.logger.warn(
        { callSessionId, emergencyId, confidence: result.confidence },
        "discarded a transcription below the confidence threshold"
      );
      return { ...base, text: "", persisted: null, accepted: false, notice: null };
    }
    if (!isFinal) {
      if (this.deps.config.speech.emitPartials) {
        this.interim.set(this.interimKey(callSessionId, speaker), result);
        await this.deps.events.record(
          defineEvent("TRANSCRIPT_PARTIAL", {
            emergencyId,
            entityType: "call_session",
            entityId: callSessionId,
            payload: {
              callSessionId,
              emergencyId,
              speaker,
              text: result.text,
              // Interim results have no sequence of their own: `sequence` belongs
              // to persisted utterances and a guess must not consume one.
              sequence: -1,
              provider: result.providerName
            }
          }),
          { emergencyId }
        );
      }
      return {
        ...base,
        persisted: null,
        accepted: true,
        notice: band === "LOW" ? "Low confidence: ask the caller to confirm." : null
      };
    }
    if (result.text.trim() === "") {
      this.interim.delete(this.interimKey(callSessionId, speaker));
      await this.recordTranscriptionFailure({
        callSessionId,
        emergencyId,
        language,
        failureKind: "EMPTY_AUDIO",
        reason: "The recogniser returned no text for a final result."
      });
      return { ...base, text: "", persisted: null, accepted: false, notice: null };
    }
    const persisted = await this.deps.calls.appendTranscript({
      callSessionId,
      emergencyId,
      speaker,
      text: result.text,
      isFinal: true,
      intent: input.intent ?? null,
      confidence: result.confidence,
      isSimulation: session.isSimulation
    });
    this.interim.delete(this.interimKey(callSessionId, speaker));
    this.logger.info(
      { callSessionId, emergencyId, confidence: result.confidence, band, provider: result.providerName },
      "transcribed and stored a final utterance"
    );
    return {
      ...base,
      persisted,
      accepted: true,
      notice: band === "LOW" ? "Low confidence: ask the caller to confirm." : null
    };
  }
  async speak(input) {
    const text = input.text.trim();
    const language = normaliseLanguageCode(input.language);
    const maxChars = this.deps.config.speech.maxSynthesisChars;
    if (text === "") {
      await this.recordSynthesisFailure(
        input,
        "PROVIDER_ERROR",
        "Refused to synthesize empty text."
      );
      throw new AppError(ErrorCode.SPEECH_SYNTHESIS_FAILED, "Cannot synthesize empty text.", 422);
    }
    if (text.length > maxChars) {
      await this.recordSynthesisFailure(
        input,
        "PROVIDER_ERROR",
        `Text is ${text.length} characters; the limit is ${maxChars}.`
      );
      throw new AppError(
        ErrorCode.SPEECH_SYNTHESIS_FAILED,
        `Text is ${text.length} characters, which exceeds the ${maxChars} character limit.`,
        413,
        { characters: text.length, limit: maxChars }
      );
    }
    if (!language) {
      await this.recordSynthesisFailure(
        input,
        "UNSUPPORTED_LANGUAGE",
        `'${input.language}' is not a language this build can speak.`
      );
      throw new AppError(
        ErrorCode.SPEECH_LANGUAGE_UNSUPPORTED,
        `'${input.language}' is not a language this build can speak. Supported: en, ml.`,
        422,
        { language: input.language }
      );
    }
    if (input.callSessionId) {
      await this.requireLiveSession(input.callSessionId, input.emergencyId ?? "");
    }
    let result;
    try {
      result = await this.deps.synthesis.synthesize({
        text,
        language,
        tone: input.tone,
        verbatimProtocolText: input.verbatimProtocolText
      });
    } catch (error) {
      const isLanguage = error instanceof AppError && error.code === ErrorCode.SPEECH_LANGUAGE_UNSUPPORTED;
      await this.recordSynthesisFailure(
        input,
        isLanguage ? "UNSUPPORTED_LANGUAGE" : "PROVIDER_ERROR",
        error.message
      );
      throw error;
    }
    await this.deps.events.record(
      defineEvent("SPEECH_SYNTHESIZED", {
        emergencyId: input.emergencyId ?? null,
        entityType: "call_session",
        entityId: input.callSessionId ?? null,
        payload: {
          callSessionId: input.callSessionId ?? "",
          emergencyId: input.emergencyId ?? "",
          provider: result.providerName,
          voice: result.voice,
          language,
          characterCount: text.length,
          // The record states whether the caller heard the catalogue's own words
          // or an approved paraphrase.
          verbatimProtocolText: input.verbatimProtocolText
        }
      }),
      { emergencyId: input.emergencyId ?? null }
    );
    const isAudible = result.audio.length > 0;
    if (!isAudible) {
      this.logger.warn(
        { provider: result.providerName, language, characters: text.length },
        "provider returned no playable audio"
      );
    }
    return {
      audio: result.audio,
      mimeType: result.mimeType,
      provider: result.providerName,
      isLive: result.isLive,
      voice: result.voice,
      durationMs: result.durationMs,
      characterCount: text.length,
      isAudible,
      verbatimProtocolText: input.verbatimProtocolText
    };
  }
  /** Latest interim text for a session, or null when there is none. */
  pendingPartial(callSessionId, speaker = "CALLER") {
    return this.interim.get(this.interimKey(callSessionId, speaker))?.text ?? null;
  }
  /** Provider identity for the health endpoint. Never claims to be live. */
  status() {
    return {
      speech: {
        provider: this.deps.speech.providerName,
        isLive: this.deps.speech.isLive,
        languages: this.deps.speech.supportedLanguages
      },
      synthesis: {
        provider: this.deps.synthesis.providerName,
        isLive: this.deps.synthesis.isLive,
        languages: this.deps.synthesis.supportedLanguages
      },
      minConfidence: this.deps.config.speech.minConfidence
    };
  }
  // -- internals --------------------------------------------------------------
  requireLiveSession(callSessionId, emergencyId) {
    return this.deps.calls.sessionById(callSessionId).then((session) => {
      if (!session) {
        throw new AppError(ErrorCode.CALL_NOT_FOUND, `Call session '${callSessionId}' was not found.`, 404, {
          callSessionId
        });
      }
      if (session.status !== "ACTIVE") {
        throw new AppError(
          ErrorCode.CONVERSATION_CLOSED,
          `Call session '${callSessionId}' has ended; its speech cannot be processed.`,
          409,
          { callSessionId, status: session.status }
        );
      }
      if (emergencyId && session.emergencyId !== emergencyId) {
        throw new AppError(
          ErrorCode.VALIDATION_ERROR,
          `Call session '${callSessionId}' belongs to emergency '${session.emergencyId}', not '${emergencyId}'.`,
          409,
          { callSessionId, sessionEmergencyId: session.emergencyId, requestedEmergencyId: emergencyId }
        );
      }
      return session;
    });
  }
  /**
   * Normalises the requested language, recording a failure before rejecting it.
   *
   * This runs before the provider, so if it simply threw, an unsupported language
   * would leave no trace: every other transcription failure is on the timeline and
   * this one would not be. The gap would look like a client that never spoke.
   */
  async resolveLanguage(language, callSessionId, emergencyId) {
    const normalised = normaliseLanguageCode(language);
    if (normalised) return normalised;
    await this.recordTranscriptionFailure({
      callSessionId,
      emergencyId,
      language,
      failureKind: "UNSUPPORTED_LANGUAGE",
      reason: `'${language}' is not supported; expected en or ml.`
    });
    throw new AppError(
      ErrorCode.SPEECH_LANGUAGE_UNSUPPORTED,
      `'${language}' is not a language this build can transcribe. Supported: en, ml.`,
      422,
      { language }
    );
  }
  interimKey(callSessionId, speaker) {
    return `${callSessionId}:${speaker}`;
  }
  /**
   * Records a transcription failure.
   *
   * Best-effort by design: the caller is about to receive an error, and a failure
   * to write the timeline entry must not replace it with a confusing database
   * fault. The reason is logged when the record itself fails.
   */
  async recordTranscriptionFailure(failure) {
    await this.deps.events.record(
      defineEvent("SPEECH_TRANSCRIPTION_FAILED", {
        emergencyId: failure.emergencyId,
        entityType: "call_session",
        entityId: failure.callSessionId,
        payload: {
          callSessionId: failure.callSessionId,
          emergencyId: failure.emergencyId,
          provider: this.deps.speech.providerName,
          language: failure.language,
          failureKind: failure.failureKind,
          reason: failure.reason
        }
      }),
      { emergencyId: failure.emergencyId }
    ).catch((error) => {
      this.logger.error(
        {
          callSessionId: failure.callSessionId,
          emergencyId: failure.emergencyId,
          reason: error.message
        },
        "could not record SPEECH_TRANSCRIPTION_FAILED"
      );
    });
  }
  async recordSynthesisFailure(input, failureKind, reason) {
    await this.deps.events.record(
      defineEvent("SPEECH_SYNTHESIS_FAILED", {
        emergencyId: input.emergencyId ?? null,
        entityType: "call_session",
        entityId: input.callSessionId ?? null,
        payload: {
          callSessionId: input.callSessionId ?? null,
          emergencyId: input.emergencyId ?? null,
          provider: this.deps.synthesis.providerName,
          language: input.language,
          failureKind,
          reason,
          characterCount: input.text.trim().length
        }
      }),
      { emergencyId: input.emergencyId ?? null }
    ).catch((error) => {
      this.logger.error(
        { reason: error.message },
        "could not record SPEECH_SYNTHESIS_FAILED"
      );
    });
  }
};

// modules/module_02_speech_processing/src/api/routes.ts
import { z as z5 } from "zod";
var transcribeQuery = z5.object({
  callSessionId: z5.string().min(1),
  emergencyId: z5.string().min(1),
  language: z5.string().max(8).optional(),
  speaker: z5.enum(["CALLER", "BYSTANDER", "OPERATOR"]).optional(),
  isFinal: z5.enum(["true", "false"]).optional()
});
var speakSchema = z5.object({
  emergencyId: z5.string().min(1).nullable().optional(),
  callSessionId: z5.string().min(1).nullable().optional(),
  text: z5.string().min(1).max(4e3),
  language: z5.string().min(2).max(8),
  tone: z5.enum(["CALM", "URGENT", "REASSURING"]),
  // Required, not defaulted: the record must state whether this is the
  // catalogue's own wording or an approved paraphrase.
  verbatimProtocolText: z5.boolean()
});
function createModule2Routes(service) {
  return [
    {
      method: "POST",
      url: "/speech/transcribe",
      module: "module_02",
      summary: "Transcribe caller audio; final results are stored, interim results are not",
      auth: { roles: ["CALL_CENTRE", "OPERATOR", "ADMIN"] },
      // Metadata is a query schema rather than a body schema because the body is
      // raw audio: the route adapter hands `body` to Fastify for validation, so
      // declaring one here would reject every binary payload.
      query: transcribeQuery,
      handler: async (request, reply) => {
        const query = request.query;
        const audio = readAudioBody(request.body);
        const result = await service.transcribe({
          callSessionId: query.callSessionId,
          emergencyId: query.emergencyId,
          audio,
          language: query.language,
          speaker: query.speaker,
          isFinal: query.isFinal === void 0 ? true : query.isFinal === "true"
        });
        reply.status(result.accepted ? 200 : 202).send(result);
      }
    },
    {
      method: "POST",
      url: "/speech/speak",
      module: "module_02",
      summary: "Synthesize text to speech for a caller",
      auth: { roles: ["CALL_CENTRE", "OPERATOR", "ADMIN"] },
      body: speakSchema,
      handler: async (request, reply) => {
        const input = request.body;
        const result = await service.speak(input);
        reply.status(200).send(result);
      }
    },
    {
      method: "GET",
      url: "/speech/status",
      module: "module_02",
      summary: "Report the speech and synthesis providers, and whether they are live",
      auth: { public: true },
      handler: async (_request, reply) => {
        reply.send(service.status());
      }
    },
    {
      method: "GET",
      url: "/speech/partial/:callSessionId",
      module: "module_02",
      summary: "Read the latest interim transcription for a call",
      auth: { roles: ["CALL_CENTRE", "OPERATOR", "ADMIN"] },
      params: z5.object({ callSessionId: z5.string().min(1) }),
      handler: async (request, reply) => {
        const { callSessionId } = request.params;
        const speaker = String(request.query.speaker ?? "CALLER");
        reply.send({ callSessionId, speaker, text: service.pendingPartial(callSessionId, speaker) });
      }
    }
  ];
}
function readAudioBody(body) {
  if (body instanceof Uint8Array) return body;
  if (Buffer.isBuffer(body)) return new Uint8Array(body);
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body && typeof body === "object") {
    const audio = body.audio;
    if (typeof audio === "string") {
      try {
        return new Uint8Array(Buffer.from(audio, "base64"));
      } catch {
        return new Uint8Array(0);
      }
    }
  }
  return new Uint8Array(0);
}

// modules/module_02_speech_processing/src/providers/loopbackProviders.ts
var UTF8 = new TextEncoder();
var LoopbackSpeechProvider = class {
  constructor(options = {}) {
    this.options = options;
  }
  providerName = "loopback";
  isLive = false;
  supportedLanguages = ["en", "ml"];
  async transcribe(request) {
    if (this.options.failWith) {
      throw new AppError(ErrorCode.PROVIDER_UNAVAILABLE, this.options.failWith, 503, {
        provider: this.providerName
      });
    }
    if (!this.supportedLanguages.includes(request.language)) {
      throw new AppError(
        ErrorCode.SPEECH_LANGUAGE_UNSUPPORTED,
        `The '${this.providerName}' provider cannot transcribe '${request.language}'. Supported: ${this.supportedLanguages.join(", ")}.`,
        422,
        { provider: this.providerName, language: request.language }
      );
    }
    let text = this.options.scripted?.[request.callSessionId] ?? "";
    if (text === "") {
      try {
        text = readAudioCarrier(request.audio);
      } catch {
        text = "";
      }
    }
    return {
      text,
      language: request.language,
      // A development adapter has no acoustic evidence, so it reports the
      // configured default rather than a number implying measurement.
      confidence: this.options.confidence ?? VOICE_CONFIDENCE.HIGH,
      isFinal: request.isFinal,
      providerName: this.providerName,
      isLive: false,
      unclearSpans: []
    };
  }
};
var LoopbackSynthesisProvider = class {
  constructor(options = {}) {
    this.options = options;
  }
  providerName = "loopback";
  isLive = false;
  supportedLanguages = ["en", "ml"];
  async synthesize(request) {
    if (this.options.failWith) {
      throw new AppError(ErrorCode.PROVIDER_UNAVAILABLE, this.options.failWith, 503, {
        provider: this.providerName
      });
    }
    if ((this.options.unsupportedLanguages ?? []).includes(request.language) || !this.supportedLanguages.includes(request.language)) {
      throw new AppError(
        ErrorCode.SPEECH_LANGUAGE_UNSUPPORTED,
        `The '${this.providerName}' provider cannot speak '${request.language}'. Supported: ${this.supportedLanguages.join(", ")}.`,
        422,
        { provider: this.providerName, language: request.language }
      );
    }
    return {
      // No audio. An empty buffer and a null duration say "nothing was played"
      // rather than "something was played that happens to be silent".
      audio: new Uint8Array(0),
      mimeType: "application/octet-stream",
      providerName: this.providerName,
      isLive: false,
      voice: this.options.voice ?? "loopback-none",
      durationMs: null
    };
  }
};
function readAudioCarrier(audio) {
  return new TextDecoder().decode(audio);
}

// modules/module_02_speech_processing/src/providers/whisperProvider.ts
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// modules/module_02_speech_processing/src/providers/audioFormat.ts
var MIN_I16 = -32768;
var MAX_I16 = 32767;
function looksLikeWav(buffer) {
  return buffer.length >= 12 && buffer[0] === 82 && buffer[1] === 73 && buffer[2] === 70 && buffer[3] === 70 && buffer[8] === 87 && buffer[9] === 65 && buffer[10] === 86 && buffer[11] === 69;
}
function decodeAudio(buffer, assumedSampleRate = 8e3) {
  if (!looksLikeWav(buffer)) {
    return { pcm: int16FromBytes(buffer, 0, buffer.length), sampleRate: assumedSampleRate, channels: 1, bitsPerSample: 16 };
  }
  return decodeWav(buffer);
}
function decodeWav(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (view.byteLength < 44) throw new Error("WAV buffer is shorter than a 44-byte header.");
  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let dataStart = -1;
  let dataLength = 0;
  while (offset + 8 <= view.byteLength) {
    const chunkId = String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
    const chunkSize = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (chunkId === "fmt ") {
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
    } else if (chunkId === "data") {
      dataStart = body;
      dataLength = Math.min(chunkSize, view.byteLength - body);
    }
    offset = body + chunkSize + chunkSize % 2;
    if (dataStart !== -1 && sampleRate !== 0) break;
  }
  if (dataStart === -1) throw new Error("WAV buffer contains no data chunk.");
  if (sampleRate === 0 || channels === 0) throw new Error("WAV buffer has an unusable format chunk.");
  if (bitsPerSample !== 16) {
    throw new Error(`WAV must be 16-bit; received ${bitsPerSample}-bit audio.`);
  }
  const interleaved = int16FromBytes(new Uint8Array(view.buffer, view.byteOffset + dataStart, dataLength), 0, dataLength);
  const pcm = channels === 1 ? interleaved : downmixToMono(interleaved, channels);
  return { pcm, sampleRate, channels, bitsPerSample };
}
function int16FromBytes(bytes, start, length) {
  const usable = Math.max(0, length - length % 2);
  const out = new Int16Array(usable / 2);
  for (let i = 0; i < out.length; i += 1) {
    const at = start + i * 2;
    out[i] = bytes[at] | bytes[at + 1] << 8;
  }
  return out;
}
function downmixToMono(interleaved, channels) {
  if (channels <= 1) return interleaved;
  const frames = Math.floor(interleaved.length / channels);
  const out = new Int16Array(frames);
  for (let i = 0; i < frames; i += 1) {
    let sum = 0;
    for (let c = 0; c < channels; c += 1) sum += interleaved[i * channels + c] ?? 0;
    out[i] = clampI16(Math.round(sum / channels));
  }
  return out;
}
function resampleMono16(input, fromRate, toRate) {
  if (fromRate <= 0 || toRate <= 0) {
    throw new Error(`Sample rates must be positive; received ${fromRate} -> ${toRate}.`);
  }
  if (fromRate === toRate || input.length === 0) return input;
  const ratio = fromRate / toRate;
  const outLength = Math.max(1, Math.round(input.length * toRate / fromRate));
  const out = new Int16Array(outLength);
  if (toRate < fromRate) {
    for (let i = 0; i < outLength; i += 1) {
      const start = Math.floor(i * ratio);
      const end = Math.max(start, Math.ceil((i + 1) * ratio) - 1);
      let sum = 0;
      let count = 0;
      for (let j = start; j <= end && j < input.length; j += 1) {
        sum += input[j];
        count += 1;
      }
      out[i] = count > 0 ? clampI16(Math.round(sum / count)) : 0;
    }
    return out;
  }
  for (let i = 0; i < outLength; i += 1) {
    const position = i * ratio;
    const index = Math.floor(position);
    const fraction = position - index;
    const a = input[index] ?? 0;
    const b = input[index + 1] ?? a;
    out[i] = clampI16(Math.round(a + (b - a) * fraction));
  }
  return out;
}
function encodeWav(pcm, sampleRate) {
  const dataSize = pcm.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < pcm.length; i += 1) {
    const sample = pcm[i];
    bytes[44 + i * 2] = sample & 255;
    bytes[44 + i * 2 + 1] = sample >> 8 & 255;
  }
  return bytes;
}
function toMonoSlin(audio, toRate) {
  return resampleMono16(audio.pcm, audio.sampleRate, toRate);
}
function writeAscii(view, offset, text) {
  for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
}
function clampI16(value) {
  if (value < MIN_I16) return MIN_I16;
  if (value > MAX_I16) return MAX_I16;
  return value;
}
function durationMs(pcm, sampleRate) {
  if (sampleRate <= 0 || pcm.length === 0) return 0;
  return Math.round(pcm.length / sampleRate * 1e3);
}

// modules/module_02_speech_processing/src/providers/subprocess.ts
import { spawn } from "node:child_process";
function runProcess(binary, args, options) {
  const maxBufferBytes = options.maxBufferBytes ?? 4 * 1024 * 1024;
  return new Promise((resolve2, reject) => {
    let child;
    try {
      child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      reject(unavailable(binary, `could not be started: ${error.message}`));
      return;
    }
    const stdout = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(unavailable(binary, `did not finish within ${options.timeoutMs} ms`));
    }, options.timeoutMs);
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= maxBufferBytes) stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
    child.on("error", (error) => {
      finish(() => reject(unavailable(binary, `could not be run: ${error.message}`)));
    });
    child.on("close", (code) => {
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      finish(() => {
        if (code !== 0) {
          reject(unavailable(binary, `exited with code ${code}${stderr ? `: ${stderr}` : ""}`));
          return;
        }
        resolve2({ stdout: Buffer.concat(stdout), stderr, code: code ?? 0 });
      });
    });
    child.stdin.on("error", () => void 0);
    if (options.stdin !== void 0) child.stdin.write(options.stdin);
    child.stdin.end();
  });
}
function unavailable(binary, detail) {
  return new AppError(
    ErrorCode.PROVIDER_UNAVAILABLE,
    `The speech engine '${binary}' ${detail}`,
    503,
    { engine: binary }
  );
}

// modules/module_02_speech_processing/src/providers/whisperProvider.ts
var NO_SCORE_CONFIDENCE = 0.2;
var WHISPER_SAMPLE_RATE = 16e3;
var WhisperSpeechProvider = class {
  constructor(options) {
    this.options = options;
    this.logger = options.logger ?? noopLogger;
  }
  providerName = "whisper";
  isLive = true;
  supportedLanguages = ["en", "ml"];
  logger;
  async transcribe(request) {
    if (!this.supportedLanguages.includes(request.language)) {
      throw new AppError(
        ErrorCode.SPEECH_LANGUAGE_UNSUPPORTED,
        `The '${this.providerName}' provider cannot transcribe '${request.language}'. Supported: ${this.supportedLanguages.join(", ")}.`,
        422,
        { provider: this.providerName, language: request.language }
      );
    }
    if (request.audio.length === 0) {
      safeDiagnosticInfo2(
        this.logger,
        {
          callSessionId: request.callSessionId,
          emergencyId: request.emergencyId,
          scope: request.diagnosticScope,
          ...request.segmentDiagnostics ?? {},
          inputBytes: 0,
          preprocessingOutcome: "failed",
          failureKind: "empty-audio",
          preprocessingDurationMs: 0
        },
        request.diagnosticScope === "synthetic-test" ? "synthetic test Whisper preprocessing diagnostics" : "",
        request.diagnosticScope === "synthetic-test"
      );
      throw new AppError(ErrorCode.SPEECH_TRANSCRIPTION_FAILED, "No audio was supplied for transcription.", 422, {
        provider: this.providerName
      });
    }
    const language = this.options.language === "auto" ? request.language : this.options.language;
    const preprocessingStartedAt = Date.now();
    let audio;
    let resampled;
    let wav;
    try {
      audio = decodeAudio(request.audio);
      resampled = resampleMono16(audio.pcm, audio.sampleRate, WHISPER_SAMPLE_RATE);
      if (resampled.length === 0) {
        safeDiagnosticInfo2(
          this.logger,
          {
            callSessionId: request.callSessionId,
            emergencyId: request.emergencyId,
            scope: request.diagnosticScope,
            ...request.segmentDiagnostics ?? {},
            inputBytes: request.audio.length,
            sourceSampleRate: audio.sampleRate,
            sourceChannels: audio.channels,
            sourceBitsPerSample: audio.bitsPerSample,
            decodedSampleCount: audio.pcm.length,
            targetSampleRate: WHISPER_SAMPLE_RATE,
            resampledSampleCount: 0,
            preprocessingOutcome: "empty-output",
            preprocessingDurationMs: Date.now() - preprocessingStartedAt
          },
          "synthetic test Whisper preprocessing diagnostics",
          request.diagnosticScope === "synthetic-test"
        );
        return {
          text: "",
          language: request.language,
          confidence: 0,
          isFinal: request.isFinal,
          providerName: this.providerName,
          isLive: this.isLive,
          unclearSpans: []
        };
      }
      wav = encodeWav(resampled, WHISPER_SAMPLE_RATE);
    } catch (error) {
      safeDiagnosticInfo2(
        this.logger,
        {
          callSessionId: request.callSessionId,
          emergencyId: request.emergencyId,
          scope: request.diagnosticScope,
          ...request.segmentDiagnostics ?? {},
          inputBytes: request.audio.length,
          preprocessingOutcome: "failed",
          failureKind: "invalid-or-unsupported-audio",
          preprocessingDurationMs: Date.now() - preprocessingStartedAt
        },
        "synthetic test Whisper preprocessing diagnostics",
        request.diagnosticScope === "synthetic-test"
      );
      throw error;
    }
    let workDir;
    try {
      workDir = await fs.mkdtemp(path.join(os.tmpdir(), "resus-whisper-"));
    } catch (error) {
      safeDiagnosticInfo2(
        this.logger,
        {
          callSessionId: request.callSessionId,
          emergencyId: request.emergencyId,
          scope: request.diagnosticScope,
          ...request.segmentDiagnostics ?? {},
          inputBytes: request.audio.length,
          preprocessingOutcome: "failed",
          failureKind: "temporary-directory-create-failed",
          preprocessingDurationMs: Date.now() - preprocessingStartedAt
        },
        "synthetic test Whisper preprocessing diagnostics",
        request.diagnosticScope === "synthetic-test"
      );
      throw error;
    }
    try {
      const wavPath = path.join(workDir, "audio.wav");
      try {
        await fs.writeFile(wavPath, wav);
      } catch (error) {
        safeDiagnosticInfo2(
          this.logger,
          {
            callSessionId: request.callSessionId,
            emergencyId: request.emergencyId,
            scope: request.diagnosticScope,
            ...request.segmentDiagnostics ?? {},
            inputBytes: request.audio.length,
            sourceSampleRate: audio.sampleRate,
            sourceChannels: audio.channels,
            sourceBitsPerSample: audio.bitsPerSample,
            decodedSampleCount: audio.pcm.length,
            targetSampleRate: WHISPER_SAMPLE_RATE,
            resampledSampleCount: resampled.length,
            wavBytes: wav.length,
            preprocessingOutcome: "failed",
            failureKind: "temporary-wav-write-failed",
            preprocessingDurationMs: Date.now() - preprocessingStartedAt
          },
          "synthetic test Whisper preprocessing diagnostics",
          request.diagnosticScope === "synthetic-test"
        );
        throw error;
      }
      safeDiagnosticInfo2(
        this.logger,
        {
          callSessionId: request.callSessionId,
          emergencyId: request.emergencyId,
          scope: request.diagnosticScope,
          ...request.segmentDiagnostics ?? {},
          inputBytes: request.audio.length,
          sourceSampleRate: audio.sampleRate,
          sourceChannels: audio.channels,
          sourceBitsPerSample: audio.bitsPerSample,
          decodedSampleCount: audio.pcm.length,
          targetSampleRate: WHISPER_SAMPLE_RATE,
          resampledSampleCount: resampled.length,
          wavBytes: wav.length,
          format: "mono-signed-int16-pcm-wav",
          preprocessingOutcome: "prepared",
          preprocessingDurationMs: Date.now() - preprocessingStartedAt
        },
        "synthetic test Whisper preprocessing diagnostics",
        request.diagnosticScope === "synthetic-test"
      );
      const argsWith = (jsonFlag) => [
        "-m",
        this.options.model,
        "-f",
        wavPath,
        "-t",
        String(Math.max(1, this.options.threads)),
        "-l",
        language,
        jsonFlag,
        "-nt"
      ];
      const whisperStartedAt = Date.now();
      let parsed;
      try {
        try {
          await runProcess(this.options.binary, argsWith("-ojf"), { timeoutMs: this.options.timeoutMs });
        } catch {
          await runProcess(this.options.binary, argsWith("-oj"), { timeoutMs: this.options.timeoutMs });
        }
        const raw = await readWhisperJson([`${wavPath}.json`, wavPath.replace(/\.wav$/, ".json")]);
        parsed = parseWhisperJson(raw);
      } catch (error) {
        safeDiagnosticInfo2(
          this.logger,
          {
            callSessionId: request.callSessionId,
            emergencyId: request.emergencyId,
            scope: request.diagnosticScope,
            ...request.segmentDiagnostics ?? {},
            inferenceOutcome: "failed",
            whisperInvocationMs: Date.now() - whisperStartedAt
          },
          "synthetic test Whisper invocation diagnostics",
          request.diagnosticScope === "synthetic-test"
        );
        throw error;
      }
      safeDiagnosticInfo2(
        this.logger,
        {
          callSessionId: request.callSessionId,
          emergencyId: request.emergencyId,
          scope: request.diagnosticScope,
          ...request.segmentDiagnostics ?? {},
          inferenceOutcome: "completed",
          whisperInvocationMs: Date.now() - whisperStartedAt,
          transcriptCharacters: parsed.text.length,
          confidence: parsed.confidence
        },
        "synthetic test Whisper invocation diagnostics",
        request.diagnosticScope === "synthetic-test"
      );
      return {
        text: parsed.text,
        language: request.language,
        confidence: parsed.confidence,
        isFinal: request.isFinal,
        providerName: this.providerName,
        isLive: this.isLive,
        unclearSpans: []
      };
    } finally {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => void 0);
    }
  }
};
function safeDiagnosticInfo2(logger2, fields, message, enabled) {
  if (!enabled) return;
  try {
    logger2.info(fields, message);
  } catch {
  }
}
async function readWhisperJson(candidates) {
  let lastError;
  for (const candidate of candidates) {
    try {
      return await fs.readFile(candidate, "utf8");
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
function parseWhisperJson(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new AppError(
      ErrorCode.PROVIDER_UNAVAILABLE,
      "whisper.cpp produced output that was not valid JSON; the transcript cannot be read.",
      503,
      { provider: "whisper" }
    );
  }
  const root = data ?? {};
  const segments = [];
  const transcription = Array.isArray(root.transcription) ? root.transcription : [];
  for (const entry of transcription) {
    if (typeof entry.text === "string") segments.push(entry);
    const inner = Array.isArray(entry.segments) ? entry.segments : [];
    for (const segment of inner) segments.push(segment);
  }
  const text = transcriptText(transcription, segments);
  if (text.trim() === "") return { text: "", confidence: 0 };
  const scores = segments.map((segment) => scoreOf(segment)).filter((value) => value !== null);
  if (scores.length === 0) {
    return { text: text.trim(), confidence: NO_SCORE_CONFIDENCE };
  }
  const average = scores.reduce((sum, value) => sum + value, 0) / scores.length;
  return { text: text.trim(), confidence: Math.min(1, Math.max(0, average)) };
}
function scoreOf(segment) {
  const tokens = Array.isArray(segment.tokens) ? segment.tokens : [];
  const tokenScores = tokens.map((token) => typeof token.p === "number" ? token.p : null).filter((value) => value !== null);
  const hasNoSpeechProb = typeof segment.no_speech_prob === "number";
  const noSpeechProb = hasNoSpeechProb ? segment.no_speech_prob : 0;
  const speechWeight = Math.min(1, Math.max(0, 1 - noSpeechProb));
  if (tokenScores.length > 0) {
    const mean = tokenScores.reduce((sum, value) => sum + value, 0) / tokenScores.length;
    return clamp01(mean * speechWeight);
  }
  if (typeof segment.avg_logprob === "number") {
    return clamp01(Math.exp(segment.avg_logprob) * speechWeight);
  }
  if (hasNoSpeechProb) {
    return clamp01(1 - noSpeechProb);
  }
  return null;
}
function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
function transcriptText(transcription, segments) {
  const topLevel = transcription[0]?.text;
  if (typeof topLevel === "string" && topLevel.trim() !== "") return topLevel;
  return segments.map((segment) => typeof segment.text === "string" ? segment.text : "").join("");
}

// modules/module_02_speech_processing/src/providers/espeakProvider.ts
import { promises as fs2 } from "node:fs";
import os2 from "node:os";
import path2 from "node:path";
var OUTPUT_SAMPLE_RATE = 8e3;
var EspeakSynthesisProvider = class {
  constructor(options) {
    this.options = options;
    this.logger = options.logger ?? noopLogger;
  }
  providerName = "espeak";
  isLive = true;
  supportedLanguages = ["en", "ml"];
  logger;
  async synthesize(request) {
    if (!this.supportedLanguages.includes(request.language)) {
      throw new AppError(
        ErrorCode.SPEECH_LANGUAGE_UNSUPPORTED,
        `The '${this.providerName}' provider cannot speak '${request.language}'. Supported: ${this.supportedLanguages.join(", ")}.`,
        422,
        { provider: this.providerName, language: request.language }
      );
    }
    const text = request.text.trim();
    if (text === "") {
      throw new AppError(ErrorCode.SPEECH_SYNTHESIS_FAILED, "Cannot synthesize empty text.", 422, {
        provider: this.providerName
      });
    }
    const voice = this.voiceFor(request.language);
    const delivery = this.deliveryFor(request.tone);
    const workDir = await fs2.mkdtemp(path2.join(os2.tmpdir(), "resus-espeak-"));
    try {
      const textPath = path2.join(workDir, "text.txt");
      const wavPath = path2.join(workDir, "audio.wav");
      await fs2.writeFile(textPath, text, "utf8");
      await runProcess(
        this.options.binary,
        [
          "-v",
          voice,
          "-s",
          String(delivery.speedWpm),
          "-p",
          String(delivery.pitch),
          "-a",
          String(delivery.amplitude),
          "-f",
          textPath,
          "-w",
          wavPath
        ],
        { timeoutMs: this.options.timeoutMs }
      );
      const wav = await fs2.readFile(wavPath);
      const decoded = decodeAudio(new Uint8Array(wav));
      const pcm = toMonoSlin(decoded, OUTPUT_SAMPLE_RATE);
      if (pcm.length === 0) {
        throw new AppError(
          ErrorCode.SPEECH_SYNTHESIS_FAILED,
          `The '${this.options.binary}' engine produced no audio samples.`,
          502,
          { provider: this.providerName }
        );
      }
      const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
      this.logger.debug(
        { voice, tone: request.tone, samples: pcm.length, durationMs: durationMs(pcm, OUTPUT_SAMPLE_RATE) },
        "synthesized call audio"
      );
      return {
        audio: bytes.slice(),
        mimeType: `audio/L16;rate=${OUTPUT_SAMPLE_RATE};channels=1`,
        providerName: this.providerName,
        isLive: this.isLive,
        voice,
        durationMs: durationMs(pcm, OUTPUT_SAMPLE_RATE)
      };
    } finally {
      await fs2.rm(workDir, { recursive: true, force: true }).catch(() => void 0);
    }
  }
  /**
   * Maps the system's language codes onto espeak-ng voice names.
   *
   * Malayalam has a dedicated voice; English uses the configured regional voice,
   * because a Kerala deployment that reads an English prompt in an American
   * accent is a correctness choice someone should make in configuration, not have
   * silently decided here.
   */
  voiceFor(language) {
    return language === "ml" ? "ml" : this.options.voice;
  }
  /** Translates the port's tone into real delivery parameters. */
  deliveryFor(tone) {
    return espeakDeliveryFor(this.options.speedWpm, tone);
  }
};
function espeakDeliveryFor(speedWpm, tone) {
  switch (tone) {
    case "URGENT":
      return { speedWpm, pitch: 65, amplitude: 130 };
    case "REASSURING":
      return { speedWpm: Math.max(80, speedWpm - 10), pitch: 38, amplitude: 95 };
    case "CALM":
    default:
      return { speedWpm, pitch: 50, amplitude: 110 };
  }
}

// modules/module_02_speech_processing/src/module.ts
function createSpeechProvider(config, logger2) {
  if (config.speech.provider === "whisper") {
    const real = config.speech.real;
    if (!real) {
      throw new Error(
        'SPEECH_PROVIDER="whisper" needs WHISPER_CPP_BINARY and WHISPER_CPP_MODEL; neither could be resolved.'
      );
    }
    return new WhisperSpeechProvider({
      binary: real.whisper.binary,
      model: real.whisper.model,
      threads: real.whisper.threads,
      language: real.whisper.language,
      timeoutMs: config.speech.timeoutMs,
      logger: logger2
    });
  }
  return new LoopbackSpeechProvider();
}
function createSynthesisProvider(config, logger2) {
  if (config.speech.synthesisProvider === "espeak") {
    const real = config.speech.real;
    if (!real) {
      throw new Error('SPEECH_SYNTHESIS_PROVIDER="espeak" needs its engine configuration to be resolvable.');
    }
    return new EspeakSynthesisProvider({
      binary: real.espeak.binary,
      voice: real.espeak.voice,
      speedWpm: real.espeak.speedWpm,
      timeoutMs: config.speech.timeoutMs,
      logger: logger2
    });
  }
  return new LoopbackSynthesisProvider();
}
var Module2 = class {
  speech;
  recognitionProvider;
  synthesisProvider;
  config;
  logger;
  constructor(deps) {
    this.config = deps.config ?? loadModule2Config();
    this.logger = deps.logger ?? noopLogger;
    this.recognitionProvider = deps.speech ?? createSpeechProvider(this.config, this.logger);
    this.synthesisProvider = deps.synthesis ?? createSynthesisProvider(this.config, this.logger);
    this.speech = new SpeechService({
      config: this.config,
      speech: this.recognitionProvider,
      synthesis: this.synthesisProvider,
      calls: deps.calls,
      events: deps.events,
      logger: this.logger
    });
  }
  routes() {
    return createModule2Routes(this.speech);
  }
  register(table) {
    table.addAll(this.routes());
  }
};

// modules/module_05_bystander_assistance/src/config.ts
function num(value, fallback2) {
  if (value === void 0 || value === "") return fallback2;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback2;
}
function bool(value, fallback2) {
  if (value === void 0 || value === "") return fallback2;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}
function loadModule5Config(env = process.env) {
  const provider = env.LLM_PROVIDER?.trim() || "ollama";
  const model = env.LLM_MODEL?.trim();
  if (provider === "ollama" && !model) {
    throw new AppError(
      ErrorCode.LLM_MODEL_NOT_FOUND,
      'LLM_MODEL is required when LLM_PROVIDER is "ollama". Set it in .env (see scripts/setup-ollama.ps1).',
      500
    );
  }
  return {
    llm: {
      provider,
      model: model ?? "",
      ollamaBaseUrl: env.OLLAMA_BASE_URL?.trim() || "http://127.0.0.1:11434",
      timeoutMs: num(env.LLM_TIMEOUT_MS, 2e4),
      temperature: num(env.LLM_TEMPERATURE, 0.1),
      numCtx: num(env.LLM_NUM_CTX, 4096),
      allowHeuristicFallback: bool(env.LLM_ALLOW_HEURISTIC_FALLBACK, true)
    },
    protocol: {
      directory: env.PROTOCOL_DIR?.trim() || "modules/module_05_bystander_assistance/protocols"
    },
    // `PROTOCOL_MAX_CLARIFICATIONS` is the documented name; the shorter
    // spelling is accepted so either form in an existing .env takes effect
    // rather than silently reverting to the default.
    clarificationLimit: num(
      env.PROTOCOL_MAX_CLARIFICATIONS ?? env.PROTOCOL_CLARIFICATION_LIMIT,
      3
    )
  };
}

// modules/module_05_bystander_assistance/src/api/routes.ts
import { z as z6 } from "zod";
var startSessionBody = z6.object({
  emergencyId: z6.string().min(1).max(64),
  /** Omit to auto-select a protocol from `incidentType`. */
  protocolId: z6.string().min(1).max(64).optional(),
  version: z6.string().min(1).max(32).optional(),
  incidentType: z6.string().min(1).max(64).optional(),
  startedBy: z6.string().max(64).optional()
}).strict().refine((body) => Boolean(body.protocolId || body.incidentType), {
  message: "Either protocolId or incidentType is required.",
  path: ["protocolId"]
});
var utteranceBody = z6.object({
  utterance: z6.string().min(1).max(2e3)
}).strict();
var cancelBody = z6.object({
  reason: z6.string().max(500).default("Cancelled by operator.")
});
var escalateBody = z6.object({
  reason: z6.string().min(1).max(500)
});
var OPERATOR = ["OPERATOR", "DISPATCHER", "CLINICAL_SUPERVISOR", "ADMIN"];
function createModule5Routes(module5) {
  const { sessions } = module5;
  return [
    {
      method: "GET",
      url: "/api/protocols",
      module: "module_05",
      summary: "List every protocol in the versioned catalogue",
      auth: { public: true },
      handler: (_request, reply) => reply.send({ protocols: sessions.listProtocols() })
    },
    {
      method: "GET",
      url: "/api/protocols/:incidentType",
      module: "module_05",
      summary: "Protocols applicable to one incident type",
      auth: { public: true },
      handler: async (request, reply) => reply.send({
        incidentType: String(request.params.incidentType ?? ""),
        protocols: sessions.protocolsForIncident(String(request.params.incidentType ?? ""))
      })
    },
    {
      method: "POST",
      url: "/api/protocol-sessions",
      module: "module_05",
      summary: "Start a bystander protocol session",
      auth: { public: true },
      body: startSessionBody,
      handler: async (request, reply) => {
        const body = startSessionBody.parse(request.body);
        return reply.status(201).send(await sessions.start(body));
      }
    },
    {
      method: "GET",
      url: "/api/protocol-sessions/:id",
      module: "module_05",
      summary: "Read a session and its step history",
      auth: { public: true },
      handler: async (request, reply) => {
        const id = String(request.params.id ?? "");
        const found = await sessions.get(id).catch(() => null);
        if (!found) throw AppError.notFound("Protocol session", id);
        return reply.send(found);
      }
    },
    {
      method: "GET",
      url: "/api/emergencies/:id/protocol-sessions",
      module: "module_05",
      summary: "Protocol sessions started for one emergency",
      auth: { roles: OPERATOR },
      handler: async (request, reply) => reply.send({
        emergencyId: String(request.params.id ?? ""),
        sessions: await sessions.listForEmergency(String(request.params.id ?? ""))
      })
    },
    {
      method: "POST",
      url: "/api/protocol-sessions/:id/utterance",
      module: "module_05",
      summary: "Submit what the bystander said; returns the next authoritative instruction",
      auth: { public: true },
      body: utteranceBody,
      handler: async (request, reply) => {
        const body = utteranceBody.parse(request.body);
        const sessionId = String(request.params.id ?? "");
        const decide = () => sessions.handleUtterance({
          sessionId,
          utterance: body.utterance
          // No forceEscalationReason: this route is the bystander's, and
          // escalating is the operator route's job.
        });
        const turn = module5.turnOrchestrator ? await module5.turnOrchestrator.orchestrateTurn({ sessionId, utterance: body.utterance, decide }) : await decide();
        return reply.send(turn);
      }
    },
    {
      method: "POST",
      url: "/api/protocol-sessions/:id/escalate",
      module: "module_05",
      summary: "Operator override: hand the call to a human now",
      auth: { roles: OPERATOR },
      body: escalateBody,
      handler: async (request, reply) => {
        const body = escalateBody.parse(request.body);
        return reply.send(await sessions.escalate(String(request.params.id ?? ""), body.reason));
      }
    },
    {
      method: "POST",
      url: "/api/protocol-sessions/:id/cancel",
      module: "module_05",
      summary: "Stop the protocol (professional help has arrived)",
      auth: { roles: OPERATOR },
      body: cancelBody,
      handler: async (request, reply) => {
        const body = cancelBody.parse(request.body);
        return reply.send(await sessions.cancel(String(request.params.id ?? ""), body.reason));
      }
    },
    {
      method: "GET",
      url: "/api/health/llm",
      module: "module_05",
      summary: "Language-model availability and degradation state",
      auth: { public: true },
      handler: async (_request, reply) => reply.send(await module5.llm.health())
    }
  ];
}

// modules/module_05_bystander_assistance/src/llm/contracts.ts
import { z as z7 } from "zod";
var TRISTATE = ["YES", "NO", "UNKNOWN"];
var BREATHING_STATUSES = [
  "BREATHING",
  "NOT_BREATHING",
  "GASPNING_AGAINST",
  "AGHASTIC",
  "UNKNOWN"
];
var CONSCIOUSNESS = ["ALERT", "CONFUSED", "UNRESPONSIVE", "UNKNOWN"];
var CHOKING_SIGNS = ["CANNOT_SPEAK_OR_COUGH", "CAN_SPEAK_OR_COUGH", "UNKNOWN"];
var AGE_GROUPS = ["INFANT", "CHILD", "ADULT", "ELDERLY", "UNKNOWN"];
var intents = [
  "PATIENT_UNRESPONSIVE",
  "PATIENT_NOT_BREATHING",
  "SEVERE_BLEEDING",
  "CHOKING",
  "ACTIVE_SEIZURE",
  "CHEST_PAIN",
  "OVERDOSE",
  "TRAUMA_INJURY",
  "MULTIPLE_CASUALTIES",
  "SCENE_UNSAFE",
  "ALLERGIC_REACTION",
  "CALLER_CONFIRMS_ACTION_DONE",
  "CALLER_NEEDS_REPEAT",
  "OTHER"
];
var entitiesSchema = z7.object({
  responsive: z7.enum(TRISTATE).default("UNKNOWN"),
  consciousness: z7.enum(CONSCIOUSNESS).default("UNKNOWN"),
  breathing_status: z7.enum(BREATHING_STATUSES).default("UNKNOWN"),
  severe_bleeding: z7.enum(TRISTATE).default("UNKNOWN"),
  choking_signs: z7.enum(CHOKING_SIGNS).default("UNKNOWN"),
  seizure_active: z7.enum(TRISTATE).default("UNKNOWN"),
  chest_pain: z7.enum(TRISTATE).default("UNKNOWN"),
  scene_safe: z7.enum(TRISTATE).default("UNKNOWN"),
  caller_with_patient: z7.enum(TRISTATE).default("UNKNOWN"),
  age_group: z7.enum(AGE_GROUPS).default("UNKNOWN"),
  patient_count: z7.number().int().min(1).max(50).nullable().default(null),
  /**
   * The caller's own words for where they are.
   *
   * The `call-emergency-services` step gates on `caller_location exists`, so
   * without this field the protocol can never leave that step: zod strips any
   * key the schema does not declare, so neither the Ollama path nor the
   * heuristic path can ever produce it. It is unbounded free text — the engine
   * accepts whatever the caller said and never invents an address.
   */
  caller_location: z7.string().max(200).nullable().default(null),
  /**
   * Whether the bystander has begun chest compressions.
   *
   * The `start-compressions` step gates on `cpr_started eq YES`, so without
   * this field the protocol can never advance into active CPR however many
   * times the caller says they are pushing. A closed tristate: `YES` means the
   * caller stated they started, `NO` means they stated they have not, and
   * `UNKNOWN` means they did not say — never inferred.
   */
  cpr_started: z7.enum(TRISTATE).default("UNKNOWN"),
  mechanism: z7.string().max(200).nullable().default(null),
  duration_minutes: z7.number().min(0).max(1440).nullable().default(null),
  /** Free-form observations kept for the record; never used for decisions. */
  notes: z7.string().max(500).nullable().default(null)
});
var extractionSchema = z7.object({
  intent: z7.enum(intents),
  entities: entitiesSchema,
  confidence: z7.number().min(0).max(1),
  requires_clarification: z7.boolean(),
  /** Question the assistant should ask. Must be about missing information. */
  clarification_question: z7.string().max(300).nullable().default(null),
  /** Verbatim fragment of the caller's words that drove the extraction. */
  evidence: z7.string().max(300).nullable().default(null)
});
var CLOSED_FACT_VALUES = {
  responsive: TRISTATE,
  consciousness: CONSCIOUSNESS,
  breathing_status: BREATHING_STATUSES,
  severe_bleeding: TRISTATE,
  choking_signs: CHOKING_SIGNS,
  seizure_active: TRISTATE,
  chest_pain: TRISTATE,
  scene_safe: TRISTATE,
  caller_with_patient: TRISTATE,
  cpr_started: TRISTATE,
  age_group: AGE_GROUPS
};
function closedFactValues() {
  return new Map(
    Object.entries(CLOSED_FACT_VALUES).map(([fact, values]) => [
      fact,
      new Set(values.map((value) => value.toUpperCase()))
    ])
  );
}
var classificationSchema = z7.object({
  incident_type: z7.enum([
    "CARDIAC_ARREST",
    "CHOKING",
    "UNCONSCIOUS",
    "SEVERE_BREATHING_DIFFICULTY",
    "SEVERE_BLEEDING",
    "TRAUMA",
    "OVERDOSE",
    "SEIZURE",
    "ALLERGIC_REACTION",
    "STROKE",
    "CHEST_PAIN",
    "UNSAFE_SCENE",
    "OTHER"
  ]),
  severity: z7.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]),
  confidence: z7.number().min(0).max(1),
  rationale: z7.string().max(400),
  /** Escalate to a human whenever confidence is low or the scene is unsafe. */
  requires_human_review: z7.boolean()
});
var responseSchema = z7.object({
  speech: z7.string().min(1).max(1200),
  tone: z7.enum(["CALM", "URGENT", "REASSURING"]).default("CALM"),
  /** Set by the safety gate, not by the model. */
  echo_of_source: z7.boolean().default(true)
});

// modules/module_05_bystander_assistance/src/llm/heuristicProvider.ts
var SCENE_HAZARD_WORDS = [
  "spark",
  "live wire",
  "electric",
  "electricity",
  "electrocution",
  "power line",
  "traffic",
  "moving car",
  "moving truck",
  "on the road",
  "in the road",
  "highway",
  "fire",
  "smoke",
  "flame",
  "burning",
  "gas leak",
  "leaking gas",
  "gas is leaking",
  "smell gas",
  "flood",
  "deep water",
  "broken glass",
  "unstable",
  "collapsing",
  "collapsed ceiling",
  "dangerous",
  "danger",
  "hazard",
  "chemical spill",
  "poison gas",
  "fighting",
  "attack",
  "armed",
  "lightning",
  "storm"
];
function breathingStatus(text, has) {
  if (has("gasping", "gasping and", "agonal", "occasional gasp", "irregular breathing", "gurgling", "ineffective breathing") || /gasping|snorting|irregular/.test(text)) {
    return "GASPNING_AGAINST";
  }
  if (has("not breathing", "isn't breathing", "no breathing", "stopped breathing", "no pulse")) {
    return "NOT_BREATHING";
  }
  if (has("breathing", "puffing", "breathes")) return "BREATHING";
  return "UNKNOWN";
}
var VAGUE_LOCATION_WORDS = /* @__PURE__ */ new Set([
  "here",
  "there",
  "somewhere",
  "anywhere",
  "nearby",
  "outside",
  "inside",
  "at home",
  "home",
  "this place",
  "that place",
  "the house",
  "the building"
]);
function callerLocation(text) {
  const patterns = [
    /(?:i am|i'm|we are|we're)(?: currently)?\s+at\s+(.{3,}?)(?:[.!?]|,|;|$)/i,
    /(?:the\s+)?address\s+(?:is\s*:|is|:)\s*(.{3,}?)(?:[.!?]|,|;|$)/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match?.[1]) continue;
    const candidate = match[1].trim();
    if (candidate.length < 3) continue;
    if (VAGUE_LOCATION_WORDS.has(candidate.toLowerCase())) continue;
    return candidate.slice(0, 200);
  }
  return null;
}
function cprStarted(text, has) {
  const negated = has(
    "not doing compressions",
    "not doing cpr",
    "not started compressions",
    "not started cpr",
    "haven't started compressions",
    "haven't started cpr",
    "have not started compressions",
    "have not started cpr",
    "haven't done compressions",
    "haven't done cpr",
    "not done compressions",
    "not done cpr",
    "not pushing on the chest",
    "not pushing on chest",
    "i don't do compressions",
    "i don't do cpr"
  );
  if (negated) return "NO";
  const positive = has(
    "doing chest compressions",
    "doing compressions",
    "doing the compressions",
    "doing cpr",
    "started chest compressions",
    "started compressions",
    "started the compressions",
    "started cpr",
    "began chest compressions",
    "began compressions",
    "began cpr",
    "begun chest compressions",
    "begun compressions",
    "begun cpr",
    "pushing on the chest",
    "pushing on chest",
    "pushing down on the chest",
    "pushing down on chest",
    "giving chest compressions",
    "giving compressions",
    "giving cpr",
    "gave cpr"
  );
  if (positive) return "YES";
  return "UNKNOWN";
}
function sceneSafety(text, has) {
  const blocked = has(
    "can't get",
    "cannot get",
    "can not get",
    "can't reach",
    "cannot reach",
    "can not reach",
    "not safe",
    "isn't safe",
    "is not safe",
    "unsafe",
    "won't let me",
    "will not let me"
  );
  const claimsSafe = has("safe", "no danger", "not dangerous");
  const masked = claimsSafe ? text.replace(/no danger|not dangerous|safe/gi, " ") : text;
  const hazard = SCENE_HAZARD_WORDS.some((word) => masked.includes(word));
  if (blocked || hazard) return "NO";
  if (claimsSafe) return "YES";
  return "UNKNOWN";
}
var HeuristicProvider = class {
  constructor(model = "rule-based", logger2 = createConsoleLogger("warn", "module_05.llm")) {
    this.model = model;
    this.logger = logger2;
  }
  providerName = "heuristic-fallback";
  get degradedNote() {
    return "LLM unavailable; deterministic keyword matcher in use. Not a language model.";
  }
  async generate() {
    throw new Error("HeuristicProvider does not support free-form generation.");
  }
  async extract(transcript, context = {}) {
    const text = transcript.toLowerCase();
    const has = (...needles) => needles.some((n) => text.includes(n));
    const entities = {
      responsive: has("not respond", "not responding", "unresponsive", "won't respond", "unconscious", "passed out") ? "NO" : "UNKNOWN",
      consciousness: has("not respond", "not responding", "unresponsive", "unconscious", "passed out") ? "UNRESPONSIVE" : has("confused", "drowsy", "dazed") ? "CONFUSED" : "UNKNOWN",
      breathing_status: breathingStatus(text, has),
      severe_bleeding: has("bleeding", "blood", "choking blood") ? "YES" : "UNKNOWN",
      choking_signs: has("can't speak", "cannot speak", "can't cough", "choking") ? "CANNOT_SPEAK_OR_COUGH" : "UNKNOWN",
      seizure_active: has("seizure", "fitting", "convulsion", "convulsing") ? "YES" : "UNKNOWN",
      chest_pain: has("chest pain", "chest tight", "chest pressure") ? "YES" : "UNKNOWN",
      // Hazard language wins over reassurance language. A caller who says
      // "it is safe here, but there are live wires" has reported an unsafe
      // scene, and the scene-safety-first rule must fire on that fact alone.
      scene_safe: sceneSafety(text, has),
      caller_with_patient: has("i'm with", "i am with", "im with", "next to", "beside") ? "YES" : "UNKNOWN",
      age_group: has("baby", "infant") ? "INFANT" : has("child", "kid") ? "CHILD" : "UNKNOWN",
      caller_location: callerLocation(text),
      cpr_started: cprStarted(text, has),
      patient_count: null,
      mechanism: null,
      duration_minutes: null,
      notes: transcript.slice(0, 300)
    };
    const intent = entities.breathing_status === "NOT_BREATHING" || entities.breathing_status === "GASPNING_AGAINST" ? "PATIENT_NOT_BREATHING" : entities.responsive === "NO" ? "PATIENT_UNRESPONSIVE" : entities.choking_signs === "CANNOT_SPEAK_OR_COUGH" ? "CHOKING" : entities.seizure_active === "YES" ? "ACTIVE_SEIZURE" : entities.severe_bleeding === "YES" ? "SEVERE_BLEEDING" : entities.chest_pain === "YES" ? "CHEST_PAIN" : "OTHER";
    const extraction = {
      intent,
      entities,
      confidence: 0.35,
      requires_clarification: true,
      clarification_question: context.currentStepQuestion ?? "I am running on a reduced safety net because the language model is offline. I need an operator to confirm your next steps. Can you stay on the line?",
      evidence: transcript.slice(0, 200)
    };
    this.logger.warn({ reason: this.degradedNote }, "extraction produced by heuristic fallback");
    return extraction;
  }
  async classify(transcript) {
    const extraction = await this.extract(transcript);
    return {
      incident_type: extraction.intent === "PATIENT_NOT_BREATHING" ? "CARDIAC_ARREST" : "OTHER",
      severity: "HIGH",
      confidence: 0.2,
      rationale: "Heuristic fallback only. A human operator must confirm classification.",
      requires_human_review: true
    };
  }
  async respond(request) {
    const parsed = responseSchema.parse({
      speech: request.question ? `${request.instruction} ${request.question}` : request.instruction,
      tone: request.tone ?? "CALM"
    });
    return { ...parsed, echo_of_source: true };
  }
  async health() {
    return {
      provider: this.providerName,
      model: this.model,
      available: true,
      degraded: true,
      reason: this.degradedNote,
      checkedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
  }
};

// modules/module_05_bystander_assistance/src/llm/ollamaProvider.ts
import "zod";

// modules/module_05_bystander_assistance/src/llm/prompts.ts
var SAFETY_PREAMBLE = `You are the language layer of a pre-hospital emergency telephone assistance system.
HARD RULES:
1. You are NOT a clinician and you do not decide treatment.
2. The caller is a lay bystander. Use short, plain, calm words.
3. You MUST NOT invent, add, remove, soften or alter any medical instruction.
4. Any instruction you output must be a faithful rephrasing of the SUPPLIED
   PROTOCOL TEXT given to you. Nothing else is permitted.
5. If you do not know something, say it is unknown. Never guess.
6. If the scene is unsafe, tell the caller to move to safety first.
Return only the JSON object that matches the requested schema.`;
var SYSTEM_EXTRACTION = `${SAFETY_PREAMBLE}

TASK: read what the bystander said and report ONLY the facts they actually stated.

Rules for facts:
- Use "UNKNOWN" for anything the bystander did not state. Never infer.
- Do not perform medical reasoning. Report observations, not conclusions.
- If the utterance is unclear, ambiguous, or contradicts a previous answer,
  set "requires_clarification" to true and give one short question.
- confidence reflects how explicitly the bystander stated the fact (0..1).`;
var SYSTEM_CLASSIFICATION = `${SAFETY_PREAMBLE}

TASK: classify the reported emergency so the right protocol and priority are used.

Rules:
- Choose the single most time-critical incident type consistent with what was said.
- Severity reflects the described condition, not your own opinion of risk.
- If the bystander has not given enough detail, lower the confidence and set
  requires_human_review to true.`;
var SYSTEM_RESPOND = `${SAFETY_PREAMBLE}

TASK: turn the SUPPLIED PROTOCOL TEXT into one short spoken sentence for the bystander.

Rules:
- Keep every clinical detail from the protocol text intact. Do not add numbers,
  dosages, timings or techniques that are not in the supplied text.
- Keep it under 3 sentences. Warm, direct, second person.
- If a question is supplied, ask exactly that question.
- Do not mention that you are an AI, a system or a protocol.`;
function buildExtractionPrompt(input) {
  const parts = [`BYSTANDER SAID: "${input.transcript}"`];
  if (input.currentStepQuestion) {
    parts.push(`THE ASSISTANT JUST ASKED: "${input.currentStepQuestion}"`);
  }
  if (input.knownFacts && Object.keys(input.knownFacts).length > 0) {
    parts.push(`FACTS ALREADY CONFIRMED (do not contradict, only add): ${JSON.stringify(input.knownFacts)}`);
  }
  if (input.missingFacts?.length) {
    parts.push(`FACTS STILL NEEDED: ${input.missingFacts.join(", ")}`);
    parts.push(
      "If the bystander answered one of these, fill it in. If they did not, ask one short clarifying question."
    );
  }
  return parts.join("\n");
}
function buildClassificationPrompt(input) {
  return [
    `CALL SUMMARY: "${input.transcript}"`,
    input.incidentHint ? `OPERATOR HINT: ${input.incidentHint}` : "",
    input.callerLocation ? `LOCATION: ${input.callerLocation}` : ""
  ].filter(Boolean).join("\n");
}
function buildRespondPrompt(input) {
  return [
    `SUPPLIED PROTOCOL TEXT (this is the only permitted content): "${input.instruction}"`,
    input.question ? `QUESTION TO ASK: "${input.question}"` : "",
    input.callerUtterance ? `BYSTANDER JUST SAID: "${input.callerUtterance}"` : "",
    `TONE: ${input.tone ?? "CALM"}`,
    "Now write the spoken reply."
  ].filter(Boolean).join("\n");
}
var jsonSchemas = {
  extraction: {
    type: "object",
    properties: {
      intent: {
        type: "string",
        enum: [
          "PATIENT_UNRESPONSIVE",
          "PATIENT_NOT_BREATHING",
          "SEVERE_BLEEDING",
          "CHOKING",
          "ACTIVE_SEIZURE",
          "CHEST_PAIN",
          "OVERDOSE",
          "TRAUMA_INJURY",
          "MULTIPLE_CASUALTIES",
          "SCENE_UNSAFE",
          "ALLERGIC_REACTION",
          "CALLER_CONFIRMS_ACTION_DONE",
          "CALLER_NEEDS_REPEAT",
          "OTHER"
        ]
      },
      entities: {
        type: "object",
        properties: {
          responsive: { type: "string", enum: ["YES", "NO", "UNKNOWN"] },
          consciousness: { type: "string", enum: ["ALERT", "CONFUSED", "UNRESPONSIVE", "UNKNOWN"] },
          breathing_status: {
            type: "string",
            enum: ["BREATHING", "NOT_BREATHING", "GASPNING_AGAINST", "UNKNOWN"],
            description: "BREATHING only for normal, comfortable breathing. Gasping, agonal, snorting, gurgling or irregular breathing is GASPNING_AGAINST, never BREATHING. If the caller cannot tell, use UNKNOWN."
          },
          severe_bleeding: { type: "string", enum: ["YES", "NO", "UNKNOWN"] },
          choking_signs: {
            type: "string",
            enum: ["CANNOT_SPEAK_OR_COUGH", "CAN_SPEAK_OR_COUGH", "UNKNOWN"]
          },
          seizure_active: { type: "string", enum: ["YES", "NO", "UNKNOWN"] },
          chest_pain: { type: "string", enum: ["YES", "NO", "UNKNOWN"] },
          scene_safe: { type: "string", enum: ["YES", "NO", "UNKNOWN"] },
          caller_with_patient: { type: "string", enum: ["YES", "NO", "UNKNOWN"] },
          age_group: { type: "string", enum: ["INFANT", "CHILD", "ADULT", "ELDERLY", "UNKNOWN"] },
          caller_location: {
            type: ["string", "null"],
            maxLength: 200,
            description: "The caller's own words for where they are (e.g. 'twelve main street'). Null if the caller did not state a location \u2014 never invent an address."
          },
          cpr_started: {
            type: "string",
            enum: ["YES", "NO", "UNKNOWN"],
            description: "YES only when the caller states they have begun chest compressions. NO only when they state they have not. UNKNOWN otherwise \u2014 never infer."
          },
          patient_count: { type: ["integer", "null"], minimum: 1, maximum: 50 },
          mechanism: { type: ["string", "null"], maxLength: 200 },
          duration_minutes: { type: ["number", "null"], minimum: 0, maximum: 1440 },
          notes: { type: ["string", "null"], maxLength: 500 }
        },
        required: [
          "responsive",
          "consciousness",
          "breathing_status",
          "severe_bleeding",
          "choking_signs",
          "seizure_active",
          "chest_pain",
          "scene_safe",
          "caller_with_patient",
          "age_group"
        ]
      },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      requires_clarification: { type: "boolean" },
      clarification_question: { type: ["string", "null"], maxLength: 300 },
      evidence: { type: ["string", "null"], maxLength: 300 }
    },
    required: ["intent", "entities", "confidence", "requires_clarification"]
  },
  classification: {
    type: "object",
    properties: {
      incident_type: {
        type: "string",
        enum: [
          "CARDIAC_ARREST",
          "CHOKING",
          "UNCONSCIOUS",
          "SEVERE_BREATHING_DIFFICULTY",
          "SEVERE_BLEEDING",
          "TRAUMA",
          "OVERDOSE",
          "SEIZURE",
          "ALLERGIC_REACTION",
          "STROKE",
          "CHEST_PAIN",
          "UNSAFE_SCENE",
          "OTHER"
        ]
      },
      severity: { type: "string", enum: ["CRITICAL", "HIGH", "MEDIUM", "LOW"] },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      rationale: { type: "string", maxLength: 400 },
      requires_human_review: { type: "boolean" }
    },
    required: ["incident_type", "severity", "confidence", "requires_human_review"]
  },
  response: {
    type: "object",
    properties: {
      speech: { type: "string", minLength: 1, maxLength: 1200 },
      tone: { type: "string", enum: ["CALM", "URGENT", "REASSURING"] }
    },
    required: ["speech", "tone"]
  }
};

// modules/module_05_bystander_assistance/src/llm/safety.ts
var NUMBER_PATTERN = /\d+(?:[.,]\d+)?/g;
var UNIT_PATTERN = /\b\d+\s*(?:mg|mcg|ml|l|kg|cm|mm|hz|bpm|per\s+min|seconds?|minutes?|%|beats?)\b/gi;
var ACTION_KEYWORDS = [
  "call",
  "press",
  "push",
  "breathe",
  "blow",
  "check",
  "turn",
  "place",
  "remove",
  "clear",
  "stop",
  "tilt",
  "lift",
  "listen",
  "look",
  "feel",
  "stir",
  "cough",
  "stay",
  "move",
  "wait",
  "keep",
  "open",
  "clot",
  "pressure",
  "siren",
  "unlock",
  "someone",
  "caller",
  "ambulance",
  "dispatcher",
  "operator"
];
function normaliseForSafetyCheck(text) {
  return text.toLowerCase().replace(/[^a-z0-9.\s]/g, " ").replace(/\s+/g, " ").trim();
}
function stem(word) {
  for (const suffix of ["ing", "ed", "es", "s"]) {
    if (word.length > suffix.length + 2 && word.endsWith(suffix)) {
      return word.slice(0, word.length - suffix.length);
    }
  }
  return word;
}
function assertSafeRephrasing(source, candidate) {
  const normalisedSource = normaliseForSafetyCheck(source);
  const normalisedCandidate = normaliseForSafetyCheck(candidate);
  const sourceNumbers = new Set(normalisedSource.match(NUMBER_PATTERN) ?? []);
  const candidateNumbers = normaliseForSafetyCheck(candidate).match(NUMBER_PATTERN) ?? [];
  const inventedNumbers = [...new Set(candidateNumbers.filter((n) => !sourceNumbers.has(n)))];
  if (inventedNumbers.length > 0) {
    return { safe: false, reason: "reply introduced numbers that are not in the protocol text", inventedNumbers };
  }
  const sourceUnits = new Set(normalisedSource.match(UNIT_PATTERN) ?? []);
  const candidateUnits = normalisedCandidate.match(UNIT_PATTERN) ?? [];
  const inventedUnits = [...new Set(candidateUnits.filter((u) => !sourceUnits.has(u)))];
  if (inventedUnits.length > 0) {
    return { safe: false, reason: "reply introduced a clinical measurement not in the protocol text", inventedNumbers: inventedUnits };
  }
  const sourceStems = new Set(
    normalisedSource.split(" ").map(stem).filter((w) => ACTION_KEYWORDS.includes(w))
  );
  const candidateStems = new Set(normalisedCandidate.split(" ").map(stem));
  const droppedActions = [...sourceStems].filter((w) => !candidateStems.has(w));
  if (droppedActions.length > 0) {
    return { safe: false, reason: "reply dropped protocol action wording", droppedActions };
  }
  return { safe: true };
}

// modules/module_05_bystander_assistance/src/llm/ollamaProvider.ts
var OllamaProvider = class {
  providerName = "ollama";
  baseUrl;
  model;
  timeoutMs;
  temperature;
  numCtx;
  fetchImpl;
  logger;
  constructor(options) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? 3e4;
    this.temperature = options.temperature ?? 0.1;
    this.numCtx = options.numCtx ?? 8192;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.logger = options.logger ?? createConsoleLogger("warn", "module_05.llm");
  }
  get modelName() {
    return this.model;
  }
  // -- raw generation ---------------------------------------------------------
  async generate(options) {
    const messages = options.messages ?? [
      ...options.system ? [{ role: "system", content: options.system }] : [],
      ...options.prompt ? [{ role: "user", content: options.prompt }] : []
    ];
    if (messages.length === 0) {
      throw AppError.validation("generate() requires either a prompt or messages.");
    }
    const body = {
      model: this.model,
      messages,
      stream: false,
      options: {
        temperature: options.temperature ?? this.temperature,
        num_ctx: options.numCtx ?? this.numCtx,
        ...options.maxTokens ? { num_predict: options.maxTokens } : {}
      }
    };
    if (options.schema) body.format = options.schema;
    const started = Date.now();
    const raw = await this.post("/api/chat", body);
    const latencyMs = Date.now() - started;
    const content = extractMessageContent(raw);
    if (content === null) {
      throw new AppError(
        ErrorCode.LLM_MALFORMED_RESPONSE,
        "Ollama returned a response without a message content field.",
        502,
        { provider: this.providerName, model: this.model }
      );
    }
    return { text: content, provider: this.providerName, model: this.model, latencyMs, repaired: false, degraded: false, raw };
  }
  // -- schema-constrained operations -----------------------------------------
  async extract(transcript, context = {}) {
    const prompt = buildExtractionPrompt({
      transcript,
      currentStepQuestion: context.currentStepQuestion ?? null,
      knownFacts: context.knownFacts ?? {},
      missingFacts: context.missingFacts ?? []
    });
    const { value, latencyMs, degraded } = await this.generateJson(
      extractionSchema,
      SYSTEM_EXTRACTION,
      prompt,
      jsonSchemas.extraction
    );
    return this.postProcessExtraction(value, context, latencyMs, degraded);
  }
  async classify(transcript, context = {}) {
    const prompt = buildClassificationPrompt({
      transcript,
      incidentHint: context.incidentHint,
      callerLocation: context.callerLocation
    });
    const { value, degraded } = await this.generateJson(
      classificationSchema,
      SYSTEM_CLASSIFICATION,
      prompt,
      jsonSchemas.classification
    );
    if (degraded) this.logger.warn({ transcript: transcript.slice(0, 80) }, "classification from degraded provider");
    return value;
  }
  /**
   * Turns a protocol-approved instruction into speech.
   *
   * Safety gate: the model's output is compared against the source instruction.
   * Any clinical content that is not present in the protocol text (new numbers,
   * dosages, techniques) causes the raw protocol text to be used instead.
   */
  async respond(request) {
    const prompt = buildRespondPrompt({
      instruction: request.instruction,
      question: request.question ?? null,
      callerUtterance: request.callerUtterance ?? null,
      tone: request.tone
    });
    try {
      const { value, degraded } = await this.generateJson(
        responseSchema,
        SYSTEM_RESPOND,
        prompt,
        jsonSchemas.response
      );
      const verdict = assertSafeRephrasing(request.instruction, value.speech);
      if (!verdict.safe) {
        this.logger.warn({ reason: verdict.reason }, "LLM rephrasing rejected by safety gate; using protocol text");
        return {
          speech: buildSafeSpeech(request),
          tone: request.tone ?? "CALM",
          echo_of_source: true
        };
      }
      if (degraded) {
        return { speech: buildSafeSpeech(request), tone: request.tone ?? "CALM", echo_of_source: true };
      }
      return { ...value, echo_of_source: true };
    } catch (error) {
      if (error instanceof AppError && error.code !== ErrorCode.INTERNAL_ERROR) throw error;
      this.logger.warn({ error: String(error) }, "respond() failed; using protocol text verbatim");
      return { speech: buildSafeSpeech(request), tone: request.tone ?? "CALM", echo_of_source: true };
    }
  }
  // -- health -----------------------------------------------------------------
  async health() {
    const checkedAt = (/* @__PURE__ */ new Date()).toISOString();
    const started = Date.now();
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/tags`, {
        method: "GET",
        signal: AbortSignal.timeout(Math.min(this.timeoutMs, 5e3))
      });
      if (!response.ok) {
        return this.unavailable(`Ollama responded with HTTP ${response.status}`, checkedAt, Date.now() - started);
      }
      const body = await response.json();
      const names = (body.models ?? []).map((m) => m.name ?? m.model ?? "");
      const present = names.some(
        (name) => name === this.model || name === `${this.model}:latest` || name.startsWith(`${this.model}:`)
      );
      if (!present) {
        return this.unavailable(
          `Model '${this.model}' is not pulled. Run: ollama pull ${this.model}`,
          checkedAt,
          Date.now() - started
        );
      }
      return {
        provider: this.providerName,
        model: this.model,
        available: true,
        baseUrl: this.baseUrl,
        latencyMs: Date.now() - started,
        degraded: false,
        checkedAt
      };
    } catch (error) {
      return this.unavailable(describeNetworkError(error), checkedAt, Date.now() - started);
    }
  }
  unavailable(reason, checkedAt, latencyMs) {
    return {
      provider: this.providerName,
      model: this.model,
      available: false,
      baseUrl: this.baseUrl,
      reason,
      latencyMs,
      // An unreachable or missing model means the language layer is not doing its
      // job, so the deployment must surface itself as degraded.
      degraded: true,
      checkedAt
    };
  }
  // -- internals --------------------------------------------------------------
  async generateJson(schema, system, prompt, jsonSchema) {
    const result = await this.generate({ system, prompt, schema: jsonSchema });
    const parsed = parseJsonPayload(result.text);
    if (!parsed.ok) {
      throw new AppError(
        ErrorCode.LLM_MALFORMED_RESPONSE,
        "The language model did not return valid JSON.",
        502,
        { provider: this.providerName, snippet: result.text.slice(0, 200) }
      );
    }
    const validation = schema.safeParse(parsed.value);
    if (!validation.success) {
      throw new AppError(
        ErrorCode.LLM_OUTPUT_SCHEMA_VIOLATION,
        "The language model output did not match the required schema.",
        502,
        {
          provider: this.providerName,
          issues: validation.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message
          }))
        }
      );
    }
    return { value: validation.data, latencyMs: result.latencyMs, degraded: result.degraded };
  }
  /**
   * Merges extracted facts into already-confirmed facts and enforces the
   * "never invent" rule: an UNKNOWN extraction never overwrites a known value,
   * and a low-confidence extraction is forced to ask for clarification.
   */
  postProcessExtraction(value, context, latencyMs, degraded) {
    const known = context.knownFacts ?? {};
    const entities = { ...value.entities };
    for (const [key, current] of Object.entries(entities)) {
      if ((current === "UNKNOWN" || current === null) && known[key] !== void 0) {
        entities[key] = known[key];
      }
    }
    const needsClarification = value.requires_clarification || value.confidence < 0.5 || degraded;
    return {
      ...value,
      entities,
      requires_clarification: needsClarification,
      clarification_question: needsClarification ? value.clarification_question ?? defaultClarification(context, entities) : value.clarification_question,
      confidence: degraded ? Math.min(value.confidence, 0.4) : value.confidence
    };
  }
  async post(path3, body) {
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path3}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      if (isTimeout(error)) {
        throw new AppError(
          ErrorCode.LLM_TIMEOUT,
          `The language model did not respond within ${this.timeoutMs}ms.`,
          504,
          { provider: this.providerName, model: this.model }
        );
      }
      throw new AppError(
        ErrorCode.LLM_UNAVAILABLE,
        `Cannot reach Ollama at ${this.baseUrl}. ${describeNetworkError(error)}`,
        503,
        { provider: this.providerName, model: this.model }
      );
    }
    if (response.status === 404) {
      throw new AppError(
        ErrorCode.LLM_MODEL_NOT_FOUND,
        `Ollama has no model '${this.model}'. Run: ollama pull ${this.model}`,
        503,
        { provider: this.providerName, model: this.model }
      );
    }
    if (!response.ok) {
      const detail = await safeText(response);
      throw new AppError(
        ErrorCode.LLM_UNAVAILABLE,
        `Ollama request failed with HTTP ${response.status}.`,
        503,
        { provider: this.providerName, status: response.status, detail: detail.slice(0, 300) }
      );
    }
    try {
      return await response.json();
    } catch {
      throw new AppError(
        ErrorCode.LLM_MALFORMED_RESPONSE,
        "Ollama returned a body that is not valid JSON.",
        502,
        { provider: this.providerName }
      );
    }
  }
};
function extractMessageContent(raw) {
  if (typeof raw !== "object" || raw === null) return null;
  const message = raw.message;
  if (message && typeof message.content === "string") return message.content;
  const response = raw.response;
  if (typeof response === "string") return response;
  return null;
}
function parseJsonPayload(text) {
  const trimmed = text.trim();
  const candidates = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === "object") return { ok: true, value };
    } catch {
      continue;
    }
  }
  return { ok: false };
}
function isTimeout(error) {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError" || /timeout/i.test(error.message));
}
function describeNetworkError(error) {
  if (error instanceof Error) {
    const cause = error.cause;
    if (cause?.code) return `${error.message} (${cause.code})`;
    return error.message;
  }
  return String(error);
}
async function safeText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
function buildSafeSpeech(request) {
  return request.question ? `${request.instruction} ${request.question}` : request.instruction;
}
function defaultClarification(context, entities) {
  const missing = context.missingFacts?.filter((key) => {
    const value = entities[key];
    return value === void 0 || value === "UNKNOWN" || value === null;
  });
  if (missing?.length) {
    return `Before I continue, can you tell me about: ${missing.slice(0, 2).join(" and ")}?`;
  }
  return "Sorry, I did not catch that. Could you say it again?";
}

// modules/module_05_bystander_assistance/src/llm/llmService.ts
var LLMServiceRegistry = class {
  providers = /* @__PURE__ */ new Map();
  register(provider) {
    this.providers.set(provider.providerName, provider);
  }
  get(name) {
    return this.providers.get(name);
  }
  names() {
    return [...this.providers.keys()];
  }
  list() {
    return [...this.providers.values()];
  }
};
var LlmGateway = class {
  constructor(registry, config, logger2 = createConsoleLogger("warn", "module_05.llm"), healthTtlMs = 15e3, now = Date.now) {
    this.registry = registry;
    this.config = config;
    this.logger = logger2;
    this.healthTtlMs = healthTtlMs;
    this.now = now;
  }
  lastKnownHealth = /* @__PURE__ */ new Map();
  healthCache = /* @__PURE__ */ new Map();
  inflight = /* @__PURE__ */ new Map();
  /** Health for one provider, cached for `healthTtlMs`. */
  async healthOf(service) {
    const cached = this.healthCache.get(service.providerName);
    if (cached && this.now() - cached.at < this.healthTtlMs) return cached.health;
    const existing = this.inflight.get(service.providerName);
    if (existing) return existing;
    const probe = service.health().then((health) => {
      this.healthCache.set(service.providerName, { at: this.now(), health });
      return health;
    }).finally(() => {
      this.inflight.delete(service.providerName);
    });
    this.inflight.set(service.providerName, probe);
    return probe;
  }
  async resolve() {
    const primary = this.registry.get(this.config.provider);
    if (!primary) {
      throw new AppError(
        ErrorCode.LLM_UNAVAILABLE,
        `Unknown LLM provider '${this.config.provider}'. Registered: ${this.registry.names().join(", ")}.`,
        503
      );
    }
    const health = await this.healthOf(primary);
    this.lastKnownHealth.set(primary.providerName, health);
    if (health.available) {
      if (primary.providerName === "heuristic-fallback") {
        return { service: primary, degraded: true, reason: "Configured as the primary provider." };
      }
      return { service: primary, degraded: false };
    }
    this.logger.warn(
      { provider: primary.providerName, reason: health.reason },
      "primary LLM provider unavailable"
    );
    if (this.config.allowHeuristicFallback) {
      const fallback2 = this.registry.get("heuristic-fallback") ?? new HeuristicProvider();
      return { service: fallback2, degraded: true, reason: health.reason };
    }
    throw new AppError(
      ErrorCode.LLM_UNAVAILABLE,
      `LLM provider '${primary.providerName}' is unavailable: ${health.reason ?? "unknown reason"}`,
      503,
      { provider: primary.providerName, model: this.config.model }
    );
  }
  /**
   * Health of every registered provider, for `GET /api/health/llm`.
   *
   * Uses the same cache as `resolve`, and says so in `cached`: an operator
   * debugging an outage needs to know whether the answer is a fresh probe or one
   * that is up to `healthTtlMs` old.
   */
  async health() {
    const primary = this.registry.get(this.config.provider);
    const cachedEntry = primary ? this.healthCache.get(primary.providerName) : void 0;
    const primaryHealth = primary ? await this.healthOf(primary) : {
      provider: this.config.provider,
      model: this.config.model,
      available: false,
      reason: "Provider is not registered.",
      checkedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    const effective = primaryHealth.available ? { degraded: false } : this.config.allowHeuristicFallback ? { degraded: true, reason: "Operating on heuristic fallback." } : { degraded: false, reason: "No fallback enabled; protocol flow is blocked." };
    return {
      provider: primaryHealth.provider,
      model: primaryHealth.model,
      available: primaryHealth.available,
      latencyMs: primaryHealth.latencyMs,
      baseUrl: primaryHealth.baseUrl,
      reason: primaryHealth.reason ?? effective.reason,
      degraded: Boolean(effective.degraded),
      checkedAt: primaryHealth.checkedAt,
      cached: Boolean(cachedEntry) && this.now() - (cachedEntry?.at ?? 0) < this.healthTtlMs,
      registered: this.registry.names(),
      fallbackEnabled: this.config.allowHeuristicFallback
    };
  }
  rawHealthFor(provider) {
    return this.lastKnownHealth.get(provider);
  }
};
function createDefaultRegistry(config, extra = []) {
  const registry = new LLMServiceRegistry();
  const logger2 = createConsoleLogger("warn", "module_05.llm");
  const supplied = extra.some((p) => p.providerName === config.provider);
  if (config.provider === "ollama") {
    registry.register(
      new OllamaProvider({
        baseUrl: config.ollamaBaseUrl,
        model: config.model,
        timeoutMs: config.timeoutMs,
        temperature: config.temperature,
        numCtx: config.numCtx,
        logger: logger2
      })
    );
  } else if (!supplied) {
    throw new AppError(
      ErrorCode.LLM_UNAVAILABLE,
      `No provider implementation registered for '${config.provider}'. Implement LLMService and register it.`,
      500
    );
  }
  registry.register(new HeuristicProvider("rule-based", logger2));
  for (const provider of extra) registry.register(provider);
  return registry;
}

// modules/module_05_bystander_assistance/src/protocol_engine/protocolLoader.ts
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve, basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

// modules/module_05_bystander_assistance/src/protocol_engine/types.ts
import { z as z9 } from "zod";
var comparisonSchema = z9.object({
  fact: z9.string().min(1),
  op: z9.enum(["eq", "ne", "in", "not_in", "exists", "missing", "gt", "gte", "lt", "lte"]),
  value: z9.unknown().optional()
});
var conditionSchema = z9.lazy(
  () => z9.union([
    comparisonSchema,
    z9.object({ all: z9.array(conditionSchema).min(1) }),
    z9.object({ any: z9.array(conditionSchema).min(1) }),
    z9.object({ not: conditionSchema }),
    z9.object({ always: z9.literal(true) })
  ])
);
var STEP_TYPES = ["QUESTION", "ACTION", "DECISION", "INFO", "ESCALATE"];
var TRANSITION_ACTIONS = ["ADVANCE", "COMPLETE", "ESCALATE", "LOOP"];
var transitionSchema = z9.object({
  when: conditionSchema,
  /** Next step id, or null when the action terminates the flow. */
  to: z9.string().min(1).nullable(),
  action: z9.enum(TRANSITION_ACTIONS).default("ADVANCE"),
  note: z9.string().max(300).nullish()
});
var stepSchema = z9.object({
  step_id: z9.string().min(1),
  order: z9.number().int().min(0),
  type: z9.enum(STEP_TYPES),
  /** Protocol-approved wording. This text is authoritative and is persisted. */
  instruction: z9.string().min(10).max(1200),
  /** What the assistant asks the bystander, verbatim protocol wording. */
  question: z9.string().min(3).max(500).nullish(),
  /**
   * Per-fact follow-up wording, used when only some of this step's required
   * facts are still missing. Keeping these in the protocol file means
   * clarification wording is reviewed with the rest of the protocol rather
   * than generated in code.
   */
  fact_questions: z9.record(z9.string().min(3).max(500)).optional(),
  /** Entity keys that must be known before this step can be evaluated. */
  requires_facts: z9.array(z9.string()).default([]),
  /** Repeat cadence for time-based protocols (e.g. CPR cycles). */
  repeat_interval_minutes: z9.number().positive().max(60).nullish(),
  /** Maximum repeats before escalation is forced. */
  max_repeats: z9.number().int().min(1).max(200).nullish(),
  transitions: z9.array(transitionSchema).min(1),
  completion_conditions: z9.array(conditionSchema).default([]),
  on_completion: z9.enum(TRANSITION_ACTIONS).default("ADVANCE")
}).superRefine((step, ctx) => {
  const dangling = step.transitions.filter((t) => t.to === null && t.action === "ADVANCE");
  if (dangling.length > 0) {
    ctx.addIssue({
      code: "custom",
      message: `Step '${step.step_id}' has an ADVANCE transition with no target; use COMPLETE, ESCALATE or LOOP.`
    });
  }
});
var escalationRuleSchema = z9.object({
  rule_id: z9.string().min(1),
  when: conditionSchema,
  reason: z9.string().min(5).max(500),
  action: z9.enum(["NOTIFY_OPERATOR", "CALL_EMERGENCY_SERVICES", "BOTH"]),
  severity: z9.enum(["ADVISORY", "URGENT", "CRITICAL"]).default("URGENT"),
  /**
   * Step whose instruction the caller should hear when this rule fires. Without
   * it the assistant re-reads whichever step happened to be active, which for a
   * scene-safety escalation means telling a bystander to go and check the
   * patient they were just told not to approach.
   */
  escalation_step: z9.string().min(1).optional()
});
var protocolSourceSchema = z9.object({
  /** Human readable citation of the guidance this content came from. */
  name: z9.string().min(5),
  publisher: z9.string().min(2),
  url: z9.string().url(),
  /** ISO date the content was transcribed. */
  accessed: z9.string().min(4),
  /**
   * Clinical review state. Nothing in this repository has been reviewed by a
   * clinician, and the loader surfaces this state in the API.
   */
  review_status: z9.enum(["UNREVIEWED", "IN_REVIEW", "CLINICALLY_REVIEWED"]),
  reviewed_by: z9.string().nullish(),
  reviewed_at: z9.string().nullish()
});
var protocolSchema = z9.object({
  protocol_id: z9.string().min(2),
  version: z9.string().regex(/^\d+\.\d+\.\d+$/, "version must be semantic, e.g. 1.0.0"),
  title: z9.string().min(3),
  source: protocolSourceSchema,
  medical_disclaimer: z9.string().min(20),
  applies_to: z9.object({
    incident_types: z9.array(z9.string().min(2)).min(1),
    age_groups: z9.array(z9.string()).default([])
  }),
  /** All must hold for the protocol to apply. */
  entry_conditions: z9.array(conditionSchema).default([]),
  entry_step: z9.string().min(1),
  steps: z9.array(stepSchema).min(1),
  escalation_rules: z9.array(escalationRuleSchema).default([]),
  completion_conditions: z9.array(conditionSchema).default([]),
  /** Ordering hint for triage when several protocols match. */
  priority: z9.number().int().min(0).max(100).default(50)
});
var UNKNOWN = "UNKNOWN";
function isUnknown(value) {
  return value === void 0 || value === null || value === UNKNOWN || value === "";
}
function instructionIdFor(protocol, stepId) {
  return `${protocol.protocol_id}@${protocol.version}:${stepId}`;
}
function questionIdFor(protocol, stepId, attempt) {
  return `${protocol.protocol_id}@${protocol.version}:${stepId}#q${attempt}`;
}

// modules/module_05_bystander_assistance/src/protocol_engine/protocolLoader.ts
var moduleDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
var DEFAULT_PROTOCOL_DIR = resolve(moduleDir, "protocols");
var ProtocolLoader = class {
  constructor(directory = DEFAULT_PROTOCOL_DIR) {
    this.directory = directory;
  }
  cache = /* @__PURE__ */ new Map();
  /** Which file supplied each cached protocol, so duplicates can name both sides. */
  sourceFiles = /* @__PURE__ */ new Map();
  loadError = null;
  get protocolDir() {
    return this.directory;
  }
  /** Validates and caches every protocol file in the directory. */
  load(force = false) {
    if (this.cache.size > 0 && !force) return [...this.cache.values()];
    this.cache.clear();
    if (!existsSync(this.directory)) {
      throw new AppError(
        ErrorCode.PROTOCOL_CATALOGUE_INVALID,
        `Protocol directory '${this.directory}' does not exist.`,
        500
      );
    }
    const files = collectJsonFiles(this.directory);
    if (files.length === 0) {
      throw new AppError(
        ErrorCode.PROTOCOL_CATALOGUE_INVALID,
        `No protocol files found in '${this.directory}'.`,
        500
      );
    }
    const problems = [];
    for (const file of files) {
      let raw;
      try {
        raw = readFileSync(file, "utf8");
      } catch (error) {
        problems.push(`${basename(file)}: unreadable (${String(error)})`);
        continue;
      }
      let json;
      try {
        json = JSON.parse(raw);
      } catch (error) {
        problems.push(`${basename(file)}: invalid JSON (${String(error)})`);
        continue;
      }
      const parsed = protocolSchema.safeParse(json);
      if (!parsed.success) {
        problems.push(
          `${basename(file)}: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`
        );
        continue;
      }
      const protocol = parsed.data;
      const key = cacheKey(protocol.protocol_id, protocol.version);
      const previousFile = this.sourceFiles.get(key);
      if (previousFile !== void 0) {
        problems.push(
          `${basename(file)}: duplicate ${key}; already defined by ${previousFile}`
        );
        continue;
      }
      const structural = validateGraph(protocol);
      problems.push(...structural.map((issue) => `${basename(file)}: ${issue}`));
      this.sourceFiles.set(key, basename(file));
      this.cache.set(key, protocol);
    }
    this.sourceFiles.clear();
    this.loadError = problems.length > 0 ? problems.join(" | ") : null;
    if (problems.length > 0) {
      this.cache.clear();
      throw new AppError(
        ErrorCode.PROTOCOL_CATALOGUE_INVALID,
        "The protocol catalogue failed validation.",
        500,
        { problems }
      );
    }
    return [...this.cache.values()];
  }
  list() {
    return this.load().map((protocol) => toSummary(protocol)).sort((a, b) => b.priority - a.priority || a.protocolId.localeCompare(b.protocolId));
  }
  versionsOf(protocolId) {
    return this.load().filter((p) => p.protocol_id === protocolId).map((p) => p.version).sort(compareVersions);
  }
  get(protocolId, version) {
    const all = this.load();
    if (version) {
      const exact = all.find((p) => p.protocol_id === protocolId && p.version === version);
      if (!exact) {
        throw new AppError(
          ErrorCode.PROTOCOL_NOT_FOUND,
          `Protocol '${protocolId}' version '${version}' is not in the catalogue. Available: ${this.versionsOf(protocolId).join(", ") || "none"}.`,
          404,
          { protocolId, version, available: this.versionsOf(protocolId) }
        );
      }
      return exact;
    }
    const candidates = all.filter((p) => p.protocol_id === protocolId);
    if (candidates.length === 0) throw this.notFound(protocolId);
    return candidates.sort((a, b) => compareVersions(b.version, a.version))[0];
  }
  /** Protocols whose `applies_to.incident_types` contains the incident type. */
  forIncidentType(incidentType) {
    return this.load().filter((p) => p.applies_to.incident_types.includes(incidentType)).sort((a, b) => b.priority - a.priority);
  }
  /** Resolves the protocol to run for an incident, or null when none applies. */
  resolveForIncident(incidentType) {
    return this.forIncidentType(incidentType)[0] ?? null;
  }
  get lastLoadError() {
    return this.loadError;
  }
  notFound(protocolId) {
    return new AppError(
      ErrorCode.PROTOCOL_NOT_FOUND,
      `Protocol '${protocolId}' is not in the catalogue.`,
      404,
      {
        protocolId,
        available: [...new Set(this.load().map((p) => p.protocol_id))]
      }
    );
  }
};
function cacheKey(protocolId, version) {
  return `${protocolId}@${version}`;
}
function collectJsonFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      out.push(...collectJsonFiles(full));
    } else if (extname(entry) === ".json") {
      out.push(full);
    }
  }
  return out;
}
function validateGraph(protocol) {
  const issues = [];
  const stepIds = new Set(protocol.steps.map((s) => s.step_id));
  if (!stepIds.has(protocol.entry_step)) {
    issues.push(`entry_step '${protocol.entry_step}' does not exist`);
  }
  if (stepIds.size !== protocol.steps.length) {
    issues.push("duplicate step_id values detected");
  }
  const ruleIds = /* @__PURE__ */ new Set();
  for (const rule of protocol.escalation_rules) {
    if (ruleIds.has(rule.rule_id)) {
      issues.push(`duplicate escalation rule_id '${rule.rule_id}'`);
    }
    ruleIds.add(rule.rule_id);
    if (rule.escalation_step && !stepIds.has(rule.escalation_step)) {
      issues.push(
        `escalation rule '${rule.rule_id}' names escalation_step '${rule.escalation_step}', which does not exist`
      );
    }
  }
  for (const step of protocol.steps) {
    for (const transition of step.transitions) {
      if (transition.to !== null && !stepIds.has(transition.to)) {
        issues.push(`step '${step.step_id}' points to unknown step '${transition.to}'`);
      }
    }
    const moves = step.transitions.some(
      (t) => t.action === "LOOP" || t.action === "COMPLETE" || t.action === "ESCALATE" || t.to !== null
    );
    if (!moves) {
      issues.push(`step '${step.step_id}' has no way forward`);
    }
  }
  return issues;
}
function toSummary(protocol) {
  return {
    protocolId: protocol.protocol_id,
    version: protocol.version,
    title: protocol.title,
    source: protocol.source,
    priority: protocol.priority,
    appliesTo: protocol.applies_to.incident_types,
    stepCount: protocol.steps.length,
    reviewStatus: protocol.source.review_status
  };
}
function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// modules/module_05_bystander_assistance/src/protocol_engine/stateMachine.ts
function evaluateCondition(condition, context) {
  if ("always" in condition) return true;
  if ("all" in condition) return condition.all.every((c) => evaluateCondition(c, context));
  if ("any" in condition) return condition.any.some((c) => evaluateCondition(c, context));
  if ("not" in condition) return !evaluateCondition(condition.not, context);
  const actual = context.facts[condition.fact];
  switch (condition.op) {
    case "exists":
      return !isUnknown(actual);
    case "missing":
      return isUnknown(actual);
    case "eq":
      return !isUnknown(actual) && isEqual(actual, condition.value);
    case "ne":
      return !isUnknown(actual) && !isEqual(actual, condition.value);
    case "in":
      return !isUnknown(actual) && Array.isArray(condition.value) && condition.value.some((v) => isEqual(actual, v));
    case "not_in":
      return !isUnknown(actual) && Array.isArray(condition.value) && !condition.value.some((v) => isEqual(actual, v));
    case "gt":
      return numeric(actual) !== null && numeric(actual) > numeric(condition.value);
    case "gte":
      return numeric(actual) !== null && numeric(actual) >= numeric(condition.value);
    case "lt":
      return numeric(actual) !== null && numeric(actual) < numeric(condition.value);
    case "lte":
      return numeric(actual) !== null && numeric(actual) <= numeric(condition.value);
    default:
      return false;
  }
}
function isEqual(actual, expected) {
  if (typeof actual === "string" && typeof expected === "string") {
    return actual.toUpperCase() === expected.toUpperCase();
  }
  return actual === expected;
}
function numeric(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}
function missingFactsFor(step, facts) {
  return (step.requires_facts ?? []).filter((key) => isUnknown(facts[key]));
}
function selectTransition(step, context) {
  for (let index = 0; index < step.transitions.length; index += 1) {
    const transition = step.transitions[index];
    if (evaluateCondition(transition.when, context)) {
      return { transition, index };
    }
  }
  return null;
}
function referencedFacts(condition) {
  if ("always" in condition) return [];
  if ("all" in condition) return condition.all.flatMap(referencedFacts);
  if ("any" in condition) return condition.any.flatMap(referencedFacts);
  if ("not" in condition) return referencedFacts(condition.not);
  return [condition.fact];
}
function protocolFacts(protocol) {
  const facts = /* @__PURE__ */ new Set();
  const walk = (condition) => {
    for (const fact of referencedFacts(condition)) facts.add(fact);
  };
  for (const condition of protocol.entry_conditions) walk(condition);
  for (const condition of protocol.completion_conditions) walk(condition);
  for (const rule of protocol.escalation_rules) walk(rule.when);
  for (const step of protocol.steps) {
    for (const transition of step.transitions) walk(transition.when);
    for (const condition of step.completion_conditions) walk(condition);
    for (const fact of step.requires_facts) facts.add(fact);
  }
  return facts;
}
function validateObservedFacts(observed, closed) {
  const accepted = {};
  const rejected = [];
  for (const [fact, value] of Object.entries(observed)) {
    if (isUnknown(value)) {
      continue;
    }
    const allowed = closed.get(fact);
    if (allowed === void 0 || typeof value !== "string") {
      accepted[fact] = value;
      continue;
    }
    if (allowed.has(value.toUpperCase())) {
      accepted[fact] = value;
      continue;
    }
    rejected.push({
      fact,
      reason: `'${value}' is not a declared value for '${fact}' (allowed: ${[...allowed].join(", ")})`
    });
  }
  return { accepted, rejected };
}
function isDefinitivelyFalse(condition, facts) {
  if ("always" in condition) return false;
  if ("all" in condition) return condition.all.some((c) => isDefinitivelyFalse(c, facts));
  if ("any" in condition) return condition.any.every((c) => isDefinitivelyFalse(c, facts));
  if ("not" in condition) {
    if (referencedFacts(condition.not).some((fact) => isUnknown(facts[fact]))) return false;
    return evaluateCondition(condition, {
      facts,
      now: /* @__PURE__ */ new Date(0),
      sessionStartedAt: /* @__PURE__ */ new Date(0),
      repeatCount: 0
    });
  }
  if (isUnknown(facts[condition.fact])) return false;
  return !evaluateCondition(condition, {
    facts,
    now: /* @__PURE__ */ new Date(0),
    sessionStartedAt: /* @__PURE__ */ new Date(0),
    repeatCount: 0
  });
}
function contradictedEntryConditions(conditions, facts) {
  return conditions.filter((condition) => isDefinitivelyFalse(condition, facts));
}
function withEngineFacts(facts, now, sessionStartedAt) {
  return {
    ...facts,
    elapsed_minutes: Math.round((now.getTime() - sessionStartedAt.getTime()) / 6e4 * 10) / 10
  };
}

// modules/module_05_bystander_assistance/src/protocol_engine/escalation.ts
var EscalationPolicy = class {
  evaluate(protocol, context) {
    const escalations = [];
    for (const rule of protocol.escalation_rules) {
      if (!evaluateCondition(rule.when, context)) continue;
      escalations.push({
        ruleId: rule.rule_id,
        reason: rule.reason,
        action: rule.action,
        severity: rule.severity,
        source: { protocolId: protocol.protocol_id, protocolVersion: protocol.version },
        ...rule.escalation_step ? { escalationStepId: rule.escalation_step } : {}
      });
    }
    const highest = pickHighest(escalations.map((e) => e.severity));
    return {
      escalations,
      highest,
      mustEscalate: escalations.some((e) => e.action !== "NOTIFY_OPERATOR")
    };
  }
};
var SEVERITY_ORDER = { ADVISORY: 1, URGENT: 2, CRITICAL: 3 };
function pickHighest(values) {
  if (values.length === 0) return null;
  return values.reduce(
    (best, current) => SEVERITY_ORDER[current] > SEVERITY_ORDER[best] ? current : best
  );
}
function withDerivedFacts(facts, derived) {
  return {
    ...facts,
    completed_steps: derived.completedSteps,
    repeat_count: derived.repeatCount,
    total_steps: derived.totalSteps,
    progress_pct: derived.totalSteps > 0 ? Math.round(derived.completedSteps / derived.totalSteps * 100) : 0
  };
}

// modules/module_05_bystander_assistance/src/protocol_engine/engine.ts
var ProtocolEngine = class {
  constructor(loader, escalation = new EscalationPolicy(), clarificationLimit = 3, closedFactValues2 = /* @__PURE__ */ new Map()) {
    this.loader = loader;
    this.escalation = escalation;
    this.clarificationLimit = clarificationLimit;
    this.closedFactValues = closedFactValues2;
  }
  escalation;
  logger = createConsoleLogger("info", "module_05.engine");
  /**
   * How many times the engine may ask for the same missing information before
   * escalating. 0 disables the limit. Bounded retries are deliberate: a session
   * that keeps asking the same unanswered question is not helping anyone.
   */
  clarificationLimit;
  /**
     * Closed value sets for individual facts, used to reject values nobody can
     * vouch for. A fact that is absent is unbounded and accepted as given.
     *
     * Injected rather than imported: the engine must not depend on the language
     * layer, because the language layer is the untrusted side of this module. The
     * composition root supplies the vocabulary; the engine only enforces it.
     */
  closedFactValues;
  // -- catalogue access -------------------------------------------------------
  listProtocols() {
    return this.loader.list();
  }
  getProtocol(protocolId, version) {
    return this.loader.get(protocolId, version);
  }
  protocolsForIncident(incidentType) {
    return this.loader.forIncidentType(incidentType).map((p) => ({
      protocolId: p.protocol_id,
      version: p.version,
      title: p.title,
      source: p.source,
      priority: p.priority,
      appliesTo: p.applies_to.incident_types,
      stepCount: p.steps.length,
      reviewStatus: p.source.review_status
    }));
  }
  /** Best matching protocol for a classified incident, or null. */
  resolveForIncident(incidentType) {
    return this.loader.resolveForIncident(incidentType);
  }
  // -- lifecycle --------------------------------------------------------------
  start(protocolId, options = {}) {
    const protocol = this.getProtocol(protocolId, options.version);
    const now = options.now ?? /* @__PURE__ */ new Date();
    const facts = normaliseFacts(options.facts ?? {});
    const contradicted = contradictedEntryConditions(protocol.entry_conditions, facts);
    if (contradicted.length > 0) {
      throw new AppError(
        ErrorCode.PROTOCOL_STEP_NOT_ACTIONABLE,
        `Known facts contradict the entry conditions of protocol '${protocol.protocol_id}'.`,
        409,
        {
          protocolId: protocol.protocol_id,
          contradicted,
          knownFacts: facts
        }
      );
    }
    if (!protocol.steps.some((s) => s.step_id === protocol.entry_step)) {
      throw AppError.validation(
        `Protocol '${protocol.protocol_id}' has no entry step '${protocol.entry_step}'.`
      );
    }
    return {
      protocolId: protocol.protocol_id,
      protocolVersion: protocol.version,
      currentStepId: protocol.entry_step,
      status: "ACTIVE",
      facts,
      completedStepIds: [],
      repeatCount: 0,
      clarificationCount: 0,
      startedAt: now,
      updatedAt: now,
      escalationRequired: false,
      escalationReason: null,
      completedAt: null
    };
  }
  /**
   * The only entry point a session should use.
   *
   * Returns both the transition and the exact state to persist, so the caller
   * cannot drift from the engine's decision.
   */
  advance(state, input = {}) {
    const result = this.applyTurn(state, input);
    const now = input.now ?? /* @__PURE__ */ new Date();
    const nextState = {
      ...state,
      currentStepId: result.currentStepId,
      status: result.status,
      facts: result.facts,
      completedStepIds: [
        ...state.completedStepIds,
        ...result.stepUpdates.filter((u) => u.status === "COMPLETED" && !state.completedStepIds.includes(u.stepId)).map((u) => u.stepId)
      ],
      repeatCount: result.action === "LOOPED" ? state.repeatCount + 1 : result.action === "ADVANCED" ? 0 : state.repeatCount,
      clarificationCount: result.action === "CLARIFY" ? state.clarificationCount + 1 : state.clarificationCount,
      updatedAt: now,
      escalationRequired: state.escalationRequired || result.action === "ESCALATED",
      escalationReason: result.escalations.length > 0 ? result.escalations[0]?.reason ?? state.escalationReason : state.escalationReason,
      // Only a transition that completes the protocol sets this. On every other
      // outcome the existing value is preserved: an escalated or looping session
      // that already has a completion timestamp must not have it cleared.
      completedAt: result.action === "COMPLETED" ? now : state.completedAt
    };
    return {
      result: {
        ...result,
        events: result.events.map((event) => ({
          ...event,
          payload: { ...event.payload, protocolSessionId: state.sessionId ?? null }
        }))
      },
      nextState
    };
  }
  /**
   * Applies a turn to the session.
   *
   * `observedFacts` is what the caller (or the LLM, already schema-validated)
   * reported. The engine merges it, re-evaluates the current step and returns the
   * next authoritative instruction.
   */
  applyTurn(state, input = {}) {
    const protocol = this.getProtocol(state.protocolId, state.protocolVersion);
    const now = input.now ?? /* @__PURE__ */ new Date();
    const step = this.requireStep(protocol, state.currentStepId);
    const previousStepId = step.step_id;
    const factsTrusted = input.factsTrusted ?? true;
    const validation = validateObservedFacts(input.observedFacts ?? {}, this.closedFactValues);
    if (validation.rejected.length > 0) {
      this.logger.warn(
        { protocolId: protocol.protocol_id, rejected: validation.rejected },
        "rejected fact values outside the declared vocabulary"
      );
    }
    const unsupported = this.unsupportedFacts(protocol, validation.accepted);
    const acceptedFacts = Object.keys(validation.accepted);
    const audit = {
      rejected: validation.rejected,
      unsupported,
      accepted: acceptedFacts
    };
    if (state.status === "COMPLETED" || state.status === "CANCELLED") {
      return this.hold(
        protocol,
        state,
        step,
        {
          action: "HELD",
          status: state.status,
          currentStepId: previousStepId,
          missingFacts: [],
          escalations: [],
          stepUpdates: [],
          events: [],
          decisionType: "HELD",
          ruleId: `${previousStepId}.session_${state.status.toLowerCase()}`,
          reason: `Session is ${state.status}; no further protocol instruction is issued.`,
          nextStepId: null,
          question: null,
          requiresClarification: false
        },
        now,
        factsTrusted,
        audit,
        state.facts,
        state.completedStepIds
      );
    }
    const facts = factsTrusted ? mergeFacts(state.facts, validation.accepted) : state.facts;
    const factsForRules = factsTrusted ? facts : mergeFacts(state.facts, validation.accepted);
    const completedStepIds = [...state.completedStepIds];
    const stepUpdates = [];
    const events = [];
    const context = this.context(protocol, {
      facts: factsForRules,
      now,
      startedAt: state.startedAt,
      completedStepIds,
      repeatCount: state.repeatCount
    });
    const escalation = this.escalation.evaluate(protocol, context);
    const critical = escalation.escalations.find((e) => e.severity === "CRITICAL");
    if (critical) {
      events.push({
        type: "PROTOCOL_ESCALATED",
        payload: {
          protocolSessionId: "",
          reason: critical.reason,
          rules: escalation.escalations.map((e) => e.ruleId),
          haltedByRule: critical.ruleId
        }
      });
      const escalationStep = critical.escalationStepId ? this.stepIfPresent(protocol, critical.escalationStepId) : void 0;
      const haltInstruction = escalationStep?.instruction ?? step.instruction;
      const haltStepId = escalationStep?.step_id ?? previousStepId;
      return this.hold(
        protocol,
        state,
        step,
        {
          action: "ESCALATED",
          status: "ESCALATED",
          currentStepId: haltStepId,
          instruction: haltInstruction,
          question: null,
          nextStepId: null,
          missingFacts: [],
          escalations: escalation.escalations,
          stepUpdates,
          events,
          decisionType: "ESCALATED",
          ruleId: critical.ruleId,
          reason: critical.reason
        },
        now,
        factsTrusted,
        audit,
        facts,
        completedStepIds
      );
    }
    const missing = missingFactsFor(step, facts);
    if (!factsTrusted) {
      const outstanding = missingFactsFor(step, state.facts);
      const question = clarificationFor(step, outstanding);
      events.push({
        type: "PROTOCOL_CLARIFICATION_REQUESTED",
        payload: {
          protocolSessionId: "",
          question,
          reason: `Facts for step '${step.step_id}' came from an untrusted source; the step was not evaluated.`
        }
      });
      const limit = this.clarificationLimit;
      if (limit > 0 && state.clarificationCount + 1 > limit) {
        const rule = {
          ruleId: "untrusted_facts",
          reason: `The reported facts could not be verified after ${limit} attempts. Handing over to a human operator.`,
          action: "BOTH",
          severity: "URGENT",
          source: { protocolId: protocol.protocol_id, protocolVersion: protocol.version }
        };
        events.push({
          type: "PROTOCOL_ESCALATED",
          payload: { protocolSessionId: "", reason: rule.reason, rules: [rule.ruleId] }
        });
        return this.hold(
          protocol,
          state,
          step,
          {
            action: "ESCALATED",
            status: "ESCALATED",
            currentStepId: previousStepId,
            question: null,
            nextStepId: null,
            missingFacts: outstanding,
            escalations: [...escalation.escalations, rule],
            stepUpdates,
            events,
            decisionType: "ESCALATED",
            ruleId: rule.ruleId,
            reason: rule.reason
          },
          now,
          factsTrusted,
          audit,
          facts,
          completedStepIds
        );
      }
      return this.hold(
        protocol,
        state,
        step,
        {
          action: input.preview ? "HELD" : "CLARIFY",
          status: input.preview ? state.status : "WAITING_FOR_RESPONSE",
          currentStepId: previousStepId,
          question,
          nextStepId: step.step_id,
          missingFacts: outstanding,
          escalations: escalation.escalations,
          stepUpdates,
          events: input.preview ? [] : events,
          decisionType: "QUESTION_REQUIRED",
          ruleId: `${step.step_id}.untrusted_facts`,
          reason: `Step '${step.step_id}' was not evaluated: the reported facts were not trusted.`,
          requiresClarification: true
        },
        now,
        factsTrusted,
        audit,
        facts,
        completedStepIds
      );
    }
    if (missing.length > 0 && step.type !== "INFO") {
      const question = clarificationFor(step, missing);
      const limit = this.clarificationLimit;
      if (limit > 0 && state.clarificationCount + 1 > limit) {
        const rule = {
          ruleId: "clarification_limit",
          reason: `The caller could not confirm the required information after ${limit} attempts. Handing over to a human operator.`,
          action: "BOTH",
          severity: "URGENT",
          source: { protocolId: protocol.protocol_id, protocolVersion: protocol.version }
        };
        events.push({
          type: "PROTOCOL_ESCALATED",
          payload: { protocolSessionId: "", reason: rule.reason, rules: [rule.ruleId] }
        });
        return this.hold(
          protocol,
          state,
          step,
          {
            action: "ESCALATED",
            status: "ESCALATED",
            currentStepId: previousStepId,
            question: null,
            nextStepId: null,
            missingFacts: missing,
            escalations: [...escalation.escalations, rule],
            stepUpdates,
            events,
            decisionType: "ESCALATED",
            ruleId: rule.ruleId,
            reason: rule.reason
          },
          now,
          factsTrusted,
          audit,
          facts,
          completedStepIds
        );
      }
      return this.hold(
        protocol,
        state,
        step,
        {
          action: "CLARIFY",
          status: "WAITING_FOR_RESPONSE",
          currentStepId: previousStepId,
          question,
          nextStepId: step.step_id,
          missingFacts: missing,
          escalations: escalation.escalations,
          stepUpdates,
          events,
          decisionType: "QUESTION_REQUIRED",
          ruleId: `${step.step_id}.missing_facts`,
          reason: `Step '${step.step_id}' still needs: ${missing.join(", ")}.`,
          requiresClarification: true
        },
        now,
        factsTrusted,
        audit,
        facts,
        completedStepIds
      );
    }
    if (input.preview) {
      const question = missing.length > 0 ? clarificationFor(step, missing) : step.question ?? null;
      return this.hold(
        protocol,
        state,
        step,
        {
          action: "HELD",
          status: state.status,
          currentStepId: previousStepId,
          question,
          nextStepId: step.step_id,
          missingFacts: missing,
          escalations: escalation.escalations,
          stepUpdates,
          events: [],
          decisionType: "QUESTION_REQUIRED",
          ruleId: `${step.step_id}.awaiting_caller`,
          reason: missing.length > 0 ? `Step '${step.step_id}' is waiting for: ${missing.join(", ")}.` : `Step '${step.step_id}' is waiting for the caller's next answer.`,
          requiresClarification: true
        },
        now,
        factsTrusted,
        audit,
        facts,
        completedStepIds
      );
    }
    const selected = selectTransition(step, context);
    if (!selected) {
      const question = step.question ?? "Can you confirm that again?";
      this.logger.warn(
        { protocolId: protocol.protocol_id, stepId: step.step_id },
        "no transition matched; holding for clarification"
      );
      const limit = this.clarificationLimit;
      if (limit > 0 && state.clarificationCount + 1 > limit) {
        const rule = {
          ruleId: "unmatched_transition",
          reason: `Step '${step.step_id}' could not be resolved from what the caller reported, after ${limit} attempts. Handing over to a human operator.`,
          action: "BOTH",
          severity: "URGENT",
          source: { protocolId: protocol.protocol_id, protocolVersion: protocol.version }
        };
        events.push({
          type: "PROTOCOL_ESCALATED",
          payload: { protocolSessionId: "", reason: rule.reason, rules: [rule.ruleId] }
        });
        return this.hold(
          protocol,
          state,
          step,
          {
            action: "ESCALATED",
            status: "ESCALATED",
            currentStepId: previousStepId,
            question: null,
            nextStepId: null,
            missingFacts: [],
            escalations: [...escalation.escalations, rule],
            stepUpdates,
            events,
            decisionType: "ESCALATED",
            ruleId: rule.ruleId,
            reason: rule.reason
          },
          now,
          factsTrusted,
          audit,
          facts,
          completedStepIds
        );
      }
      return this.hold(
        protocol,
        state,
        step,
        {
          action: "CLARIFY",
          status: "WAITING_FOR_RESPONSE",
          currentStepId: previousStepId,
          question,
          nextStepId: step.step_id,
          missingFacts: [],
          escalations: escalation.escalations,
          stepUpdates,
          events,
          decisionType: "QUESTION_REQUIRED",
          ruleId: `${step.step_id}.unmatched`,
          reason: `No transition of step '${step.step_id}' matched the facts that are known.`,
          requiresClarification: true
        },
        now,
        factsTrusted,
        audit,
        facts,
        completedStepIds
      );
    }
    const { transition, index } = selected;
    const transitionRuleId = `${step.step_id}.transition[${index}]`;
    const markComplete = (stepId, orderIndex) => {
      if (!completedStepIds.includes(stepId)) completedStepIds.push(stepId);
      stepUpdates.push({
        stepId,
        orderIndex,
        status: "COMPLETED",
        presentedAt: state.startedAt,
        completedAt: now,
        result: { transition: transition.action, note: transition.note ?? null }
      });
      events.push({
        type: "PROTOCOL_STEP_COMPLETED",
        payload: {
          protocolSessionId: "",
          stepId,
          nextStepId: transition.to,
          durationMs: now.getTime() - state.updatedAt.getTime()
        }
      });
    };
    switch (transition.action) {
      case "COMPLETE": {
        markComplete(step.step_id, step.order);
        events.push({
          type: "PROTOCOL_COMPLETED",
          payload: {
            protocolSessionId: "",
            stepsCompleted: completedStepIds.length,
            escalationRequired: escalation.escalations.length > 0 || state.escalationRequired
          }
        });
        return this.hold(
          protocol,
          state,
          step,
          {
            action: "COMPLETED",
            status: "COMPLETED",
            currentStepId: step.step_id,
            question: null,
            nextStepId: null,
            missingFacts: [],
            escalations: escalation.escalations,
            stepUpdates,
            events,
            progressPct: 100,
            decisionType: "COMPLETED",
            ruleId: transitionRuleId,
            reason: transition.note ?? `Step '${step.step_id}' completed the protocol.`
          },
          now,
          factsTrusted,
          audit,
          facts,
          completedStepIds
        );
      }
      case "ESCALATE": {
        markComplete(step.step_id, step.order);
        const rule = escalation.escalations[0] ?? {
          ruleId: "protocol_step_escalate",
          reason: transition.note ?? `Step '${step.step_id}' requires professional help.`,
          action: "BOTH",
          severity: "CRITICAL",
          source: { protocolId: protocol.protocol_id, protocolVersion: protocol.version }
        };
        events.push({
          type: "PROTOCOL_ESCALATED",
          payload: {
            protocolSessionId: "",
            reason: rule.reason,
            rules: escalation.escalations.map((e) => e.ruleId)
          }
        });
        return this.hold(
          protocol,
          state,
          step,
          {
            action: "ESCALATED",
            status: "ESCALATED",
            currentStepId: step.step_id,
            question: step.question ?? null,
            nextStepId: null,
            missingFacts: [],
            escalations: [...escalation.escalations, rule],
            stepUpdates,
            events,
            decisionType: "ESCALATED",
            ruleId: rule.ruleId,
            reason: rule.reason
          },
          now,
          factsTrusted,
          audit,
          facts,
          completedStepIds
        );
      }
      case "LOOP": {
        const repeatCount = state.repeatCount + 1;
        const exceeded = step.max_repeats !== void 0 && step.max_repeats !== null && repeatCount > step.max_repeats;
        if (exceeded) {
          const rule = {
            ruleId: `${step.step_id}.max_repeats`,
            reason: `Step '${step.step_id}' repeated ${repeatCount - 1} times without resolution. Escalating to a human operator.`,
            action: "BOTH",
            severity: "URGENT",
            source: { protocolId: protocol.protocol_id, protocolVersion: protocol.version }
          };
          markComplete(step.step_id, step.order);
          events.push({
            type: "PROTOCOL_ESCALATED",
            payload: { protocolSessionId: "", reason: rule.reason, rules: [rule.ruleId] }
          });
          return this.hold(
            protocol,
            state,
            step,
            {
              action: "ESCALATED",
              status: "ESCALATED",
              currentStepId: step.step_id,
              question: null,
              nextStepId: null,
              missingFacts: [],
              escalations: [...escalation.escalations, rule],
              stepUpdates,
              events,
              decisionType: "ESCALATED",
              ruleId: rule.ruleId,
              reason: rule.reason
            },
            now,
            factsTrusted,
            audit,
            facts,
            completedStepIds
          );
        }
        stepUpdates.push({
          stepId: step.step_id,
          orderIndex: step.order,
          status: "ACTIVE",
          presentedAt: now,
          completedAt: null,
          result: { repeatCount }
        });
        return this.hold(
          protocol,
          state,
          step,
          {
            action: "LOOPED",
            status: "ACTION_REQUIRED",
            currentStepId: step.step_id,
            question: step.question ?? null,
            nextStepId: step.step_id,
            missingFacts: [],
            escalations: escalation.escalations,
            stepUpdates,
            events,
            decisionType: "LOOPED",
            ruleId: transitionRuleId,
            reason: transition.note ?? `Step '${step.step_id}' must be repeated.`
          },
          now,
          factsTrusted,
          audit,
          facts,
          completedStepIds
        );
      }
      case "ADVANCE":
      default: {
        markComplete(step.step_id, step.order);
        const nextStep = transition.to ? this.requireStep(protocol, transition.to) : null;
        if (!nextStep) {
          events.push({
            type: "PROTOCOL_COMPLETED",
            payload: {
              protocolSessionId: "",
              stepsCompleted: completedStepIds.length,
              escalationRequired: escalation.escalations.length > 0
            }
          });
          return this.hold(
            protocol,
            state,
            step,
            {
              action: "COMPLETED",
              status: "COMPLETED",
              currentStepId: step.step_id,
              question: null,
              nextStepId: null,
              missingFacts: [],
              escalations: escalation.escalations,
              stepUpdates,
              events,
              progressPct: 100,
              decisionType: "COMPLETED",
              ruleId: transitionRuleId,
              reason: transition.note ?? `Step '${step.step_id}' completed the protocol.`
            },
            now,
            factsTrusted,
            audit,
            facts,
            completedStepIds
          );
        }
        const presentedAt = now;
        stepUpdates.push({
          stepId: nextStep.step_id,
          orderIndex: nextStep.order,
          status: "ACTIVE",
          presentedAt,
          completedAt: null,
          result: null
        });
        events.push({
          type: "PROTOCOL_STEP_PRESENTED",
          payload: {
            protocolSessionId: "",
            stepId: nextStep.step_id,
            orderIndex: nextStep.order,
            instruction: nextStep.instruction
          }
        });
        const forced = input.forceEscalationReason ? [
          {
            ruleId: "operator_override",
            reason: input.forceEscalationReason,
            action: "NOTIFY_OPERATOR",
            severity: "URGENT",
            source: { protocolId: protocol.protocol_id, protocolVersion: protocol.version }
          }
        ] : [];
        return this.hold(
          protocol,
          state,
          step,
          {
            action: "ADVANCED",
            status: nextStep.type === "ACTION" ? "ACTION_REQUIRED" : "WAITING_FOR_RESPONSE",
            currentStepId: nextStep.step_id,
            instruction: nextStep.instruction,
            question: nextStep.question ?? null,
            nextStepId: nextStep.step_id,
            missingFacts: missingFactsFor(nextStep, facts),
            escalations: [...escalation.escalations, ...forced],
            stepUpdates,
            events,
            decisionType: "ADVANCED",
            ruleId: transitionRuleId,
            reason: transition.note ?? `Step '${step.step_id}' advanced to '${nextStep.step_id}' on the facts that are known.`
          },
          now,
          factsTrusted,
          audit,
          facts,
          completedStepIds
        );
      }
    }
  }
  /**
   * What the current step is waiting for, with no state change and no events.
   *
   * This is what a caller shows before the first utterance, and what an operator
   * action reports afterwards. It goes through the same decision builder as
   * `applyTurn`, so a step presented here and the same step reached by a turn
   * produce identically shaped decisions — including the rule id and the audit
   * block, which a caller would otherwise have to reconstruct by hand.
   *
   * It is a preview, not a turn: it reports the step the session is on, never the
   * one it would move to next.
   */
  turnDecision(state, input = {}) {
    return this.applyTurn(state, {
      now: input.now,
      observedFacts: input.observedFacts,
      factsTrusted: input.factsTrusted ?? true,
      preview: true
    });
  }
  /** Renders a step without changing state (used to present the first step). */
  presentStep(state, now = /* @__PURE__ */ new Date()) {
    const protocol = this.getProtocol(state.protocolId, state.protocolVersion);
    const step = this.requireStep(protocol, state.currentStepId);
    return {
      step,
      instruction: step.instruction,
      question: step.question ?? null,
      missingFacts: missingFactsFor(step, state.facts)
    };
  }
  /** Escalation that a fresh state already triggers (e.g. unknown scene safety). */
  initialEscalations(state) {
    const protocol = this.getProtocol(state.protocolId, state.protocolVersion);
    return this.escalation.evaluate(
      protocol,
      this.context(protocol, {
        facts: state.facts,
        now: state.startedAt,
        startedAt: state.startedAt,
        completedStepIds: state.completedStepIds,
        repeatCount: state.repeatCount
      })
    ).escalations;
  }
  // -- internals --------------------------------------------------------------
  /**
   * Builds the single shape `applyTurn` returns.
   *
   * Every exit path goes through here so the flat fields and the structured
   * decision can never disagree: the decision is derived from the same values
   * that produce the flat fields, not assembled separately by each branch.
   */
  hold(protocol, state, step, spec, now, factsTrusted, audit, facts, completedStepIds) {
    const instruction = spec.instruction ?? step.instruction;
    const requiresClarification = spec.requiresClarification ?? false;
    const spokenStep = protocol.steps.find((s) => s.step_id === spec.currentStepId) ?? step;
    const presentedInstruction = {
      instructionId: instructionIdFor(protocol, spec.currentStepId),
      stepId: spec.currentStepId,
      stepType: spokenStep.type,
      orderIndex: spokenStep.order,
      text: instruction
    };
    const requiredQuestion = requiresClarification && spec.question ? {
      questionId: questionIdFor(protocol, step.step_id, state.clarificationCount + 1),
      requiredFacts: spec.missingFacts,
      text: spec.question,
      protocolState: step.step_id,
      attempt: state.clarificationCount + 1
    } : null;
    const firstEscalation = spec.escalations[0];
    const escalation = firstEscalation ? {
      ruleId: firstEscalation.ruleId,
      reason: firstEscalation.reason,
      severity: firstEscalation.severity,
      action: firstEscalation.action
    } : null;
    const decision = {
      protocolId: protocol.protocol_id,
      protocolVersion: protocol.version,
      currentState: step.step_id,
      nextState: spec.currentStepId,
      decisionType: spec.decisionType,
      instruction: presentedInstruction,
      requiredQuestion,
      escalation,
      completed: spec.status === "COMPLETED",
      missingFacts: spec.missingFacts,
      ruleId: spec.ruleId,
      reason: spec.reason,
      audit: {
        protocolVersion: protocol.version,
        protocolSource: `${protocol.source.name} (${protocol.source.publisher})`,
        reviewStatus: protocol.source.review_status,
        acceptedFacts: audit.accepted,
        rejectedFacts: audit.rejected,
        unsupportedFacts: audit.unsupported,
        factsTrusted,
        evaluatedAt: now.toISOString()
      }
    };
    return {
      action: spec.action,
      status: spec.status,
      currentStepId: spec.currentStepId,
      previousStepId: step.step_id,
      instruction,
      approvedInstruction: instruction,
      question: spec.question,
      nextStepId: spec.nextStepId,
      facts,
      missingFacts: spec.missingFacts,
      escalations: spec.escalations,
      requiresClarification,
      clarificationQuestion: requiresClarification ? spec.question : null,
      stepUpdates: spec.stepUpdates,
      events: spec.events,
      progressPct: spec.progressPct ?? this.progress(protocol, completedStepIds),
      decision
    };
  }
  /**
   * Facts the protocol has no condition for.
   *
   * Recorded rather than dropped: `notes` and `mechanism` are collected for the
   * incident record and are referenced by no condition in any protocol. Flagging
   * them here means an added fact that *is* referenced cannot go unnoticed, while
   * the genuinely free-text ones stay harmless.
   */
  unsupportedFacts(protocol, accepted) {
    const referenced = protocolFacts(protocol);
    return Object.keys(accepted).filter((fact) => !referenced.has(fact)).sort();
  }
  /**
    * Resolves a step without failing the turn.
  *
  * Used for escalation targets: a rule naming a missing step is a data error, but
  * throwing would drop the escalation the caller depends on, so the engine logs
  * it and falls back to the current step.
  */
  stepIfPresent(protocol, stepId) {
    const step = protocol.steps.find((s) => s.step_id === stepId);
    if (!step) {
      this.logger.error(
        { protocolId: protocol.protocol_id, stepId },
        "escalation rule names a step that does not exist; using the current step"
      );
    }
    return step;
  }
  requireStep(protocol, stepId) {
    const step = protocol.steps.find((s) => s.step_id === stepId);
    if (!step) {
      throw new AppError(
        ErrorCode.PROTOCOL_INVALID_TRANSITION,
        `Protocol '${protocol.protocol_id}' has no step '${stepId}'.`,
        500,
        { protocolId: protocol.protocol_id, version: protocol.version, stepId }
      );
    }
    return step;
  }
  context(protocol, input) {
    return {
      facts: withEngineFacts(
        withDerivedFacts(input.facts, {
          completedSteps: input.completedStepIds.length,
          repeatCount: input.repeatCount,
          totalSteps: protocol.steps.length
        }),
        input.now,
        input.startedAt
      ),
      now: input.now,
      sessionStartedAt: input.startedAt,
      repeatCount: input.repeatCount
    };
  }
  progress(protocol, completedStepIds) {
    if (protocol.steps.length === 0) return 0;
    return Math.min(100, Math.round(completedStepIds.length / protocol.steps.length * 100));
  }
};
function mergeFacts(current, observed) {
  const merged = { ...current };
  for (const [key, value] of Object.entries(observed)) {
    if (isUnknown(value) && !isUnknown(merged[key])) continue;
    merged[key] = value;
  }
  return merged;
}
function normaliseFacts(facts) {
  const out = {};
  for (const [key, value] of Object.entries(facts)) {
    out[key] = value === void 0 || value === null ? UNKNOWN : value;
  }
  return out;
}
function defaultClarificationFor(missing) {
  return `I still need to know: ${missing.slice(0, 2).join(" and ")}. Can you tell me?`;
}
function clarificationFor(step, missing) {
  const perFact = missing.map((fact) => step.fact_questions?.[fact]).filter((q) => typeof q === "string" && q.length > 0);
  if (perFact.length > 0) return perFact.join(" ");
  const allRequired = step.requires_facts ?? [];
  if (step.question && missing.length === allRequired.length) return step.question;
  return step.question ?? defaultClarificationFor(missing);
}

// modules/module_05_bystander_assistance/src/protocol_engine/validators.ts
var MAX_UTTERANCE = 4e3;
function validateTurnInput(input) {
  const facts = {};
  if (input.facts !== void 0 && input.facts !== null) {
    if (typeof input.facts !== "object" || Array.isArray(input.facts)) {
      throw AppError.validation("`facts` must be an object of protocol fact values.");
    }
    for (const [key, value] of Object.entries(input.facts)) {
      if (!/^[a-z][a-z0-9_]{0,40}$/.test(key)) {
        throw AppError.validation(`Fact key '${key}' is not a valid protocol fact name.`);
      }
      facts[key] = sanitiseValue(value);
    }
  }
  let utterance = null;
  if (input.utterance !== void 0 && input.utterance !== null) {
    if (typeof input.utterance !== "string") {
      throw AppError.validation("`utterance` must be a string of what the bystander said.");
    }
    if (input.utterance.length > MAX_UTTERANCE) {
      throw AppError.validation(`Utterance exceeds ${MAX_UTTERANCE} characters.`, { length: input.utterance.length });
    }
    utterance = input.utterance.trim() || null;
  }
  return {
    facts,
    utterance,
    isFinal: input.isFinal === void 0 ? true : Boolean(input.isFinal)
  };
}
function sanitiseValue(value) {
  if (value === null || value === void 0) return "UNKNOWN";
  if (typeof value === "string") return value.length > 200 ? value.slice(0, 200) : value;
  if (typeof value === "number") return Number.isFinite(value) ? value : "UNKNOWN";
  if (typeof value === "boolean") return value ? "YES" : "NO";
  if (Array.isArray(value)) return value.slice(0, 20).map(sanitiseValue);
  return "UNKNOWN";
}

// modules/module_05_bystander_assistance/src/session/sessionService.ts
var MIN_TRUSTED_CONFIDENCE = 0.6;
var ProtocolSessionService = class {
  constructor(engine, llm, sessions, logger2 = noopLogger) {
    this.engine = engine;
    this.llm = llm;
    this.sessions = sessions;
    this.logger = logger2;
  }
  logger;
  /**
   * One in-flight turn per session.
   *
   * Two concurrent utterances would both read the same `currentStep`, both
   * evaluate the same transition, and both write — so one is silently lost and the
   * session skips a step. Serialising in the process fixes the single-process
   * case, which is how this service is deployed. A multi-process deployment also
   * needs a row lock or a version column in Module 11; this is the floor, not the
   * ceiling.
   */
  turnLocks = /* @__PURE__ */ new Map();
  // -- lifecycle --------------------------------------------------------------
  async start(input) {
    const resolved = this.resolveProtocol(input);
    const llmState = await this.probeLlm();
    const validated = validateTurnInput({ facts: input.facts ?? {} });
    const assertedTrusted = input.factsTrusted === true;
    const asserted = Object.keys(validated.facts).length > 0;
    const engineState = this.engine.start(resolved.protocolId, {
      version: input.version ?? resolved.version,
      facts: assertedTrusted ? validated.facts : {}
    });
    const session = await this.sessions.createSession({
      emergencyId: input.emergencyId,
      protocolId: resolved.protocolId,
      protocolVersion: engineState.protocolVersion,
      protocolSource: resolved.source,
      currentStep: engineState.currentStepId,
      startedBy: input.startedBy ?? "SYSTEM",
      initiatedByUserId: input.initiatedByUserId ?? null,
      llmProvider: llmState.provider,
      llmModel: llmState.model,
      degraded: !llmState.available
    });
    const identified = { ...engineState, sessionId: session.id };
    const presented = this.engine.presentStep(identified);
    const turn = this.engine.turnDecision(identified, {
      now: /* @__PURE__ */ new Date(),
      observedFacts: asserted && !assertedTrusted ? validated.facts : void 0,
      factsTrusted: assertedTrusted
    });
    const initialEscalations = turn.escalations;
    const halted = turn.action === "ESCALATED";
    const { session: persisted, steps } = await this.sessions.applyTransition({
      sessionId: session.id,
      emergencyId: input.emergencyId,
      currentStep: identified.currentStepId,
      status: halted ? "ESCALATED" : "ACTIVE",
      escalationRequired: halted,
      escalationReason: halted ? initialEscalations[0]?.reason ?? null : null,
      completedAt: null,
      collectedFacts: identified.facts,
      degraded: !llmState.available,
      steps: [
        {
          stepId: identified.currentStepId,
          orderIndex: presented.step.order,
          status: "ACTIVE",
          presentedAt: /* @__PURE__ */ new Date(),
          completedAt: null,
          result: null
        }
      ],
      events: [
        {
          type: "PROTOCOL_STARTED",
          payload: {
            protocolSessionId: session.id,
            protocolId: resolved.protocolId,
            protocolVersion: engineState.protocolVersion,
            source: resolved.source
          }
        },
        {
          type: "PROTOCOL_STEP_PRESENTED",
          payload: {
            protocolSessionId: session.id,
            stepId: identified.currentStepId,
            orderIndex: presented.step.order,
            instruction: presented.instruction
          }
        },
        ...halted ? [
          {
            type: "PROTOCOL_ESCALATED",
            payload: {
              protocolSessionId: session.id,
              reason: initialEscalations[0]?.reason ?? "Protocol requires professional help.",
              rules: initialEscalations.map((e) => e.ruleId)
            }
          }
        ] : []
      ]
    });
    const speech = await this.speak(presented.instruction, presented.question, null, llmState);
    return {
      session: presentSession(persisted),
      steps,
      instruction: presented.instruction,
      question: presented.question,
      speech: speech.speech,
      tone: speech.tone,
      action: turn.action === "HELD" ? "HELD" : turn.action,
      status: persisted.status,
      currentStepId: persisted.currentStep,
      requiresClarification: turn.requiresClarification,
      clarificationQuestion: turn.clarificationQuestion,
      paraphrased: speech.paraphrased,
      degraded: !llmState.available,
      escalationRequired: halted,
      escalations: initialEscalations.map(compactEscalation),
      missingFacts: turn.missingFacts,
      progressPct: 0,
      llmNotice: speech.notice,
      decision: turn.decision
    };
  }
  /**
   * The main loop: caller speaks, engine decides, everything is persisted.
   */
  async handleUtterance(input) {
    const validated = validateTurnInput({ utterance: input.utterance });
    const utterance = validated.utterance;
    if (utterance === null) {
      throw AppError.validation("An utterance is required; the request contained no usable speech.");
    }
    return this.serialise(input.sessionId, () => this.runTurn(input, utterance));
  }
  /**
   * Runs one turn, one session at a time.
   *
   * The lock is held across the read, the model call, the engine call and the
   * write, which is the whole point: releasing it any earlier reintroduces the
   * lost update this exists to prevent.
   */
  async serialise(sessionId, work) {
    const previous = this.turnLocks.get(sessionId) ?? Promise.resolve();
    const result = previous.then(work, work);
    this.turnLocks.set(
      sessionId,
      result.catch(() => void 0)
    );
    try {
      return await result;
    } finally {
      if (this.turnLocks.get(sessionId) === void 0) this.turnLocks.delete(sessionId);
      else {
        const pending = this.turnLocks.get(sessionId);
        if (pending) void pending.then(() => this.turnLocks.delete(sessionId));
      }
    }
  }
  async runTurn(input, utterance) {
    const session = await this.requireSession(input.sessionId);
    this.assertOpen(session);
    const engineState = this.toEngineState(session);
    const extraction = await this.extract(session, engineState, utterance);
    const now = /* @__PURE__ */ new Date();
    const advance = this.engine.advance(engineState, {
      observedFacts: factsFrom(extraction),
      utterance,
      now,
      forceEscalationReason: input.forceEscalationReason ?? null,
      // An extraction the provider itself is unsure about may not move the
      // protocol. It can still escalate and it can still ask again.
      factsTrusted: extraction.factsTrusted
    });
    const result = advance.result;
    const received = {
      type: "CALLER_RESPONSE_RECEIVED",
      payload: {
        protocolSessionId: session.id,
        stepId: engineState.currentStepId,
        responseText: utterance,
        matchedIntent: extraction.facts?.intent ?? null,
        confidence: extraction.confidence
      }
    };
    const { session: persisted, steps } = await this.sessions.applyTransition({
      sessionId: session.id,
      emergencyId: session.emergencyId,
      currentStep: result.currentStepId,
      status: result.status,
      completedAt: result.status === "COMPLETED" ? now : null,
      escalationRequired: advance.nextState.escalationRequired,
      escalationReason: advance.nextState.escalationReason,
      clarificationCount: advance.nextState.clarificationCount,
      collectedFacts: withBookkeeping(advance.nextState.facts, {
        completedSteps: advance.nextState.completedStepIds,
        repeatCount: advance.nextState.repeatCount
      }),
      degraded: extraction.degraded,
      steps: result.stepUpdates,
      events: [
        received,
        ...result.events,
        // A provider outage is an operational event, not just a log line: an
        // incident timeline that cannot show the model was down cannot explain a
        // clarification the caller had to answer three times.
        ...extraction.failureReason ? [
          {
            type: "LLM_CALL_FAILED",
            payload: {
              protocolSessionId: session.id,
              provider: extraction.provider,
              model: extraction.model,
              reason: extraction.failureReason,
              degraded: true
            }
          }
        ] : []
      ]
    });
    const llmState = {
      provider: extraction.provider,
      model: extraction.model,
      available: !extraction.degraded
    };
    const speech = await this.speak(result.approvedInstruction, result.question, input.utterance, llmState);
    const tone = result.action === "ESCALATED" ? "URGENT" : result.status === "ACTION_REQUIRED" ? "URGENT" : "CALM";
    return {
      session: presentSession(persisted),
      steps,
      instruction: result.approvedInstruction,
      question: result.question,
      speech: speech.speech,
      tone,
      action: result.action,
      status: persisted.status,
      currentStepId: persisted.currentStep,
      requiresClarification: result.requiresClarification,
      clarificationQuestion: result.clarificationQuestion,
      paraphrased: speech.paraphrased,
      degraded: extraction.degraded,
      escalationRequired: advance.nextState.escalationRequired,
      escalations: result.escalations.map(compactEscalation),
      missingFacts: result.missingFacts,
      progressPct: result.progressPct,
      llmNotice: extraction.notice ?? speech.notice,
      decision: result.decision
    };
  }
  // -- operator actions -------------------------------------------------------
  /** Emergency services reached the scene: stop the protocol. */
  async cancel(sessionId, reason = "Cancelled by operator.") {
    const session = await this.requireSession(sessionId);
    if (session.status === "CANCELLED") return this.toTurn(session, await this.sessions.stepsForSession(sessionId));
    const now = /* @__PURE__ */ new Date();
    const { session: persisted, steps } = await this.sessions.applyTransition({
      sessionId,
      emergencyId: session.emergencyId,
      currentStep: session.currentStep,
      status: "CANCELLED",
      completedAt: now,
      collectedFacts: session.collectedFacts,
      events: [
        {
          type: "PROTOCOL_CANCELLED",
          payload: { protocolSessionId: sessionId, reason }
        }
      ]
    });
    return this.toTurn(persisted, steps);
  }
  /** Operator override: hand the caller to a human immediately. */
  async escalate(sessionId, reason) {
    const session = await this.requireSession(sessionId);
    if (session.status === "ESCALATED" || session.status === "COMPLETED") {
      return this.toTurn(session, await this.sessions.stepsForSession(sessionId));
    }
    const { session: persisted, steps } = await this.sessions.applyTransition({
      sessionId,
      emergencyId: session.emergencyId,
      currentStep: session.currentStep,
      status: "ESCALATED",
      escalationRequired: true,
      escalationReason: reason,
      // Deliberately not terminal: an escalated session stays open so the
      // operator can still read the transcript and the collected facts.
      completedAt: null,
      collectedFacts: session.collectedFacts,
      events: [
        {
          type: "PROTOCOL_ESCALATED",
          payload: { protocolSessionId: sessionId, reason, rules: ["operator_override"] }
        }
      ]
    });
    return this.toTurn(persisted, steps);
  }
  async get(sessionId) {
    const found = await this.requireSession(sessionId);
    return {
      session: presentSession(found),
      steps: await this.sessions.stepsForSession(sessionId)
    };
  }
  async listForEmergency(emergencyId) {
    const rows = await this.sessions.listSessionsForEmergency(emergencyId);
    return rows.map(presentSession);
  }
  listProtocols() {
    return this.engine.listProtocols();
  }
  protocolsForIncident(incidentType) {
    return this.engine.protocolsForIncident(incidentType);
  }
  // -- internals --------------------------------------------------------------
  resolveProtocol(input) {
    if (input.protocolId) {
      const protocol = this.engine.getProtocol(input.protocolId, input.version);
      return { protocolId: protocol.protocol_id, version: protocol.version, source: describeSource(protocol.source) };
    }
    if (!input.incidentType) {
      throw AppError.validation(
        "Either protocolId or incidentType must be supplied so a protocol can be selected."
      );
    }
    const match = this.engine.resolveForIncident(input.incidentType);
    if (!match) {
      const available = this.engine.protocolsForIncident(input.incidentType).map((p) => `${p.protocolId}@${p.version}`).join(", ");
      throw new AppError(
        ErrorCode.PROTOCOL_NOT_FOUND,
        `No protocol is registered for incident type '${input.incidentType}'.`,
        404,
        { incidentType: input.incidentType, available }
      );
    }
    return { protocolId: match.protocol_id, version: match.version, source: describeSource(match.source) };
  }
  async probeLlm() {
    try {
      const resolved = await this.llm.resolve();
      return { provider: resolved.service.providerName, model: resolved.service.model, available: true };
    } catch (error) {
      this.logger.warn(
        { reason: error.message },
        "no LLM available at session start; protocol flow uses catalogue only"
      );
      return { provider: "none", model: "none", available: false };
    }
  }
  /**
   * Fact extraction only. Any failure is recorded and turned into UNKNOWN facts
   * so the engine asks the caller instead of guessing.
   */
  async extract(session, engineState, utterance) {
    try {
      const resolved = await this.llm.resolve();
      const extraction = await resolved.service.extract(utterance, {
        knownFacts: engineState.facts ?? {},
        currentStepQuestion: this.currentQuestion(engineState),
        protocolId: session.protocolId
      });
      const facts = { ...extraction.entities, intent: extraction.intent };
      const factsTrusted = this.trustExtraction(resolved, extraction);
      return {
        facts,
        degraded: resolved.degraded,
        provider: resolved.service.providerName,
        model: resolved.service.model,
        notice: resolved.degraded ? `Language model unavailable; using the deterministic keyword fallback. Extraction is degraded.` : null,
        failureReason: resolved.degraded ? resolved.reason ?? "primary provider unavailable" : null,
        confidence: extraction.confidence,
        factsTrusted
      };
    } catch (error) {
      this.logger.warn(
        { sessionId: session.id, reason: error.message },
        "fact extraction failed; asking the caller rather than guessing"
      );
      return {
        facts: null,
        degraded: true,
        provider: "none",
        model: "none",
        notice: "Could not understand that automatically, so the assistant will ask again.",
        failureReason: error.message,
        confidence: null,
        // Nothing was extracted, so nothing is being asserted. The engine's own
        // missing-fact check decides what to ask; there is no claim to distrust.
        factsTrusted: true
      };
    }
  }
  /**
   * Decides whether an extraction is entitled to move the protocol.
   *
   * The asymmetry is the whole point: a fact that is wrong in the cautious
   * direction costs the caller one more question, while a fact that is wrong in
   * the confident direction has them start chest compressions on someone breathing
   * normally. So a language model's output has to clear a confidence bar and must
   * not be self-flagged as needing clarification.
   *
   * The deterministic fallback is treated as trusted even though it reports a low
   * confidence, because it is not a guess: it is a fixed keyword matcher whose
   * failure modes are the documented ones, it caps its own confidence rather than
   * claiming certainty, and it already forces `requires_clarification`. Judging it
   * by the confidence number would make every offline session stall on the first
   * turn, which would remove the safety net rather than tighten it.
   */
  trustExtraction(resolved, extraction) {
    if (resolved.service.providerName === "heuristic-fallback") return true;
    if (extraction.requires_clarification) return false;
    return extraction.confidence >= MIN_TRUSTED_CONFIDENCE;
  }
  async speak(instruction, question, callerUtterance, llm) {
    const spoken = [instruction, question].filter(Boolean).join(" ");
    if (!llm.available) {
      return { speech: spoken, tone: "CALM", paraphrased: false, notice: null };
    }
    try {
      const resolved = await this.llm.resolve();
      const response = await resolved.service.respond({
        instruction,
        question,
        callerUtterance,
        tone: "CALM"
      });
      const verdict = assertSafeRephrasing(spoken, response.speech);
      if (!verdict.safe) {
        this.logger.warn(
          { reason: verdict.reason, inventedNumbers: verdict.inventedNumbers, droppedActions: verdict.droppedActions },
          "rejected LLM paraphrase; speaking the protocol wording verbatim"
        );
        return { speech: spoken, tone: "CALM", paraphrased: false, notice: null };
      }
      return { speech: response.speech, tone: response.tone, paraphrased: true, notice: null };
    } catch (error) {
      this.logger.warn({ reason: error.message }, "paraphrase failed; speaking the protocol wording");
      return { speech: spoken, tone: "CALM", paraphrased: false, notice: null };
    }
  }
  async requireSession(sessionId) {
    const session = await this.sessions.getSession(sessionId);
    if (!session) {
      throw new AppError(ErrorCode.NOT_FOUND, `Protocol session '${sessionId}' was not found.`, 404, {
        sessionId
      });
    }
    return session;
  }
  assertOpen(session) {
    if (session.status === "COMPLETED") {
      throw new AppError(
        ErrorCode.PROTOCOL_ESCALATION_REQUIRED,
        `Protocol session '${session.id}' has already completed and cannot continue.`,
        409,
        { sessionId: session.id, status: session.status }
      );
    }
    if (session.status === "CANCELLED") {
      throw new AppError(
        ErrorCode.PROTOCOL_ESCALATION_REQUIRED,
        `Protocol session '${session.id}' was cancelled and cannot continue.`,
        409,
        { sessionId: session.id, status: session.status }
      );
    }
  }
  /** Rebuilds engine state from the persisted row. */
  toEngineState(session) {
    const stored = session.collectedFacts;
    return {
      sessionId: session.id,
      protocolId: session.protocolId,
      protocolVersion: session.protocolVersion,
      currentStepId: session.currentStep,
      status: session.status,
      facts: stripEngineFacts(session.collectedFacts),
      completedStepIds: Array.isArray(stored.__completedSteps) ? stored.__completedSteps : [],
      repeatCount: Number(stored.__repeatCount ?? 0),
      clarificationCount: session.clarificationCount,
      startedAt: new Date(session.startedAt),
      updatedAt: new Date(session.updatedAt),
      escalationRequired: session.escalationRequired,
      escalationReason: session.escalationReason,
      completedAt: session.completedAt ? new Date(session.completedAt) : null
    };
  }
  currentQuestion(state) {
    try {
      return this.engine.presentStep(state).question;
    } catch {
      return null;
    }
  }
  toTurn(session, steps) {
    return {
      session: presentSession(session),
      steps,
      instruction: "",
      question: null,
      speech: "",
      tone: session.status === "ESCALATED" ? "URGENT" : "CALM",
      action: "HELD",
      status: session.status,
      currentStepId: session.currentStep,
      requiresClarification: false,
      clarificationQuestion: null,
      paraphrased: false,
      degraded: false,
      escalationRequired: session.escalationRequired,
      escalations: session.escalationReason ? [{ ruleId: "session", reason: session.escalationReason, severity: "URGENT", action: "NOTIFY_OPERATOR" }] : [],
      missingFacts: [],
      progressPct: 0,
      llmNotice: null,
      decision: this.engine.turnDecision(this.toEngineState(session), {
        // Operator-driven transitions carry no model output, so nothing in them is
        // model-sourced.
        factsTrusted: true
      }).decision
    };
  }
};
function factsFrom(extraction) {
  if (!extraction.facts) return {};
  const facts = {};
  for (const [key, value] of Object.entries(extraction.facts)) {
    if (value === null || value === void 0) continue;
    if (value === UNKNOWN) continue;
    facts[key] = value;
  }
  return facts;
}
function compactEscalation(e) {
  return { ruleId: e.ruleId, reason: e.reason, severity: e.severity, action: e.action };
}
function describeSource(source) {
  return `${source.name} (${source.publisher}) [${source.review_status}]`;
}
function stripEngineFacts(facts) {
  const out = {};
  for (const [key, value] of Object.entries(facts)) {
    if (key.startsWith("__")) continue;
    out[key] = value;
  }
  return out;
}
function presentSession(session) {
  const stored = session.collectedFacts;
  if (!stored) return session;
  const cleaned = stripEngineFacts(stored);
  if (Object.keys(cleaned).length === Object.keys(stored).length) return session;
  return { ...session, collectedFacts: cleaned };
}
function withBookkeeping(facts, bookkeeping) {
  return {
    ...stripEngineFacts(facts),
    __completedSteps: bookkeeping.completedSteps,
    __repeatCount: bookkeeping.repeatCount
  };
}

// modules/module_05_bystander_assistance/src/module.ts
var Module5 = class {
  engine;
  loader;
  llm;
  sessions;
  config;
  turnOrchestrator;
  logger;
  constructor(deps) {
    this.config = deps.config ?? loadModule5Config();
    this.logger = deps.logger ?? noopLogger;
    this.turnOrchestrator = deps.turnOrchestrator ?? null;
    this.loader = new ProtocolLoader(this.config.protocol.directory);
    this.engine = new ProtocolEngine(
      this.loader,
      void 0,
      this.config.clarificationLimit,
      closedFactValues()
    );
    const registry = createDefaultRegistry(this.config.llm, deps.providers ?? []);
    this.llm = new LlmGateway(registry, this.config.llm, this.logger);
    this.sessions = new ProtocolSessionService(this.engine, this.llm, deps.sessions, this.logger);
  }
  /** Fail fast on a malformed catalogue rather than at first call. */
  async preload() {
    const protocols = this.loader.list();
    const steps = protocols.reduce((total, p) => total + this.loader.get(p.protocolId, p.version).steps.length, 0);
    return { protocols: protocols.length, steps };
  }
  routes() {
    return createModule5Routes(this);
  }
  register(table) {
    table.addAll(this.routes());
  }
};

// modules/module_06_ambulance_management/src/config.ts
function loadModule6Config() {
  return {
    fleet: {
      maxStaleLocationMinutes: Number(process.env.MODULE6_MAX_STALE_LOCATION_MIN ?? 10),
      maxAmbulances: Number(process.env.MODULE6_MAX_AMBULANCES ?? 50),
      defaultAverageSpeedKmh: Number(process.env.MODULE6_DEFAULT_SPEED_KMH ?? 40),
      trafficFactor: Number(process.env.MODULE6_TRAFFIC_FACTOR ?? 1.25)
    },
    assignment: {
      timeoutMs: Number(process.env.MODULE6_ASSIGN_TIMEOUT_MS ?? 5e3),
      maxRetries: Number(process.env.MODULE6_ASSIGN_MAX_RETRIES ?? 3),
      minConfidenceScore: Number(process.env.MODULE6_MIN_SCORE ?? 0.3),
      enableManualOverride: Boolean(process.env.MODULE6_ALLOW_MANUAL_OVERRIDE !== "false")
    },
    dispatch: {
      timeoutMs: Number(process.env.MODULE6_DISPATCH_TIMEOUT_MS ?? 5e3),
      requireValidLocation: Boolean(process.env.MODULE6_REQUIRE_VALID_LOCATION !== "false")
    },
    simulation: {
      enabled: Boolean(process.env.MODULE6_SIMULATION_ENABLED === "true"),
      updateIntervalMs: Number(process.env.MODULE6_SIMULATION_INTERVAL_MS ?? 2e3)
    },
    autoDispatch: {
      // Automatic assignment is opt-in. Missing, malformed, or explicitly false
      // values all keep the event-driven subscriber disabled.
      enabled: process.env.MODULE6_AUTO_DISPATCH_ENABLED?.toLowerCase() === "true",
      includeSimulation: Boolean(process.env.MODULE6_AUTO_DISPATCH_SIMULATION === "true")
    }
  };
}

// modules/module_06_ambulance_management/src/fleetService.ts
var DISPATCH_MANAGED_STATUSES = /* @__PURE__ */ new Set(["DISPATCHED", "EN_ROUTE"]);
function rejectDispatchManagedStatus(status) {
  if (status && DISPATCH_MANAGED_STATUSES.has(status)) {
    throw AppError.validation(
      `Ambulance status '${status}' can only be set through the explicit dispatch operation.`
    );
  }
}
var FleetService = class {
  ambulances;
  events;
  config;
  logger;
  constructor(deps) {
    this.ambulances = deps.ambulances;
    this.events = deps.events;
    this.config = deps.config;
    this.logger = deps.logger ?? noopLogger;
  }
  async registerAmbulance(input) {
    rejectDispatchManagedStatus(input.status);
    const ambulance = await this.ambulances.create(input);
    await this.events.record(
      defineEvent("AMBULANCE_CREATED", {
        entityType: "ambulance",
        entityId: ambulance.id,
        payload: {
          ambulanceId: ambulance.id,
          vehicleNumber: ambulance.vehicleNumber,
          isSimulation: ambulance.isSimulation
        }
      })
    );
    return ambulance;
  }
  async listAmbulances(options = {}) {
    return this.ambulances.list(options);
  }
  async getAmbulance(id) {
    return this.ambulances.requireById(id);
  }
  async updateAmbulance(id, patch) {
    rejectDispatchManagedStatus(patch.status);
    const previous = await this.ambulances.findById(id);
    const updated = await this.ambulances.update(id, patch);
    const changed = [];
    if (previous && patch.status !== void 0 && previous.status !== patch.status) {
      changed.push(`status:${previous.status}->${patch.status}`);
      await this.events.record(
        defineEvent("AMBULANCE_STATUS_CHANGED", {
          entityType: "ambulance",
          entityId: id,
          payload: {
            ambulanceId: id,
            from: previous.status,
            to: patch.status
          }
        })
      );
    }
    if (changed.length > 0) {
      await this.events.record(
        defineEvent("AMBULANCE_UPDATED", {
          entityType: "ambulance",
          entityId: id,
          payload: {
            ambulanceId: id,
            changed
          }
        })
      );
    }
    return updated;
  }
  async recordLocation(input) {
    if (!isValidCoordinate({ latitude: input.latitude, longitude: input.longitude })) {
      throw AppError.validation("Invalid coordinates for ambulance location update", {
        latitude: input.latitude,
        longitude: input.longitude
      });
    }
    return this.ambulances.appendLocation(input);
  }
  async findNearestAmbulances(options) {
    if (!isValidCoordinate({ latitude: options.latitude, longitude: options.longitude })) {
      throw AppError.validation("Invalid coordinates for nearest ambulance search");
    }
    const statuses = options.statuses ?? ["AVAILABLE"];
    const ambulances = await this.ambulances.list({ statuses, includeSimulation: true });
    const candidates = [];
    for (const ambulance of ambulances) {
      if (options.excludeIds?.includes(ambulance.id)) continue;
      const location = await this.ambulances.latestLocation(ambulance.id);
      let isStale = false;
      if (location?.recordedAt) {
        const ageMin = (Date.now() - new Date(location.recordedAt).getTime()) / 6e4;
        isStale = ageMin > this.config.fleet.maxStaleLocationMinutes;
      } else if (ambulance.lastLocationUpdate) {
        const ageMin = (Date.now() - new Date(ambulance.lastLocationUpdate).getTime()) / 6e4;
        isStale = ageMin > this.config.fleet.maxStaleLocationMinutes;
      } else if (ambulance.latitude !== null && ambulance.longitude !== null) {
        isStale = true;
      } else {
        isStale = true;
      }
      if (isStale && !options.includeStale) continue;
      const lat = location?.latitude ?? ambulance.latitude;
      const lng = location?.longitude ?? ambulance.longitude;
      if (lat === null || lng === null) continue;
      const distanceKm = haversineKm({ latitude: options.latitude, longitude: options.longitude }, { latitude: lat, longitude: lng });
      candidates.push({ ambulance, distanceKm, location, isStale });
    }
    candidates.sort((a, b) => a.distanceKm - b.distanceKm);
    if (options.maxResults) {
      return candidates.slice(0, options.maxResults);
    }
    return candidates;
  }
  async findNearestAvailable(options) {
    const candidates = await this.findNearestAmbulances({ ...options, statuses: ["AVAILABLE"] });
    return candidates[0] ?? null;
  }
  async assignAmbulance(request) {
    const ambulance = await this.ambulances.requireById(request.ambulanceId);
    if (ambulance.status !== "AVAILABLE" && request.source !== "MANUAL_OVERRIDE") {
      throw new AppError(ErrorCode.AMBULANCE_NOT_AVAILABLE, `Ambulance ${request.ambulanceId} is not available`, 409);
    }
    const activeAssignment = await this.ambulances.activeAssignmentFor(request.ambulanceId);
    if (activeAssignment) {
      throw new AppError(ErrorCode.CONFLICT, `Ambulance ${request.ambulanceId} already has active assignment`, 409);
    }
    const assignment = await this.ambulances.createAssignment({
      emergencyId: request.emergencyId,
      ambulanceId: request.ambulanceId,
      source: request.source ?? "AUTOMATIC",
      distanceKm: request.distanceKm,
      estimatedResponseTimeMin: request.estimatedResponseTimeMin,
      score: request.score,
      matchingFactors: request.matchingFactors,
      rejectedReasons: request.rejectedReasons,
      overrideReason: request.overrideReason ?? null,
      consideredCandidates: request.consideredCandidates,
      decidedByUserId: request.decidedByUserId
    });
    return assignment;
  }
  async dispatchAmbulance(ambulanceId, emergencyId, dispatchedByUserId) {
    if (typeof this.ambulances.dispatchAssignment === "function") {
      await this.ambulances.dispatchAssignment({ ambulanceId, emergencyId, dispatchedByUserId });
      return;
    }
    const ambulance = await this.ambulances.requireById(ambulanceId);
    await this.ambulances.update(ambulanceId, {
      status: "EN_ROUTE"
    });
    await this.events.record(
      defineEvent("AMBULANCE_DISPATCHED", {
        emergencyId,
        entityType: "ambulance",
        entityId: ambulanceId,
        payload: {
          ambulanceId,
          emergencyId
        }
      })
    );
    await this.events.record(
      defineEvent("AMBULANCE_STATUS_CHANGED", {
        entityType: "ambulance",
        entityId: ambulanceId,
        payload: {
          ambulanceId,
          from: ambulance.status,
          to: "EN_ROUTE"
        }
      })
    );
  }
  async getLatestLocation(ambulanceId) {
    return this.ambulances.latestLocation(ambulanceId);
  }
  async getAssignedAmbulanceForDriver(driverId) {
    return this.ambulances.getAssignedAmbulanceForDriver(driverId);
  }
  async getDriverAssignment(driverId) {
    return this.ambulances.activeAssignmentForDriver(driverId);
  }
  async respondToDriverAssignment(input) {
    return this.ambulances.respondToAssignment(input);
  }
  async getAssignmentsForEmergency(emergencyId) {
    return this.ambulances.assignmentsForEmergency(emergencyId);
  }
};

// modules/module_06_ambulance_management/src/assignment/assignmentService.ts
var AssignmentService = class {
  fleet;
  config;
  logger;
  constructor(deps) {
    this.fleet = deps.fleet;
    this.config = deps.config;
    this.logger = deps.logger ?? noopLogger;
  }
  async selectAndAssign(criteria) {
    const existing = await this.fleet.getAssignmentsForEmergency(criteria.emergencyId);
    if (existing.some((item) => ["ASSIGNED", "ACCEPTED", "DISPATCHED"].includes(item.status))) {
      throw new AppError(ErrorCode.CONFLICT, "This emergency already has an active ambulance assignment.", 409);
    }
    const candidates = await this.fleet.findNearestAmbulances({
      latitude: criteria.latitude,
      longitude: criteria.longitude,
      statuses: ["AVAILABLE"]
    });
    if (candidates.length === 0) {
      throw new Error("No available ambulances found");
    }
    let eligible = candidates;
    if (criteria.maxDistanceKm !== void 0 && criteria.maxDistanceKm > 0) {
      eligible = candidates.filter((c) => c.distanceKm <= criteria.maxDistanceKm);
    }
    if (eligible.length === 0) {
      throw new Error("No ambulances within distance threshold");
    }
    const best = eligible[0];
    if (!best) {
      throw new Error("No suitable ambulance found");
    }
    const score = this.calculateScore(best, eligible.length);
    const assignment = await this.fleet.assignAmbulance({
      emergencyId: criteria.emergencyId,
      ambulanceId: best.ambulance.id,
      distanceKm: best.distanceKm,
      estimatedResponseTimeMin: estimateTravelMinutes(
        best.distanceKm,
        this.config.fleet.defaultAverageSpeedKmh,
        this.config.fleet.trafficFactor
      ),
      score,
      matchingFactors: ["nearest", "available"],
      rejectedReasons: {},
      source: "AUTOMATIC",
      consideredCandidates: candidates.length,
      decidedByUserId: criteria.decidedByUserId
    });
    return {
      ambulanceId: best.ambulance.id,
      assignmentId: assignment.id,
      distanceKm: best.distanceKm,
      estimatedResponseTimeMin: assignment.estimatedResponseTimeMin,
      score,
      consideredCandidates: candidates.length,
      matchingFactors: assignment.matchingFactors
    };
  }
  calculateScore(candidate, total) {
    const baseScore = 1 - Math.min(candidate.distanceKm / 50, 0.9);
    return Math.max(this.config.assignment.minConfidenceScore, baseScore);
  }
};

// modules/module_06_ambulance_management/src/tracking/trackingService.ts
var TrackingService = class {
  fleet;
  logger;
  constructor(deps) {
    this.fleet = deps.fleet;
    this.logger = deps.logger ?? noopLogger;
  }
  async updateLocation(input) {
    try {
      return await this.fleet.recordLocation(input);
    } catch (error) {
      this.logger.error({ error, ambulanceId: input.ambulanceId }, "Failed to update ambulance location");
      throw error;
    }
  }
  async getLatestLocation(ambulanceId) {
    return this.fleet.getLatestLocation(ambulanceId);
  }
  isLocationFresh(location, maxStaleMinutes) {
    if (!location) return false;
    const ageMin = (Date.now() - new Date(location.recordedAt).getTime()) / 6e4;
    return ageMin <= maxStaleMinutes;
  }
};

// modules/module_06_ambulance_management/src/dispatch/autoDispatchService.ts
var AUTO_DISPATCH_EVENT_TYPES = [
  "EMERGENCY_CREATED",
  "EMERGENCY_CLASSIFIED"
];
var DISPATCHABLE_STATUSES = /* @__PURE__ */ new Set([
  "CREATED",
  "CALL_ACTIVE",
  "CLASSIFIED",
  "PROTOCOL_ACTIVE",
  "AWAITING_AMBULANCE"
]);
var AutoDispatchService = class {
  assignment;
  fleet;
  emergencies;
  config;
  logger;
  unsubscribe;
  inFlightEmergencies = /* @__PURE__ */ new Map();
  inFlightEvents = /* @__PURE__ */ new Set();
  disposed = false;
  constructor(deps) {
    this.assignment = deps.assignment;
    this.fleet = deps.fleet;
    this.emergencies = deps.emergencies;
    this.config = deps.config;
    this.logger = deps.logger ?? noopLogger;
    this.unsubscribe = deps.events.subscribe(
      AUTO_DISPATCH_EVENT_TYPES,
      (event) => this.onEvent(event)
    );
  }
  /** Awaits every event the bus has handed to this subscriber that is still running. */
  async idle() {
    while (this.inFlightEvents.size > 0) {
      await Promise.allSettled([...this.inFlightEvents]);
    }
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
  }
  /** Handles one event record. Exposed so tests can drive it without a bus. */
  async handleEvent(event) {
    const emergencyId = this.emergencyIdFrom(event);
    if (!emergencyId) {
      return { emergencyId: "", outcome: "SKIPPED_NOT_FOUND", reason: "event carried no emergency id" };
    }
    return this.dispatchForEmergency(emergencyId);
  }
  /**
   * Runs an automatic assignment decision for one emergency. Assignment does
   * not emit `AMBULANCE_DISPATCHED`; dispatch remains an explicit operation.
   *
   * The in-flight map is keyed by emergency id and set synchronously before the
   * first `await`, so two events arriving back-to-back cannot both reach the
   * assignment engine.
   */
  async dispatchForEmergency(emergencyId) {
    if (this.disposed) {
      return { emergencyId, outcome: "SKIPPED_STATUS", reason: "automatic assignment disposed" };
    }
    if (this.inFlightEmergencies.has(emergencyId)) {
      return { emergencyId, outcome: "SKIPPED_IN_FLIGHT" };
    }
    const run = this.run(emergencyId);
    this.inFlightEmergencies.set(emergencyId, run);
    try {
      const result = await run;
      this.logResult(result);
      return result;
    } finally {
      this.inFlightEmergencies.delete(emergencyId);
    }
  }
  onEvent(event) {
    const task = this.handleEvent(event).then(
      () => void 0,
      (error) => {
        this.logger.error(
          {
            eventId: event.id,
            eventType: event.type,
            error: error instanceof Error ? error.message : String(error)
          },
          "automatic assignment subscriber threw"
        );
      }
    ).finally(() => {
      this.inFlightEvents.delete(task);
    });
    this.inFlightEvents.add(task);
  }
  emergencyIdFrom(event) {
    if (event.emergencyId) return event.emergencyId;
    const payload = event.payload;
    return typeof payload?.emergencyId === "string" ? payload.emergencyId : null;
  }
  async run(emergencyId) {
    const emergency = await this.emergencies.findById(emergencyId);
    if (!emergency) {
      return { emergencyId, outcome: "SKIPPED_NOT_FOUND", reason: "emergency not found" };
    }
    if (emergency.isSimulation && !(this.config.autoDispatch?.includeSimulation ?? false)) {
      return { emergencyId, outcome: "SKIPPED_SIMULATION" };
    }
    if (!DISPATCHABLE_STATUSES.has(emergency.status)) {
      return { emergencyId, outcome: "SKIPPED_STATUS", reason: `status ${emergency.status}` };
    }
    if (!isValidCoordinate({ latitude: emergency.latitude, longitude: emergency.longitude })) {
      return { emergencyId, outcome: "SKIPPED_INVALID_LOCATION" };
    }
    const assignments = await this.fleet.getAssignmentsForEmergency(emergencyId);
    const active = assignments.find((assignment) => assignment.status === "ASSIGNED");
    if (active) {
      return {
        emergencyId,
        outcome: "SKIPPED_ALREADY_ASSIGNED",
        ambulanceId: active.ambulanceId,
        assignmentId: active.id
      };
    }
    try {
      const result = await this.assignment.selectAndAssign({
        emergencyId,
        latitude: emergency.latitude,
        longitude: emergency.longitude
      });
      return {
        emergencyId,
        outcome: "ASSIGNED",
        ambulanceId: result.ambulanceId,
        assignmentId: result.assignmentId
      };
    } catch (error) {
      return this.toFailure(emergencyId, error);
    }
  }
  toFailure(emergencyId, error) {
    const reason = error instanceof Error ? error.message : String(error);
    const code = isAppError(error) ? error.code : void 0;
    const noCandidate = code === ErrorCode.AMBULANCE_NOT_AVAILABLE || code === ErrorCode.AMBULANCE_ALREADY_ASSIGNED || code === ErrorCode.AMBULANCE_NO_CANDIDATE || code === ErrorCode.CONFLICT || /no (available|candidate|suitable)/i.test(reason);
    return { emergencyId, outcome: noCandidate ? "NO_AMBULANCE" : "FAILED", reason };
  }
  logResult(result) {
    if (result.outcome === "ASSIGNED") {
      this.logger.info(
        {
          emergencyId: result.emergencyId,
          ambulanceId: result.ambulanceId,
          assignmentId: result.assignmentId
        },
        "automatic assignment selected an ambulance"
      );
      return;
    }
    if (result.outcome === "NO_AMBULANCE" || result.outcome === "FAILED") {
      this.logger.warn({ ...result }, "automatic assignment could not assign an ambulance");
      return;
    }
    this.logger.debug({ ...result }, "automatic assignment skipped");
  }
};

// modules/module_06_ambulance_management/src/api/routes.ts
import { z as z10 } from "zod";
function parseDriverDecision(schema, value) {
  const result = schema.safeParse(value ?? {});
  if (!result.success) throw AppError.validation("The driver decision body is invalid.", { issues: result.error.issues });
  return result.data;
}
function createModule6Routes(fleet, assignment, tracking) {
  const createAmbulanceBody = z10.object({
    vehicleNumber: z10.string().min(1).max(50),
    latitude: z10.number().min(-90).max(90).optional(),
    longitude: z10.number().min(-180).max(180).optional(),
    equipment: z10.array(z10.string()).optional(),
    stationName: z10.string().optional(),
    isSimulation: z10.boolean().optional(),
    status: z10.string().optional()
  });
  const locationUpdateBody = z10.object({
    latitude: z10.number().min(-90).max(90),
    longitude: z10.number().min(-180).max(180),
    speedKmh: z10.number().optional(),
    headingDeg: z10.number().optional(),
    accuracyM: z10.number().optional(),
    source: z10.string().optional(),
    isSimulation: z10.boolean().optional()
  });
  const assignBody = z10.object({
    emergencyId: z10.string().min(1),
    latitude: z10.number().min(-90).max(90),
    longitude: z10.number().min(-180).max(180),
    maxDistanceKm: z10.number().positive().optional()
  });
  const dispatchBody = z10.object({
    emergencyId: z10.string().min(1)
  });
  const driverAcceptBody = z10.object({}).strict().optional();
  const driverDeclineBody = z10.object({ reason: z10.string().trim().max(500).optional() }).strict().optional();
  const assertMayUpdateLocation = async (req, ambulanceId) => {
    const user = req.user;
    if (!user || user.role !== "DRIVER" && user.role !== "AMBULANCE_DRIVER") return;
    const assigned = await fleet.getAssignedAmbulanceForDriver(user.userId);
    const activeAssignment = await fleet.getDriverAssignment(user.userId);
    if (!assigned || assigned.id !== ambulanceId || !activeAssignment || activeAssignment.ambulance.id !== ambulanceId || !["ASSIGNED", "ACCEPTED", "DISPATCHED"].includes(activeAssignment.assignment.status)) {
      throw new AppError(
        ErrorCode.FORBIDDEN,
        "This driver is not assigned to the ambulance being updated.",
        403
      );
    }
  };
  return [
    {
      method: "GET",
      url: "/api/ambulances",
      module: "module_06",
      summary: "List ambulances",
      auth: { roles: ["OPERATOR", "DISPATCHER", "ADMIN"] },
      handler: async (_req, reply) => {
        const ambulances = await fleet.listAmbulances({ includeSimulation: true });
        return reply.send({ ambulances });
      }
    },
    {
      method: "POST",
      url: "/api/ambulances",
      module: "module_06",
      summary: "Register ambulance",
      auth: { roles: ["DISPATCHER", "ADMIN"] },
      body: createAmbulanceBody,
      handler: async (req, reply) => {
        const body = createAmbulanceBody.parse(req.body);
        const ambulance = await fleet.registerAmbulance(body);
        return reply.status(201).send({ ambulance });
      }
    },
    {
      method: "GET",
      url: "/api/ambulances/:id",
      module: "module_06",
      summary: "Get ambulance",
      auth: { roles: ["OPERATOR", "DISPATCHER", "ADMIN"] },
      handler: async (req, reply) => {
        const id = String(req.params.id);
        const ambulance = await fleet.getAmbulance(id);
        const location = await fleet.getLatestLocation(id);
        return reply.send({ ambulance, location });
      }
    },
    {
      method: "PATCH",
      url: "/api/ambulances/:id",
      module: "module_06",
      summary: "Update ambulance",
      auth: { roles: ["DISPATCHER", "ADMIN"] },
      handler: async (req, reply) => {
        const id = String(req.params.id);
        const ambulance = await fleet.updateAmbulance(id, req.body);
        return reply.send({ ambulance });
      }
    },
    {
      method: "POST",
      url: "/api/ambulances/:id/location",
      module: "module_06",
      summary: "Update ambulance location",
      auth: { roles: ["DISPATCHER", "ADMIN", "DRIVER", "AMBULANCE_DRIVER"], public: false },
      body: locationUpdateBody,
      handler: async (req, reply) => {
        const id = String(req.params.id);
        const body = locationUpdateBody.parse(req.body);
        await assertMayUpdateLocation(req, id);
        const ambulance = await fleet.getAmbulance(id);
        const isDriver = req.user?.role === "DRIVER" || req.user?.role === "AMBULANCE_DRIVER";
        const location = await tracking.updateLocation({
          ambulanceId: id,
          ...body,
          source: isDriver ? "MOBILE" : "OPERATOR",
          isSimulation: ambulance.isSimulation
        });
        return reply.send({ location });
      }
    },
    {
      method: "POST",
      url: "/api/ambulances/assign",
      module: "module_06",
      summary: "Assign nearest ambulance",
      auth: { roles: ["DISPATCHER", "ADMIN"] },
      body: assignBody,
      handler: async (req, reply) => {
        const body = assignBody.parse(req.body);
        const result = await assignment.selectAndAssign({
          emergencyId: body.emergencyId,
          latitude: body.latitude,
          longitude: body.longitude,
          maxDistanceKm: body.maxDistanceKm,
          decidedByUserId: req.user?.userId ?? null
        });
        return reply.send(result);
      }
    },
    {
      method: "POST",
      url: "/api/ambulances/:id/dispatch",
      module: "module_06",
      summary: "Dispatch ambulance",
      auth: { roles: ["DISPATCHER", "ADMIN"] },
      body: dispatchBody,
      handler: async (req, reply) => {
        const id = String(req.params.id);
        const body = dispatchBody.parse(req.body);
        await fleet.dispatchAmbulance(id, body.emergencyId, req.user?.userId ?? null);
        return reply.send({ ok: true });
      }
    },
    {
      method: "GET",
      url: "/api/ambulances/nearest",
      module: "module_06",
      summary: "Find nearest available ambulance",
      auth: { roles: ["OPERATOR", "DISPATCHER", "ADMIN"] },
      query: z10.object({
        latitude: z10.coerce.number().min(-90).max(90),
        longitude: z10.coerce.number().min(-180).max(180)
      }),
      handler: async (req, reply) => {
        const query = req.query;
        const candidate = await fleet.findNearestAvailable({
          latitude: query.latitude,
          longitude: query.longitude
        });
        if (!candidate) return reply.send({ candidate: null });
        return reply.send({ candidate });
      }
    },
    {
      method: "GET",
      url: "/api/drivers/me/assignment",
      module: "module_06",
      summary: "Get current driver assignment",
      auth: { roles: ["DRIVER", "AMBULANCE_DRIVER", "DISPATCHER", "ADMIN"] },
      handler: async (req, reply) => {
        const user = req.user;
        if (!user) {
          return reply.status(401).send({ error: { code: "UNAUTHORIZED", message: "Authentication required" } });
        }
        const ambulance = await fleet.getAssignedAmbulanceForDriver(user.userId);
        if (!ambulance) {
          return reply.send({ assigned: false, ambulance: null, assignment: null });
        }
        const current = await fleet.getDriverAssignment(user.userId);
        if (!current || current.ambulance.id !== ambulance.id) {
          return reply.send({ assigned: false, ambulance: null, assignment: null });
        }
        return reply.send({ assigned: true, ambulance: current.ambulance, assignment: current.assignment });
      }
    },
    {
      method: "POST",
      url: "/api/drivers/me/assignment/:assignmentId/accept",
      module: "module_06",
      summary: "Accept the authenticated driver\u2019s pending assignment",
      auth: { roles: ["DRIVER", "AMBULANCE_DRIVER"] },
      params: z10.object({ assignmentId: z10.string().min(1).max(128) }).strict(),
      handler: async (req, reply) => {
        const user = req.user;
        if (!user) throw new AppError(ErrorCode.UNAUTHORIZED, "Authentication required.", 401);
        const { assignmentId } = z10.object({ assignmentId: z10.string().min(1).max(128) }).parse(req.params);
        parseDriverDecision(driverAcceptBody, req.body);
        const result = await fleet.respondToDriverAssignment({ assignmentId, driverId: user.userId, decision: "ACCEPT" });
        return reply.send({ assignment: result });
      }
    },
    {
      method: "POST",
      url: "/api/drivers/me/assignment/:assignmentId/decline",
      module: "module_06",
      summary: "Decline the authenticated driver\u2019s pending assignment",
      auth: { roles: ["DRIVER", "AMBULANCE_DRIVER"] },
      params: z10.object({ assignmentId: z10.string().min(1).max(128) }).strict(),
      handler: async (req, reply) => {
        const user = req.user;
        if (!user) throw new AppError(ErrorCode.UNAUTHORIZED, "Authentication required.", 401);
        const { assignmentId } = z10.object({ assignmentId: z10.string().min(1).max(128) }).parse(req.params);
        const { reason } = parseDriverDecision(driverDeclineBody, req.body) ?? {};
        const result = await fleet.respondToDriverAssignment({ assignmentId, driverId: user.userId, decision: "DECLINE", reason });
        return reply.send({ assignment: result, reassignmentRequired: true });
      }
    }
  ];
}

// modules/module_06_ambulance_management/src/module.ts
var Module6 = class {
  fleet;
  assignment;
  tracking;
  autoDispatch;
  config;
  logger;
  deps;
  constructor(deps) {
    this.config = deps.config ?? loadModule6Config();
    this.logger = deps.logger ?? noopLogger;
    this.deps = deps;
    this.fleet = new FleetService({
      ambulances: deps.ambulances,
      events: deps.events,
      config: this.config,
      logger: this.logger
    });
    this.assignment = new AssignmentService({
      fleet: this.fleet,
      config: this.config,
      logger: this.logger
    });
    this.tracking = new TrackingService({
      fleet: this.fleet,
      logger: this.logger
    });
    const autoDispatchEnabled = this.config.autoDispatch?.enabled ?? false;
    this.autoDispatch = deps.bus && deps.emergencies && autoDispatchEnabled ? new AutoDispatchService({
      events: deps.bus,
      assignment: this.assignment,
      fleet: this.fleet,
      emergencies: deps.emergencies,
      config: this.config,
      logger: this.logger
    }) : void 0;
  }
  routes() {
    return createModule6Routes(this.fleet, this.assignment, this.tracking);
  }
  register(table) {
    table.addAll(this.routes());
  }
};

// modules/module_07_hospital_intelligence/src/config.ts
function loadModule7Config() {
  return {
    maxDistanceKm: Number(process.env.MODULE7_MAX_DISTANCE_KM ?? 30),
    autoSelect: {
      // Automatic selection is opt-in. Missing or malformed values fail closed.
      enabled: process.env.MODULE7_AUTO_SELECT_ENABLED?.toLowerCase() === "true",
      includeSimulation: Boolean(process.env.MODULE7_AUTO_SELECT_SIMULATION === "true")
    },
    scoring: {
      capabilityMatch: Number(process.env.MODULE7_SCORE_CAPABILITY ?? 40),
      resourceAvailable: Number(process.env.MODULE7_SCORE_RESOURCE ?? 30),
      acceptingEmergencies: Number(process.env.MODULE7_SCORE_ACCEPTING ?? 30),
      distanceBands: [
        { maxKm: 5, points: 30 },
        { maxKm: 10, points: 20 },
        { maxKm: 20, points: 10 }
      ]
    }
  };
}

// modules/module_07_hospital_intelligence/src/suitability.ts
var REQUIREMENTS = {
  CARDIAC_ARREST: { capability: "ED_CARDIAC", resourceType: "ICU_BED" },
  CHEST_PAIN: { capability: "ED_CARDIAC", resourceType: "ICU_BED" },
  STROKE: { capability: "NEUROSURGERY", resourceType: "ICU_BED" },
  TRAUMA: { capability: "ED_TRAUMA", resourceType: "EMERGENCY_BED" },
  SEVERE_BLEEDING: { capability: "ED_TRAUMA", resourceType: "EMERGENCY_BED" },
  SEVERE_BREATHING_DIFFICULTY: { capability: "RESPIRATORY", resourceType: "EMERGENCY_BED" },
  OVERDOSE: { capability: "POISON_CONTROL", resourceType: "EMERGENCY_BED" },
  CHOKING: { capability: "GENERAL", resourceType: "EMERGENCY_BED" },
  UNCONSCIOUS: { capability: "GENERAL", resourceType: "EMERGENCY_BED" },
  SEIZURE: { capability: "GENERAL", resourceType: "EMERGENCY_BED" },
  ALLERGIC_REACTION: { capability: "GENERAL", resourceType: "EMERGENCY_BED" },
  UNSAFE_SCENE: { capability: "GENERAL", resourceType: "EMERGENCY_BED" },
  OTHER: { capability: "GENERAL", resourceType: "EMERGENCY_BED" }
};
function requirementFor(incidentType) {
  return REQUIREMENTS[incidentType] ?? REQUIREMENTS.OTHER;
}
function availableUnits(hospital, resourceType) {
  let units = 0;
  for (const resource of hospital.resources) {
    if (resource.resourceType === resourceType && resource.available > 0) {
      units += resource.available;
    }
  }
  return units;
}
function distancePoints(distanceKm, config) {
  for (const band of config.scoring.distanceBands) {
    if (distanceKm <= band.maxKm) return band.points;
  }
  return 0;
}
function scoreHospital(hospital, incident, config) {
  const requirement = requirementFor(incident.incidentType);
  const distanceKm = haversineKm(
    { latitude: incident.latitude, longitude: incident.longitude },
    { latitude: hospital.latitude, longitude: hospital.longitude }
  );
  const matchingFactors = [];
  let rejectReason = null;
  if (hospital.status === "CLOSED") {
    rejectReason = "hospital is closed";
  } else if (!hospital.acceptingEmergencies) {
    rejectReason = "hospital is not accepting emergencies";
  } else if (distanceKm > config.maxDistanceKm) {
    rejectReason = `beyond ${config.maxDistanceKm} km`;
  }
  const units = availableUnits(hospital, requirement.resourceType);
  if (!rejectReason && units <= 0) {
    rejectReason = `no ${requirement.resourceType} available`;
  }
  const eligible = rejectReason === null;
  let score = 0;
  if (eligible) {
    if (hospital.capabilities.includes(requirement.capability)) {
      score += config.scoring.capabilityMatch;
      matchingFactors.push(`has ${requirement.capability}`);
    }
    score += config.scoring.resourceAvailable;
    matchingFactors.push(`${requirement.resourceType} available`);
    score += config.scoring.acceptingEmergencies;
    matchingFactors.push("accepting emergencies");
    const band = distancePoints(distanceKm, config);
    if (band > 0) {
      score += band;
      matchingFactors.push(`within ${config.maxDistanceKm} km`);
    }
  }
  return {
    hospital,
    distanceKm,
    score,
    eligible,
    rejectReason,
    matchingFactors
  };
}

// modules/module_07_hospital_intelligence/src/hospitalSelectionService.ts
var TERMINAL_STATUSES = /* @__PURE__ */ new Set(["COMPLETED", "CANCELLED"]);
function round2(value) {
  return Math.round(value * 100) / 100;
}
var HospitalSelectionService = class {
  hospitals;
  emergencies;
  events;
  config;
  logger;
  inFlight = /* @__PURE__ */ new Map();
  constructor(deps) {
    this.hospitals = deps.hospitals;
    this.emergencies = deps.emergencies;
    this.events = deps.events;
    this.config = deps.config;
    this.logger = deps.logger ?? noopLogger;
  }
  async rank(incident) {
    const hospitals = await this.hospitals.listWithResources({ includeSimulation: true });
    const scored = hospitals.map((hospital) => scoreHospital(hospital, incident, this.config));
    const eligible = scored.filter((candidate) => candidate.eligible);
    const rejected = scored.filter((candidate) => !candidate.eligible);
    eligible.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.distanceKm !== b.distanceKm) return a.distanceKm - b.distanceKm;
      return a.hospital.name.localeCompare(b.hospital.name);
    });
    return {
      selected: eligible[0] ?? null,
      ranked: eligible,
      rejected,
      consideredCandidates: scored.length
    };
  }
  /** Ranks and, if a hospital qualifies, records the choice on the emergency. */
  async selectForEmergency(emergencyId) {
    const existing = this.inFlight.get(emergencyId);
    if (existing) return existing;
    const selection = this.selectOnce(emergencyId);
    this.inFlight.set(emergencyId, selection);
    try {
      return await selection;
    } finally {
      if (this.inFlight.get(emergencyId) === selection) this.inFlight.delete(emergencyId);
    }
  }
  async selectOnce(emergencyId) {
    const emergency = await this.emergencies.findById(emergencyId);
    if (!emergency) {
      return { emergencyId, outcome: "SKIPPED_NOT_FOUND", reason: "emergency not found" };
    }
    if (emergency.isSimulation && !(this.config.autoSelect?.includeSimulation ?? false)) {
      return { emergencyId, outcome: "SKIPPED_SIMULATION" };
    }
    if (emergency.selectedHospitalId) {
      return {
        emergencyId,
        outcome: "SKIPPED_ALREADY_SELECTED",
        hospitalId: emergency.selectedHospitalId
      };
    }
    if (TERMINAL_STATUSES.has(emergency.status)) {
      return { emergencyId, outcome: "SKIPPED_STATUS", reason: `status ${emergency.status}` };
    }
    if (!isValidCoordinate({ latitude: emergency.latitude, longitude: emergency.longitude })) {
      return { emergencyId, outcome: "SKIPPED_INVALID_LOCATION" };
    }
    try {
      const ranking = await this.rank({
        incidentType: emergency.incidentType,
        latitude: emergency.latitude,
        longitude: emergency.longitude
      });
      const selected = ranking.selected;
      if (!selected) {
        this.logger.warn(
          { emergencyId, consideredCandidates: ranking.consideredCandidates },
          "auto hospital selection found no suitable candidate"
        );
        return {
          emergencyId,
          outcome: "NO_CANDIDATE",
          consideredCandidates: ranking.consideredCandidates
        };
      }
      const distanceKm = round2(selected.distanceKm);
      const reason = selected.matchingFactors.join(", ") || "nearest suitable hospital";
      await this.emergencies.update(
        emergencyId,
        { selectedHospitalId: selected.hospital.id },
        { type: "HOSPITAL_SELECTED", payload: { hospitalId: selected.hospital.id, emergencyId, distanceKm, reason } }
      );
      await this.recordRejections(emergencyId, ranking.rejected);
      this.logger.info(
        {
          emergencyId,
          hospitalId: selected.hospital.id,
          hospitalName: selected.hospital.name,
          distanceKm,
          score: selected.score,
          consideredCandidates: ranking.consideredCandidates
        },
        "auto hospital selection chose a hospital"
      );
      return {
        emergencyId,
        outcome: "SELECTED",
        hospitalId: selected.hospital.id,
        hospitalName: selected.hospital.name,
        distanceKm,
        reason,
        consideredCandidates: ranking.consideredCandidates
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error({ emergencyId, error: reason }, "auto hospital selection failed");
      return { emergencyId, outcome: "FAILED", reason };
    }
  }
  /**
   * Records why in-range hospitals were ruled out.
   *
   * Only candidates within the distance limit are reported: an out-of-range
   * hospital is not a rejection, it is simply not in the search area, and
   * logging it would drown the signal.
   */
  async recordRejections(emergencyId, rejected) {
    for (const candidate of rejected) {
      if (candidate.rejectReason === null) continue;
      if (candidate.distanceKm > this.config.maxDistanceKm) continue;
      try {
        await this.events.record(
          defineEvent("HOSPITAL_REJECTED", {
            emergencyId,
            entityType: "hospital",
            entityId: candidate.hospital.id,
            payload: {
              emergencyId,
              hospitalId: candidate.hospital.id,
              reason: candidate.rejectReason
            }
          })
        );
      } catch (error) {
        this.logger.warn(
          { emergencyId, hospitalId: candidate.hospital.id, error: error instanceof Error ? error.message : String(error) },
          "failed to record hospital rejection"
        );
      }
    }
  }
};

// modules/module_07_hospital_intelligence/src/autoSelectService.ts
var AUTO_SELECT_EVENT_TYPES = ["EMERGENCY_CLASSIFIED"];
var AutoSelectService = class {
  selection;
  logger;
  unsubscribe;
  inFlightEmergencies = /* @__PURE__ */ new Map();
  inFlightEvents = /* @__PURE__ */ new Set();
  disposed = false;
  constructor(deps) {
    this.selection = deps.selection;
    this.logger = deps.logger ?? noopLogger;
    this.unsubscribe = deps.events.subscribe(
      AUTO_SELECT_EVENT_TYPES,
      (event) => this.onEvent(event)
    );
  }
  /** Awaits every event the bus has handed to this subscriber that is still running. */
  async idle() {
    while (this.inFlightEvents.size > 0) {
      await Promise.allSettled([...this.inFlightEvents]);
    }
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
  }
  /** Handles one event record. Exposed so tests can drive it without a bus. */
  async handleEvent(event) {
    const emergencyId = this.emergencyIdFrom(event);
    if (!emergencyId) {
      return { emergencyId: "", outcome: "SKIPPED_NOT_FOUND", reason: "event carried no emergency id" };
    }
    return this.selectForEmergency(emergencyId);
  }
  /**
   * Runs the selection decision for one emergency.
   *
   * The in-flight map is keyed by emergency id and set synchronously before the
   * first `await`, so two events arriving back-to-back cannot both reach the
   * selection engine.
   */
  async selectForEmergency(emergencyId) {
    if (this.disposed) {
      return { emergencyId, outcome: "SKIPPED_STATUS", reason: "auto-select disposed" };
    }
    if (this.inFlightEmergencies.has(emergencyId)) {
      return { emergencyId, outcome: "SKIPPED_ALREADY_SELECTED", reason: "selection already in flight" };
    }
    const run = this.selection.selectForEmergency(emergencyId);
    this.inFlightEmergencies.set(emergencyId, run);
    try {
      const result = await run;
      this.logResult(result);
      return result;
    } finally {
      this.inFlightEmergencies.delete(emergencyId);
    }
  }
  onEvent(event) {
    const task = this.handleEvent(event).then(
      () => void 0,
      (error) => {
        this.logger.error(
          {
            eventId: event.id,
            eventType: event.type,
            error: error instanceof Error ? error.message : String(error)
          },
          "auto hospital selection subscriber threw"
        );
      }
    ).finally(() => {
      this.inFlightEvents.delete(task);
    });
    this.inFlightEvents.add(task);
  }
  emergencyIdFrom(event) {
    if (event.emergencyId) return event.emergencyId;
    const payload = event.payload;
    return typeof payload?.emergencyId === "string" ? payload.emergencyId : null;
  }
  logResult(result) {
    if (result.outcome === "SELECTED") return;
    if (result.outcome === "NO_CANDIDATE" || result.outcome === "FAILED") {
      this.logger.warn({ ...result }, "auto hospital selection could not select a hospital");
      return;
    }
    this.logger.debug({ ...result }, "auto hospital selection skipped");
  }
};

// modules/module_07_hospital_intelligence/src/api/routes.ts
import { z as z11 } from "zod";
var emergencyParams = z11.object({ id: z11.string().min(1).max(128) });
var hospitalParams = z11.object({ hospitalId: z11.string().min(1).max(128) });
var resourceUpdateBody = z11.object({
  resourceType: z11.enum(HOSPITAL_RESOURCE_TYPES),
  code: z11.string().max(64).optional(),
  total: z11.number().int().min(0),
  available: z11.number().int().min(0)
}).strict().refine((body) => body.available <= body.total, {
  message: "available cannot exceed total",
  path: ["available"]
});
function createModule7Routes(selection, hospitalResources) {
  const routes = [
    {
      method: "POST",
      url: "/api/emergencies/:id/hospital-selection",
      module: "module_07",
      summary: "Select a suitable hospital for an emergency",
      auth: { roles: ["DISPATCHER", "ADMIN"] },
      params: emergencyParams,
      body: z11.object({}).strict(),
      handler: async (request, reply) => {
        const emergencyId = emergencyParams.parse(request.params).id;
        const result = await selection.selectForEmergency(emergencyId);
        switch (result.outcome) {
          case "SKIPPED_NOT_FOUND":
            throw AppError.notFound("Emergency", emergencyId);
          case "SKIPPED_SIMULATION":
            throw new AppError(ErrorCode.CONFLICT, "Hospital selection is not enabled for simulation emergencies.", 409);
          case "SKIPPED_STATUS":
            throw new AppError(ErrorCode.CONFLICT, result.reason ?? "Hospital selection is not available for this emergency state.", 409);
          case "NO_CANDIDATE":
            throw new AppError(ErrorCode.HOSPITAL_NO_SUITABLE_CANDIDATE, "No suitable hospital is available for this emergency.", 422, {
              consideredCandidates: result.consideredCandidates ?? 0
            });
          case "FAILED":
            throw new AppError(ErrorCode.INTERNAL_ERROR, "Hospital selection failed.", 500);
          case "SELECTED":
          case "SKIPPED_ALREADY_SELECTED":
            reply.send({ emergencyId, result });
            return;
        }
      }
    }
  ];
  if (hospitalResources) {
    routes.push({
      method: "PATCH",
      url: "/api/hospitals/:hospitalId/resources",
      module: "module_07",
      summary: "Update one hospital resource availability count and record HOSPITAL_RESOURCE_UPDATED",
      auth: { roles: ["DISPATCHER", "ADMIN"] },
      params: hospitalParams,
      body: resourceUpdateBody,
      handler: async (request, reply) => {
        const { hospitalId } = hospitalParams.parse(request.params);
        const body = resourceUpdateBody.parse(request.body);
        const resource = await hospitalResources.updateResourceAvailability({
          hospitalId,
          resourceType: body.resourceType,
          code: body.code ?? null,
          total: body.total,
          available: body.available,
          actor: {
            actorType: request.user?.role ?? "OPERATOR",
            actorId: request.user?.userId ?? null
          }
        });
        reply.send({ hospitalId, resource });
      }
    });
  }
  return routes;
}

// modules/module_07_hospital_intelligence/src/module.ts
var Module7 = class {
  selection;
  autoSelect;
  config;
  logger;
  hospitalResources;
  constructor(deps) {
    this.config = deps.config ?? loadModule7Config();
    this.logger = deps.logger ?? noopLogger;
    this.hospitalResources = deps.hospitalResources;
    this.selection = new HospitalSelectionService({
      hospitals: deps.hospitals,
      emergencies: deps.emergencies,
      events: deps.events,
      config: this.config,
      logger: this.logger
    });
    const autoSelectEnabled = this.config.autoSelect?.enabled ?? false;
    this.autoSelect = deps.bus && autoSelectEnabled ? new AutoSelectService({
      events: deps.bus,
      selection: this.selection,
      logger: this.logger
    }) : void 0;
  }
  dispose() {
    this.autoSelect?.dispose();
  }
  routes() {
    return createModule7Routes(this.selection, this.hospitalResources);
  }
  register(table) {
    table.addAll(this.routes());
  }
};

// modules/module_08_route_optimization/src/config.ts
function loadModule8Config(env = process.env) {
  const provider = env.MODULE8_PROVIDER === "osrm" || env.MODULE8_PROVIDER === "google" ? env.MODULE8_PROVIDER : "mock";
  const googleApiKey = env.MODULE8_GOOGLE_API_KEY?.trim() || null;
  const configuredGoogleTimeout = Number(env.MODULE8_GOOGLE_TIMEOUT_MS ?? 8e3);
  const googleTimeoutMs = Number.isFinite(configuredGoogleTimeout) ? configuredGoogleTimeout : 8e3;
  if (provider === "google" && !googleApiKey) {
    throw new Error("MODULE8_GOOGLE_API_KEY is required when MODULE8_PROVIDER=google.");
  }
  if (provider === "google" && (!Number.isInteger(configuredGoogleTimeout) || googleTimeoutMs < 100 || googleTimeoutMs > 6e4)) {
    throw new Error("MODULE8_GOOGLE_TIMEOUT_MS must be between 100 and 60000 when Google routing is enabled.");
  }
  return {
    provider,
    averageSpeedKmh: Number(env.MODULE8_AVERAGE_SPEED_KMH ?? 60),
    osrm: {
      baseUrl: env.MODULE8_OSRM_BASE_URL ?? "http://router.project-osrm.org",
      timeoutMs: Number(env.MODULE8_OSRM_TIMEOUT_MS ?? 8e3)
    },
    google: { apiKey: googleApiKey, timeoutMs: googleTimeoutMs },
    generation: {
      // Automatic route generation is opt-in. Missing or malformed values fail closed.
      enabled: env.MODULE8_AUTO_ROUTE_ENABLED?.toLowerCase() === "true",
      includeSimulation: Boolean(env.MODULE8_AUTO_ROUTE_SIMULATION === "true")
    }
  };
}

// modules/module_08_route_optimization/src/providers/mockRoutingProvider.ts
var MOCK_ROUTING_PROVIDER_NAME = "mock";
var MockRoutingProvider = class {
  constructor(averageSpeedKmh) {
    this.averageSpeedKmh = averageSpeedKmh;
  }
  providerName = MOCK_ROUTING_PROVIDER_NAME;
  isLive = false;
  isLiveTraffic = false;
  async route(request) {
    const speedKmh = this.averageSpeedKmh > 0 ? this.averageSpeedKmh : 60;
    const distanceKm = haversineKm(request.origin, request.destination);
    const estimatedMinutes = distanceKm / speedKmh * 60;
    const candidate = {
      distanceKm,
      estimatedMinutes,
      // Core geometry is ordered [lat, lng] to match Module 11's stored polyline.
      geometry: [
        [request.origin.latitude, request.origin.longitude],
        [request.destination.latitude, request.destination.longitude]
      ],
      trafficFactor: 1
    };
    return {
      providerName: this.providerName,
      isLiveTraffic: false,
      selected: candidate,
      alternatives: [],
      selectionReason: "Straight-line (great-circle) distance at a fixed average speed \u2014 a deterministic estimate, not a traffic-aware road route."
    };
  }
};

// modules/module_08_route_optimization/src/providers/routingProviderError.ts
var RoutingProviderError = class extends Error {
  constructor(message, providerName) {
    super(message);
    this.providerName = providerName;
    this.name = "RoutingProviderError";
  }
};

// modules/module_08_route_optimization/src/providers/osrmRoutingProvider.ts
var OSRM_ROUTING_PROVIDER_NAME = "osrm";
var OsrmRoutingProvider = class {
  providerName = OSRM_ROUTING_PROVIDER_NAME;
  isLive = true;
  isLiveTraffic = false;
  baseUrl;
  timeoutMs;
  fetchImpl;
  constructor(options) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 8e3;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (typeof this.fetchImpl !== "function") {
      throw new Error("OsrmRoutingProvider requires a fetch implementation.");
    }
  }
  async route(request) {
    const { origin, destination } = request;
    const url = `${this.baseUrl}/route/v1/driving/${origin.longitude},${origin.latitude};${destination.longitude},${destination.latitude}?overview=full&geometries=geojson`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(url, { signal: controller.signal });
    } catch (error) {
      const aborted = controller.signal.aborted || error?.name === "AbortError";
      throw new RoutingProviderError(
        aborted ? `OSRM did not respond within ${this.timeoutMs}ms.` : `OSRM is unreachable: ${error instanceof Error ? error.message : String(error)}`,
        this.providerName
      );
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      throw new RoutingProviderError(`OSRM returned HTTP ${response.status}.`, this.providerName);
    }
    let body;
    try {
      body = await response.json();
    } catch {
      throw new RoutingProviderError("OSRM response was not valid JSON.", this.providerName);
    }
    if (body.code !== "Ok") {
      throw new RoutingProviderError(
        `OSRM routing failed: code=${String(body.code)}, message=${String(body.message ?? "unknown")}`,
        this.providerName
      );
    }
    const routes = Array.isArray(body.routes) ? body.routes : [];
    const route = routes[0];
    if (!route) {
      throw new RoutingProviderError("OSRM response contained no route.", this.providerName);
    }
    const coordinates = route.geometry?.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 2) {
      throw new RoutingProviderError("OSRM route had no usable geometry.", this.providerName);
    }
    const geometry = coordinates.map((pair) => {
      if (!Array.isArray(pair) || pair.length < 2) {
        throw new RoutingProviderError("OSRM geometry contained a malformed position.", this.providerName);
      }
      const [lng, lat] = pair;
      if (typeof lat !== "number" || typeof lng !== "number") {
        throw new RoutingProviderError("OSRM geometry contained a non-numeric position.", this.providerName);
      }
      return [lat, lng];
    });
    const distanceKm = typeof route.distance === "number" ? route.distance / 1e3 : Number.NaN;
    const estimatedMinutes = typeof route.duration === "number" ? route.duration / 60 : Number.NaN;
    if (!Number.isFinite(distanceKm) || !Number.isFinite(estimatedMinutes)) {
      throw new RoutingProviderError("OSRM route had no usable distance or duration.", this.providerName);
    }
    const candidate = {
      distanceKm,
      estimatedMinutes,
      geometry,
      trafficFactor: 1
    };
    return {
      providerName: this.providerName,
      isLiveTraffic: false,
      selected: candidate,
      alternatives: [],
      selectionReason: "Road route from OSRM (static speed profile; not traffic-aware)."
    };
  }
};

// modules/module_08_route_optimization/src/providers/googleRoutesProvider.ts
var GOOGLE_ROUTES_PROVIDER_NAME = "google-routes";
var GOOGLE_ROUTES_COMPUTE_ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";
var FIELD_MASK = "routes.distanceMeters,routes.duration,routes.staticDuration,routes.polyline.encodedPolyline,routes.fallbackInfo";
var MAX_ENCODED_POLYLINE_LENGTH = 1e6;
var MAX_POLYLINE_POINTS = 5e4;
function parseSeconds(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d+(?:\.\d+)?)s$/.exec(value);
  if (!match) return null;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}
function decodePolyline(encoded) {
  if (encoded.length === 0 || encoded.length > MAX_ENCODED_POLYLINE_LENGTH) {
    throw new RoutingProviderError("Google route had no usable encoded geometry.", GOOGLE_ROUTES_PROVIDER_NAME);
  }
  const points = [];
  let index = 0;
  let latitudeE5 = 0;
  let longitudeE5 = 0;
  const readDelta = () => {
    let result = 0;
    let shift = 0;
    let chunk;
    do {
      if (index >= encoded.length || shift > 30) {
        throw new RoutingProviderError("Google route geometry was malformed.", GOOGLE_ROUTES_PROVIDER_NAME);
      }
      const code = encoded.charCodeAt(index++);
      chunk = code - 63;
      if (chunk < 0 || chunk > 63) {
        throw new RoutingProviderError("Google route geometry was malformed.", GOOGLE_ROUTES_PROVIDER_NAME);
      }
      result |= (chunk & 31) << shift;
      shift += 5;
    } while (chunk >= 32);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (index < encoded.length) {
    latitudeE5 += readDelta();
    longitudeE5 += readDelta();
    const point = { latitude: latitudeE5 / 1e5, longitude: longitudeE5 / 1e5 };
    if (!isValidCoordinate(point)) {
      throw new RoutingProviderError("Google route geometry contained an out-of-range coordinate.", GOOGLE_ROUTES_PROVIDER_NAME);
    }
    points.push([point.latitude, point.longitude]);
    if (points.length > MAX_POLYLINE_POINTS) {
      throw new RoutingProviderError("Google route geometry exceeded the point limit.", GOOGLE_ROUTES_PROVIDER_NAME);
    }
  }
  if (points.length < 2) {
    throw new RoutingProviderError("Google route geometry contained fewer than two points.", GOOGLE_ROUTES_PROVIDER_NAME);
  }
  return points;
}
var GoogleRoutesProvider = class {
  providerName = GOOGLE_ROUTES_PROVIDER_NAME;
  isLive = true;
  /** Capability flag only; each response's traffic provenance is per-route. */
  isLiveTraffic = true;
  apiKey;
  timeoutMs;
  fetchImpl;
  constructor(options) {
    this.apiKey = options.apiKey.trim();
    this.timeoutMs = options.timeoutMs ?? 8e3;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (!this.apiKey) throw new Error("GoogleRoutesProvider requires an API key.");
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 6e4) {
      throw new Error("GoogleRoutesProvider timeout must be between 100 and 60000 milliseconds.");
    }
    if (typeof this.fetchImpl !== "function") throw new Error("GoogleRoutesProvider requires fetch.");
  }
  async route(request) {
    if (!isValidCoordinate(request.origin) || !isValidCoordinate(request.destination)) {
      throw new RoutingProviderError("Google route endpoints were out of range.", this.providerName);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(GOOGLE_ROUTES_COMPUTE_ROUTES_URL, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": this.apiKey,
          "X-Goog-FieldMask": FIELD_MASK
        },
        body: JSON.stringify({
          origin: { location: { latLng: request.origin } },
          destination: { location: { latLng: request.destination } },
          travelMode: "DRIVE",
          routingPreference: "TRAFFIC_AWARE",
          computeAlternativeRoutes: false,
          polylineQuality: "OVERVIEW",
          units: "METRIC"
        })
      });
    } catch (error) {
      const aborted = controller.signal.aborted || error?.name === "AbortError";
      throw new RoutingProviderError(
        aborted ? `Google Routes API timed out after ${this.timeoutMs}ms.` : "Google Routes API is unreachable.",
        this.providerName
      );
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      const reason = response.status === 429 ? "rate limited" : `HTTP ${response.status}`;
      throw new RoutingProviderError(`Google Routes API returned ${reason}.`, this.providerName);
    }
    let body;
    try {
      body = await response.json();
    } catch {
      throw new RoutingProviderError("Google Routes API response was not valid JSON.", this.providerName);
    }
    const routes = Array.isArray(body?.routes) ? body.routes : [];
    const routeValue = routes[0];
    if (routeValue === void 0) {
      throw new RoutingProviderError("Google Routes API returned no route.", this.providerName);
    }
    if (typeof routeValue !== "object" || routeValue === null || Array.isArray(routeValue)) {
      throw new RoutingProviderError("Google Routes API returned malformed route data.", this.providerName);
    }
    const route = routeValue;
    const distanceMeters = route.distanceMeters;
    if (typeof distanceMeters !== "number" || !Number.isFinite(distanceMeters) || distanceMeters < 0) {
      throw new RoutingProviderError("Google route had no usable distance.", this.providerName);
    }
    if (typeof route.polyline?.encodedPolyline !== "string") {
      throw new RoutingProviderError("Google route had no usable encoded geometry.", this.providerName);
    }
    const geometry = decodePolyline(route.polyline.encodedPolyline);
    const trafficSeconds = parseSeconds(route.duration);
    const staticSeconds = parseSeconds(route.staticDuration);
    const hasFallback = route.fallbackInfo !== void 0 && route.fallbackInfo !== null;
    const isLiveTraffic = trafficSeconds !== null && !hasFallback;
    const selectedSeconds = isLiveTraffic ? trafficSeconds : staticSeconds ?? trafficSeconds;
    if (selectedSeconds === null) {
      throw new RoutingProviderError("Google route had no usable duration.", this.providerName);
    }
    const selected = {
      distanceKm: distanceMeters / 1e3,
      estimatedMinutes: selectedSeconds / 60,
      geometry,
      // Google does not expose this system's free-flow multiplier. Preserve it as unknown.
      trafficFactor: null
    };
    return {
      providerName: this.providerName,
      isLiveTraffic,
      selected,
      alternatives: [],
      selectionReason: isLiveTraffic ? "Google Routes API driving route; duration returned for a traffic-aware request." : "Google Routes API driving route; traffic-aware duration unavailable or provider fallback indicated."
    };
  }
};

// modules/module_08_route_optimization/src/routeOptimizationService.ts
var LEG_LABELS = {
  RESPONSE: { originName: "AMBULANCE", destinationName: "SCENE" },
  TRANSPORT: { originName: "SCENE", destinationName: "HOSPITAL" }
};
var TERMINAL_STATUSES2 = /* @__PURE__ */ new Set(["COMPLETED", "CANCELLED"]);
var TERMINAL_ROUTE_STATUSES = /* @__PURE__ */ new Set(["COMPLETED", "ARRIVED", "ABANDONED"]);
function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
var RouteOptimizationService = class {
  primary;
  fallback;
  routes;
  emergencies;
  ambulances;
  hospitals;
  events;
  config;
  logger;
  inFlight = /* @__PURE__ */ new Map();
  constructor(deps) {
    this.primary = deps.primary;
    this.fallback = deps.fallback;
    this.routes = deps.routes;
    this.emergencies = deps.emergencies;
    this.ambulances = deps.ambulances;
    this.hospitals = deps.hospitals;
    this.events = deps.events;
    this.config = deps.config;
    this.logger = deps.logger ?? noopLogger;
  }
  /** Read-only prerequisite for the HTTP contract; it performs no route action. */
  async getEmergencyForDispatchCheck(emergencyId) {
    return this.emergencies.findById(emergencyId);
  }
  /** Plans one leg for an emergency, if its inputs are known. */
  async generateForEmergency(emergencyId, leg) {
    const key = `${emergencyId}:${leg}`;
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const generation = this.generateOnce(emergencyId, leg);
    this.inFlight.set(key, generation);
    try {
      return await generation;
    } finally {
      if (this.inFlight.get(key) === generation) this.inFlight.delete(key);
    }
  }
  async generateOnce(emergencyId, leg) {
    const labels = LEG_LABELS[leg];
    const emergency = await this.emergencies.findById(emergencyId);
    if (!emergency) {
      return { emergencyId, leg, outcome: "SKIPPED_NOT_FOUND", reason: "emergency not found" };
    }
    if (emergency.isSimulation && !(this.config.generation?.includeSimulation ?? false)) {
      return { emergencyId, leg, outcome: "SKIPPED_SIMULATION" };
    }
    if (TERMINAL_STATUSES2.has(emergency.status)) {
      return { emergencyId, leg, outcome: "SKIPPED_STATUS", reason: `status ${emergency.status}` };
    }
    if (!emergency.assignedAmbulanceId) {
      return { emergencyId, leg, outcome: "SKIPPED_NO_AMBULANCE", reason: "no ambulance assigned" };
    }
    const existing = await this.routes.routesForEmergency(emergencyId);
    const existingRoute = [...existing].reverse().find((route) => route.destinationName === labels.destinationName);
    if (existingRoute) {
      return {
        emergencyId,
        leg,
        outcome: "SKIPPED_ALREADY_EXISTS",
        routeId: existingRoute.id,
        provider: existingRoute.provider,
        reason: `${labels.destinationName} route already planned`
      };
    }
    const ambulance = await this.ambulances.findById(emergency.assignedAmbulanceId);
    if (!ambulance) {
      return { emergencyId, leg, outcome: "SKIPPED_NO_AMBULANCE", reason: "assigned ambulance not found" };
    }
    const endpoints = await this.resolveEndpoints(emergency, ambulance, leg);
    if ("outcome" in endpoints) {
      return { emergencyId, leg, ...endpoints };
    }
    try {
      const route = await this.planAndRecord({
        emergencyId,
        ambulanceId: ambulance.id,
        hospitalId: endpoints.hospitalId,
        originName: labels.originName,
        destinationName: labels.destinationName,
        from: endpoints.from,
        to: endpoints.to,
        isSimulation: emergency.isSimulation
      });
      return {
        emergencyId,
        leg,
        outcome: "GENERATED",
        routeId: route.id,
        provider: route.provider
      };
    } catch (error) {
      const reason = messageOf(error);
      await this.recordFailed({
        emergencyId,
        ambulanceId: ambulance.id,
        provider: this.primary.providerName,
        reason,
        degradedToEstimate: false
      });
      this.logger.error({ emergencyId, leg, error: reason }, "route generation failed");
      return { emergencyId, leg, outcome: "FAILED", reason };
    }
  }
  /**
   * Replaces an established route with a newly computed one.
   *
   * A recalculation only happens when a previously persisted route is replaced
   * by a newly accepted route: initial creation stays `ROUTE_GENERATED`-only,
   * and provider failure, terminal routes, or a persistence refusal produce no
   * `ROUTE_RECALCULATED` event. The replacement write and its event commit
    * atomically through Module 11. `reason` is a required, operator-supplied
    * explanation carried verbatim into the event payload. `actor` carries the
    * authenticated caller identity (from trusted auth context only); when it is
    * omitted, the event records the system-initiated default (`SYSTEM`).
    */
  async recalculateRoute(routeId, reason, actor) {
    const trimmedReason = reason.trim();
    if (!trimmedReason) {
      throw AppError.validation("A recalculation reason is required.");
    }
    const existing = await this.routes.findById(routeId);
    if (!existing) {
      return {
        routeId,
        emergencyId: "",
        outcome: "SKIPPED_NOT_FOUND",
        reason: "route not found"
      };
    }
    const emergencyId = existing.emergencyId;
    if (TERMINAL_ROUTE_STATUSES.has(existing.status ?? "")) {
      return {
        routeId,
        emergencyId,
        outcome: "SKIPPED_STATUS",
        reason: `route status ${existing.status}`
      };
    }
    if (!this.routes.replaceRouteWithEvent) {
      return {
        routeId,
        emergencyId,
        outcome: "UNSUPPORTED",
        reason: "route persistence does not support atomic replacement"
      };
    }
    const emergency = await this.emergencies.findById(emergencyId);
    if (!emergency) {
      return {
        routeId,
        emergencyId,
        outcome: "SKIPPED_NOT_FOUND",
        reason: "emergency not found"
      };
    }
    if (emergency.isSimulation && !(this.config.generation?.includeSimulation ?? false)) {
      return { routeId, emergencyId, outcome: "SKIPPED_SIMULATION" };
    }
    if (TERMINAL_STATUSES2.has(emergency.status)) {
      return {
        routeId,
        emergencyId,
        outcome: "SKIPPED_STATUS",
        reason: `status ${emergency.status}`
      };
    }
    if (!emergency.assignedAmbulanceId) {
      return {
        routeId,
        emergencyId,
        outcome: "SKIPPED_NO_AMBULANCE",
        reason: "no ambulance assigned"
      };
    }
    const ambulance = await this.ambulances.findById(emergency.assignedAmbulanceId);
    if (!ambulance) {
      return {
        routeId,
        emergencyId,
        outcome: "SKIPPED_NO_AMBULANCE",
        reason: "assigned ambulance not found"
      };
    }
    const leg = existing.destinationName === LEG_LABELS.RESPONSE.destinationName ? "RESPONSE" : existing.destinationName === LEG_LABELS.TRANSPORT.destinationName ? "TRANSPORT" : null;
    let from;
    let to;
    if (leg) {
      const endpoints = await this.resolveEndpoints(emergency, ambulance, leg);
      if ("outcome" in endpoints) {
        const skipped = endpoints.outcome === "SKIPPED_NO_POSITION" ? "SKIPPED_NO_POSITION" : endpoints.outcome === "SKIPPED_NO_HOSPITAL" ? "SKIPPED_NO_HOSPITAL" : "SKIPPED_INVALID_LOCATION";
        return { routeId, emergencyId, outcome: skipped, reason: endpoints.reason };
      }
      from = endpoints.from;
      to = endpoints.to;
    } else {
      const first = existing.polyline[0];
      const last = existing.polyline[existing.polyline.length - 1];
      if (!first || !last) {
        return {
          routeId,
          emergencyId,
          outcome: "SKIPPED_INVALID_LOCATION",
          reason: "route has no stored endpoints to recalculate"
        };
      }
      from = { latitude: first[0], longitude: first[1] };
      to = { latitude: last[0], longitude: last[1] };
    }
    if (!isValidCoordinate(from) || !isValidCoordinate(to)) {
      return {
        routeId,
        emergencyId,
        outcome: "SKIPPED_INVALID_LOCATION",
        reason: "recalculation endpoints are out of range"
      };
    }
    try {
      const { result } = await this.compute(from, to, { emergencyId, ambulanceId: ambulance.id });
      const candidate = result.selected;
      const distanceKm = round(candidate.distanceKm, 4);
      const estimatedMinutes = round(candidate.estimatedMinutes, 2);
      const route = await this.routes.replaceRouteWithEvent(
        routeId,
        {
          distanceKm,
          polyline: candidate.geometry,
          estimatedMinutes,
          provider: result.providerName,
          isLiveTraffic: result.isLiveTraffic,
          trafficFactor: candidate.trafficFactor,
          alternatives: result.alternatives.map((alternative) => ({
            distanceKm: alternative.distanceKm,
            estimatedMinutes: alternative.estimatedMinutes,
            trafficFactor: alternative.trafficFactor
          })),
          selectionReason: { reason: result.selectionReason, recalculation: trimmedReason }
        },
        (updated, previous) => defineEvent("ROUTE_RECALCULATED", {
          emergencyId,
          entityType: "route",
          entityId: routeId,
          actorType: actor?.actorType ?? "SYSTEM",
          actorId: actor?.actorId ?? null,
          payload: {
            routeId,
            emergencyId,
            previousDistanceKm: previous.distanceKm,
            distanceKm: updated.distanceKm,
            previousEstimatedMinutes: previous.estimatedMinutes ?? 0,
            estimatedMinutes: updated.estimatedMinutes ?? 0,
            reason: trimmedReason
          }
        })
      );
      this.logger.info(
        {
          emergencyId,
          routeId,
          distanceKm: route.distanceKm,
          estimatedMinutes: route.estimatedMinutes,
          provider: route.provider,
          isLiveTraffic: route.isLiveTraffic,
          reason: trimmedReason
        },
        "recalculated route"
      );
      return {
        routeId,
        emergencyId,
        outcome: "RECALCULATED",
        provider: route.provider
      };
    } catch (error) {
      const failureReason = messageOf(error);
      await this.recordFailed({
        emergencyId,
        ambulanceId: ambulance.id,
        provider: this.primary.providerName,
        reason: failureReason,
        degradedToEstimate: false
      });
      this.logger.error({ emergencyId, routeId, error: failureReason }, "route recalculation failed");
      return { routeId, emergencyId, outcome: "FAILED", reason: failureReason };
    }
  }
  /**
   * Generic compute-and-record entry point (Module 8 `RouteOptimizationPort`).
   *
   * Requires `emergencyId` and `ambulanceId`: a route row is meaningless without
   * them, so a call missing either is a programming error, not a runtime one.
   */
  async optimizeRoute(input) {
    if (!input.emergencyId || !input.ambulanceId) {
      throw AppError.validation(
        "optimizeRoute requires emergencyId and ambulanceId so the route can be recorded."
      );
    }
    if (!isValidCoordinate(input.from) || !isValidCoordinate(input.to)) {
      throw AppError.validation("optimizeRoute endpoints are out of range.");
    }
    let route;
    try {
      route = await this.planAndRecord({
        emergencyId: input.emergencyId,
        ambulanceId: input.ambulanceId,
        hospitalId: null,
        originName: "ORIGIN",
        destinationName: "DESTINATION",
        from: input.from,
        to: input.to,
        isSimulation: input.isSimulation ?? false
      });
    } catch (error) {
      await this.recordFailed({
        emergencyId: input.emergencyId,
        ambulanceId: input.ambulanceId,
        provider: this.primary.providerName,
        reason: messageOf(error),
        degradedToEstimate: false
      });
      throw error;
    }
    return {
      routeId: route.id,
      distanceKm: route.distanceKm,
      estimatedMinutes: route.estimatedMinutes ?? 0,
      polyline: route.polyline,
      provider: route.provider,
      isLiveTraffic: route.isLiveTraffic
    };
  }
  async resolveEndpoints(emergency, ambulance, leg) {
    if (!isValidCoordinate({ latitude: emergency.latitude, longitude: emergency.longitude })) {
      return { outcome: "SKIPPED_INVALID_LOCATION", reason: "emergency has no valid location" };
    }
    const scene = { latitude: emergency.latitude, longitude: emergency.longitude };
    if (leg === "RESPONSE") {
      if (!isValidCoordinate({ latitude: ambulance.latitude, longitude: ambulance.longitude })) {
        return { outcome: "SKIPPED_NO_POSITION", reason: "ambulance has no reported position" };
      }
      return {
        from: { latitude: ambulance.latitude, longitude: ambulance.longitude },
        to: scene,
        hospitalId: emergency.selectedHospitalId ?? null
      };
    }
    if (!emergency.selectedHospitalId) {
      return { outcome: "SKIPPED_NO_HOSPITAL", reason: "no hospital selected" };
    }
    const hospital = await this.hospitals.findById(emergency.selectedHospitalId);
    if (!hospital) {
      return { outcome: "SKIPPED_NO_HOSPITAL", reason: "selected hospital not found" };
    }
    if (!isValidCoordinate({ latitude: hospital.latitude, longitude: hospital.longitude })) {
      return { outcome: "SKIPPED_INVALID_LOCATION", reason: "hospital has no valid location" };
    }
    return {
      from: scene,
      to: { latitude: hospital.latitude, longitude: hospital.longitude },
      hospitalId: hospital.id
    };
  }
  /** Computes a route, writes the row and emits `ROUTE_GENERATED`. Throws on total failure. */
  async planAndRecord(input) {
    const { result, degraded } = await this.compute(input.from, input.to, input);
    const candidate = result.selected;
    const distanceKm = round(candidate.distanceKm, 4);
    const estimatedMinutes = round(candidate.estimatedMinutes, 2);
    const routeInput = {
      emergencyId: input.emergencyId,
      ambulanceId: input.ambulanceId,
      hospitalId: input.hospitalId,
      originName: input.originName,
      destinationName: input.destinationName,
      origin: input.from,
      destination: input.to,
      distanceKm,
      polyline: candidate.geometry,
      estimatedMinutes,
      isSimulation: input.isSimulation,
      provider: result.providerName,
      isLiveTraffic: result.isLiveTraffic,
      trafficFactor: candidate.trafficFactor,
      alternatives: result.alternatives.map((alternative) => ({
        distanceKm: alternative.distanceKm,
        estimatedMinutes: alternative.estimatedMinutes,
        trafficFactor: alternative.trafficFactor
      })),
      selectionReason: { reason: result.selectionReason, degraded }
    };
    const routeEvent = (route2) => defineEvent("ROUTE_GENERATED", {
      emergencyId: input.emergencyId,
      entityType: "route",
      entityId: route2.id,
      payload: {
        routeId: route2.id,
        emergencyId: input.emergencyId,
        ambulanceId: input.ambulanceId,
        hospitalId: input.hospitalId,
        distanceKm,
        estimatedMinutes,
        provider: result.providerName,
        isLiveTraffic: result.isLiveTraffic
      }
    });
    const route = this.routes.createRouteWithEvent ? await this.routes.createRouteWithEvent(routeInput, routeEvent) : await this.routes.createRoute(routeInput);
    if (!this.routes.createRouteWithEvent) await this.events.record(routeEvent(route));
    this.logger.info(
      {
        emergencyId: input.emergencyId,
        routeId: route.id,
        destinationName: input.destinationName,
        distanceKm,
        estimatedMinutes,
        provider: result.providerName,
        isLiveTraffic: result.isLiveTraffic,
        degraded
      },
      "planned route"
    );
    return route;
  }
  /** Runs the configured provider, falling back to the deterministic one on failure. */
  async compute(from, to, ctx) {
    try {
      const result = await this.primary.route({
        origin: from,
        destination: to,
        averageSpeedKmh: this.config.averageSpeedKmh
      });
      return { result, degraded: false };
    } catch (primaryError) {
      const primaryReason = messageOf(primaryError);
      let fallbackResult;
      try {
        fallbackResult = await this.fallback.route({
          origin: from,
          destination: to,
          averageSpeedKmh: this.config.averageSpeedKmh
        });
      } catch (fallbackError) {
        throw new RoutingProviderError(
          `primary (${this.primary.providerName}) failed: ${primaryReason}; fallback (${this.fallback.providerName}) failed: ${messageOf(fallbackError)}`,
          this.primary.providerName
        );
      }
      await this.recordFailed({
        emergencyId: ctx.emergencyId,
        ambulanceId: ctx.ambulanceId,
        provider: this.primary.providerName,
        reason: primaryReason,
        degradedToEstimate: true
      });
      this.logger.warn(
        { emergencyId: ctx.emergencyId, provider: this.primary.providerName, error: primaryReason },
        "primary routing provider failed; used deterministic fallback"
      );
      return { result: fallbackResult, degraded: true };
    }
  }
  /** Records a `ROUTE_FAILED`; never lets a diagnostic event mask the real error. */
  async recordFailed(input) {
    try {
      await this.events.record(
        defineEvent("ROUTE_FAILED", {
          emergencyId: input.emergencyId,
          entityType: "route",
          entityId: input.ambulanceId,
          payload: {
            emergencyId: input.emergencyId,
            ambulanceId: input.ambulanceId,
            provider: input.provider,
            reason: input.reason,
            degradedToEstimate: input.degradedToEstimate
          }
        })
      );
    } catch (error) {
      this.logger.warn(
        { emergencyId: input.emergencyId, error: messageOf(error) },
        "failed to record route failure event"
      );
    }
  }
};

// modules/module_08_route_optimization/src/autoRouteService.ts
var AUTO_ROUTE_EVENT_TYPES = ["AMBULANCE_DISPATCHED", "HOSPITAL_SELECTED"];
var EVENT_TO_LEG = {
  AMBULANCE_DISPATCHED: "RESPONSE",
  HOSPITAL_SELECTED: "TRANSPORT"
};
var AutoRouteService = class {
  optimization;
  logger;
  unsubscribe;
  inFlight = /* @__PURE__ */ new Map();
  inFlightEvents = /* @__PURE__ */ new Set();
  disposed = false;
  constructor(deps) {
    this.optimization = deps.optimization;
    this.logger = deps.logger ?? noopLogger;
    this.unsubscribe = deps.events.subscribe(
      AUTO_ROUTE_EVENT_TYPES,
      (event) => this.onEvent(event)
    );
  }
  /** Awaits every event the bus has handed to this subscriber that is still running. */
  async idle() {
    while (this.inFlightEvents.size > 0) {
      await Promise.allSettled([...this.inFlightEvents]);
    }
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
  }
  /** Handles one event record. Exposed so tests can drive it without a bus. */
  async handleEvent(event) {
    const leg = EVENT_TO_LEG[event.type];
    if (!leg) return null;
    const emergencyId = this.emergencyIdFrom(event);
    if (!emergencyId) return null;
    return this.generate(emergencyId, leg);
  }
  /**
   * Runs planning for one emergency+leg.
   *
   * The in-flight map is keyed by emergency+leg and set synchronously before the
   * first `await`, so two events arriving back-to-back cannot both reach the
   * routing provider.
   */
  async generate(emergencyId, leg) {
    if (this.disposed) {
      return { emergencyId, leg, outcome: "SKIPPED_STATUS", reason: "auto-route disposed" };
    }
    const key = `${emergencyId}:${leg}`;
    const inFlight = this.inFlight.get(key);
    if (inFlight) return inFlight;
    const run = this.optimization.generateForEmergency(emergencyId, leg);
    this.inFlight.set(key, run);
    try {
      const result = await run;
      this.logResult(result);
      return result;
    } finally {
      this.inFlight.delete(key);
    }
  }
  onEvent(event) {
    const task = this.handleEvent(event).then(
      () => void 0,
      (error) => {
        this.logger.error(
          {
            eventId: event.id,
            eventType: event.type,
            error: error instanceof Error ? error.message : String(error)
          },
          "auto-route subscriber threw"
        );
      }
    ).finally(() => {
      this.inFlightEvents.delete(task);
    });
    this.inFlightEvents.add(task);
  }
  emergencyIdFrom(event) {
    if (event.emergencyId) return event.emergencyId;
    const payload = event.payload;
    return typeof payload?.emergencyId === "string" ? payload.emergencyId : null;
  }
  logResult(result) {
    if (result.outcome === "GENERATED") return;
    if (result.outcome === "FAILED") {
      this.logger.warn({ ...result }, "auto-route could not plan a route");
      return;
    }
    this.logger.debug({ ...result }, "auto-route skipped");
  }
};

// modules/module_08_route_optimization/src/api/routes.ts
import { z as z12 } from "zod";
var emergencyParams2 = z12.object({ id: z12.string().min(1).max(128) });
var routeParams = z12.object({ id: z12.string().min(1).max(128) });
var generateRouteBody = z12.object({ leg: z12.enum(["RESPONSE", "TRANSPORT"]) }).strict();
var recalculateRouteBody = z12.object({ reason: z12.string().min(1).max(500) }).strict();
function createModule8Routes(optimization, routes, driverAmbulances, dispatchEvents) {
  const readRoles = ["OPERATOR", "DISPATCHER", "CLINICAL_SUPERVISOR", "ADMIN"];
  const actionRoles = ["DISPATCHER", "ADMIN"];
  return [
    {
      method: "POST",
      url: "/api/emergencies/:id/routes",
      module: "module_08",
      summary: "Generate one response or transport route for an emergency",
      auth: { roles: actionRoles },
      params: emergencyParams2,
      body: generateRouteBody,
      handler: async (request, reply) => {
        const emergencyId = emergencyParams2.parse(request.params).id;
        const { leg } = generateRouteBody.parse(request.body);
        if (leg === "RESPONSE" && dispatchEvents) {
          const emergency = await optimization.getEmergencyForDispatchCheck?.(emergencyId);
          if (!emergency) throw AppError.notFound("Emergency", emergencyId);
          const ambulanceId = emergency?.assignedAmbulanceId;
          const relevant = await listDispatchEvidence(dispatchEvents, emergencyId, ambulanceId);
          const latestAssignment = relevant.filter((record) => record.type === "AMBULANCE_ASSIGNED").at(-1);
          const dispatched = Boolean(latestAssignment && relevant.some((record) => record.type === "AMBULANCE_DISPATCHED" && record.sequence > latestAssignment.sequence));
          if (!dispatched) throw new AppError(ErrorCode.CONFLICT, "A persisted explicit ambulance dispatch is required before response route generation.", 409);
        }
        const result = await optimization.generateForEmergency(emergencyId, leg);
        switch (result.outcome) {
          case "SKIPPED_NOT_FOUND":
            throw AppError.notFound("Emergency", emergencyId);
          case "SKIPPED_SIMULATION":
            throw new AppError(ErrorCode.CONFLICT, "Route generation is not enabled for simulation emergencies.", 409);
          case "SKIPPED_STATUS":
            throw new AppError(ErrorCode.CONFLICT, result.reason ?? "Route generation is not available for this emergency state.", 409);
          case "SKIPPED_NO_AMBULANCE":
          case "SKIPPED_NO_HOSPITAL":
          case "SKIPPED_NO_POSITION":
          case "SKIPPED_INVALID_LOCATION":
            throw new AppError(ErrorCode.CONFLICT, result.reason ?? `Route prerequisites are missing (${result.outcome}).`, 409);
          case "FAILED":
            throw new AppError(ErrorCode.ROUTING_FAILED, "Route generation failed.", 502, { reason: result.reason });
          case "GENERATED":
          case "SKIPPED_ALREADY_EXISTS": {
            const route = result.routeId ? await routes.findById(result.routeId) : null;
            if (!route) {
              throw new AppError(ErrorCode.INTERNAL_ERROR, "Route operation completed without a readable persisted route.", 500);
            }
            reply.send({ emergencyId, outcome: result.outcome, route });
            return;
          }
        }
      }
    },
    {
      method: "POST",
      url: "/api/routes/:id/recalculate",
      module: "module_08",
      summary: "Replace an established route with a newly computed one and record ROUTE_RECALCULATED",
      auth: { roles: actionRoles },
      params: routeParams,
      body: recalculateRouteBody,
      handler: async (request, reply) => {
        const routeId = routeParams.parse(request.params).id;
        const { reason } = recalculateRouteBody.parse(request.body);
        const result = await optimization.recalculateRoute(routeId, reason, {
          actorType: request.user?.role ?? "SYSTEM",
          actorId: request.user?.userId ?? null
        });
        switch (result.outcome) {
          case "SKIPPED_NOT_FOUND":
            throw AppError.notFound("Route", routeId);
          case "SKIPPED_SIMULATION":
            throw new AppError(ErrorCode.CONFLICT, "Route recalculation is not enabled for simulation emergencies.", 409);
          case "SKIPPED_STATUS":
            throw new AppError(ErrorCode.CONFLICT, result.reason ?? "Route recalculation is not available for this route state.", 409);
          case "SKIPPED_NO_AMBULANCE":
          case "SKIPPED_NO_HOSPITAL":
          case "SKIPPED_NO_POSITION":
          case "SKIPPED_INVALID_LOCATION":
            throw new AppError(ErrorCode.CONFLICT, result.reason ?? `Route recalculation prerequisites are missing (${result.outcome}).`, 409);
          case "UNSUPPORTED":
            throw new AppError(ErrorCode.INTERNAL_ERROR, result.reason ?? "Route recalculation is not supported by this persistence layer.", 503);
          case "FAILED":
            throw new AppError(ErrorCode.ROUTING_FAILED, "Route recalculation failed.", 502, { reason: result.reason });
          case "RECALCULATED": {
            const route = await routes.findById(routeId);
            if (!route) {
              throw new AppError(ErrorCode.INTERNAL_ERROR, "Recalculation completed without a readable persisted route.", 500);
            }
            reply.send({ routeId, emergencyId: result.emergencyId, outcome: result.outcome, route });
            return;
          }
        }
      }
    },
    {
      method: "GET",
      url: "/api/emergencies/:id/routes",
      module: "module_08",
      summary: "Planned routes for an emergency (response and transport legs)",
      auth: { roles: readRoles },
      params: emergencyParams2,
      handler: async (request, reply) => {
        const id = emergencyParams2.parse(request.params).id;
        reply.send({ emergencyId: id, routes: await routes.routesForEmergency(id) });
      }
    },
    {
      method: "GET",
      url: "/api/routes/:id",
      module: "module_08",
      summary: "Read one planned route by id",
      auth: { roles: readRoles },
      params: z12.object({ id: z12.string().min(1).max(128) }),
      handler: async (request, reply) => {
        const id = String(request.params.id ?? "");
        const route = await routes.findById(id);
        if (!route) throw AppError.notFound("Route", id);
        reply.send(route);
      }
    },
    {
      method: "GET",
      url: "/api/drivers/me/routes",
      module: "module_08",
      summary: "Read routes for the authenticated driver\u2019s assigned emergency",
      auth: { roles: ["DRIVER", "AMBULANCE_DRIVER"] },
      handler: async (request, reply) => {
        const driverId = request.user?.userId;
        if (!driverId) throw new AppError(ErrorCode.UNAUTHORIZED, "Authentication is required.", 401);
        if (!driverAmbulances?.getAssignedAmbulanceForDriver) {
          throw new AppError(ErrorCode.INTERNAL_ERROR, "Driver route lookup is unavailable.", 503);
        }
        const ambulance = await driverAmbulances.getAssignedAmbulanceForDriver(driverId);
        if (!ambulance?.currentEmergencyId || ambulance.status !== "EN_ROUTE") {
          reply.send({ routes: [], reason: "NO_DISPATCHED_ASSIGNMENT" });
          return;
        }
        const visible = (await routes.routesForEmergency(ambulance.currentEmergencyId)).filter((route) => route.ambulanceId === ambulance.id && route.originName === "AMBULANCE" && route.destinationName === "SCENE");
        reply.send({ emergencyId: ambulance.currentEmergencyId, ambulanceId: ambulance.id, routes: visible });
      }
    }
  ];
}
async function listDispatchEvidence(events, emergencyId, ambulanceId) {
  if (!ambulanceId) return [];
  const matches = [];
  let offset = 0;
  let total = 0;
  do {
    const page = await events.list({ emergencyId, types: ["AMBULANCE_ASSIGNED", "AMBULANCE_DISPATCHED"], limit: 500, offset });
    total = page.total;
    for (const record of page.items) {
      const payload = record.payload;
      if (payload.ambulanceId === ambulanceId) matches.push({ type: record.type, sequence: record.sequence });
    }
    offset += page.items.length;
    if (page.items.length === 0) break;
  } while (offset < total);
  return matches;
}

// modules/module_08_route_optimization/src/module.ts
var Module8 = class {
  optimization;
  autoRoute;
  config;
  routeWriter;
  ambulanceReader;
  logger;
  dispatchEvents;
  constructor(deps) {
    this.config = deps.config ?? loadModule8Config();
    this.logger = deps.logger ?? noopLogger;
    this.dispatchEvents = deps.dispatchEvents;
    this.routeWriter = deps.routes;
    this.ambulanceReader = deps.ambulances;
    const mock = new MockRoutingProvider(this.config.averageSpeedKmh);
    const primary = deps.primaryProvider ?? (this.config.provider === "osrm" ? new OsrmRoutingProvider({
      baseUrl: this.config.osrm.baseUrl,
      timeoutMs: this.config.osrm.timeoutMs
    }) : this.config.provider === "google" ? new GoogleRoutesProvider({
      apiKey: this.config.google.apiKey ?? "",
      timeoutMs: this.config.google.timeoutMs
    }) : mock);
    const fallback2 = deps.fallbackProvider ?? mock;
    this.optimization = new RouteOptimizationService({
      primary,
      fallback: fallback2,
      routes: deps.routes,
      emergencies: deps.emergencies,
      ambulances: deps.ambulances,
      hospitals: deps.hospitals,
      events: deps.events,
      config: this.config,
      logger: this.logger
    });
    const generationEnabled = this.config.generation?.enabled ?? false;
    this.autoRoute = deps.bus && generationEnabled ? new AutoRouteService({
      events: deps.bus,
      optimization: this.optimization,
      logger: this.logger
    }) : void 0;
  }
  routes() {
    return createModule8Routes(this.optimization, this.routeWriter, this.ambulanceReader, this.dispatchEvents);
  }
  register(table) {
    table.addAll(this.routes());
  }
  dispose() {
    this.autoRoute?.dispose();
  }
};

// modules/module_09_corridor_coordination/src/config.ts
function loadModule9Config() {
  return {
    // Automatic corridor coordination is opt-in. Missing or malformed values fail closed.
    enabled: process.env.MODULE9_CORRIDOR_ENABLED?.toLowerCase() === "true",
    radiusM: Number(process.env.MODULE9_CORRIDOR_RADIUS_M ?? 150),
    includeSimulation: process.env.MODULE9_CORRIDOR_SIMULATION === "true",
    maxSimulatedRoadUsers: Number(process.env.MODULE9_SIMULATED_ROAD_USERS ?? 3)
  };
}

// modules/module_09_corridor_coordination/src/geometry.ts
var EARTH_RADIUS_M = 63710088e-1;
var METERS_PER_DEG_LAT = Math.PI / 180 * EARTH_RADIUS_M;
var DEFAULT_RESAMPLE_SPACING_M = 25;
function isValidPath(path3) {
  return path3.length > 0 && path3.every((point) => isValidCoordinate(point));
}
function toLocalMetres(point, refLat, refLng) {
  const lngScale = METERS_PER_DEG_LAT * Math.cos(refLat * Math.PI / 180);
  return {
    x: (point.longitude - refLng) * lngScale,
    y: (point.latitude - refLat) * METERS_PER_DEG_LAT
  };
}
function metersPerDegreeLongitude(latitude) {
  return METERS_PER_DEG_LAT * Math.cos(latitude * Math.PI / 180);
}
function distanceM(a, b) {
  return haversineKm(a, b) * 1e3;
}
function distancePointToSegmentM(point, a, b) {
  const p = toLocalMetres(point, a.latitude, a.longitude);
  const start = { x: 0, y: 0 };
  const end = toLocalMetres(b, a.latitude, a.longitude);
  const abx = end.x - start.x;
  const aby = end.y - start.y;
  const ab2 = abx * abx + aby * aby;
  let t = ab2 === 0 ? 0 : ((p.x - start.x) * abx + (p.y - start.y) * aby) / ab2;
  t = Math.max(0, Math.min(1, t));
  const closestX = start.x + t * abx;
  const closestY = start.y + t * aby;
  return Math.hypot(p.x - closestX, p.y - closestY);
}
function distancePointToPathM(point, path3) {
  if (path3.length === 0) return Number.POSITIVE_INFINITY;
  if (path3.length === 1) return distanceM(point, path3[0]);
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < path3.length - 1; i += 1) {
    const d = distancePointToSegmentM(point, path3[i], path3[i + 1]);
    if (d < best) best = d;
  }
  return best;
}
function resamplePath(path3, spacingM) {
  if (!isValidPath(path3)) {
    throw new Error("resamplePath requires a non-empty path of valid coordinates.");
  }
  if (path3.length === 1) return [{ ...path3[0] }];
  const maxSpacing = spacingM > 0 ? spacingM : DEFAULT_RESAMPLE_SPACING_M;
  const out = [{ ...path3[0] }];
  for (let i = 0; i < path3.length - 1; i += 1) {
    const a = path3[i];
    const b = path3[i + 1];
    const segmentM = distanceM(a, b);
    const steps = Math.max(1, Math.ceil(segmentM / maxSpacing));
    for (let step = 1; step <= steps; step += 1) {
      const t = step / steps;
      out.push({
        latitude: a.latitude + (b.latitude - a.latitude) * t,
        longitude: a.longitude + (b.longitude - a.longitude) * t
      });
    }
  }
  return out;
}
function buildCorridorGeofence(path3, radiusM) {
  if (!isValidPath(path3)) {
    throw new Error("Cannot build a corridor from an empty or invalid route geometry.");
  }
  if (!Number.isFinite(radiusM) || radiusM <= 0) {
    throw new Error("Corridor radius must be a positive number of metres.");
  }
  const spacing = Math.min(radiusM, DEFAULT_RESAMPLE_SPACING_M) || DEFAULT_RESAMPLE_SPACING_M;
  return { centreLine: resamplePath(path3, spacing), radiusM };
}
function pathLengthM(path3) {
  let total = 0;
  for (let i = 0; i < path3.length - 1; i += 1) {
    total += distanceM(path3[i], path3[i + 1]);
  }
  return total;
}
function pointAtFraction(path3, t) {
  if (path3.length === 0) throw new Error("pointAtFraction requires a non-empty path.");
  if (path3.length === 1) return { ...path3[0] };
  const clamped = Math.max(0, Math.min(1, t));
  const target = pathLengthM(path3) * clamped;
  let travelled = 0;
  for (let i = 0; i < path3.length - 1; i += 1) {
    const a = path3[i];
    const b = path3[i + 1];
    const segmentM = distanceM(a, b);
    if (travelled + segmentM >= target) {
      const local = segmentM === 0 ? 0 : (target - travelled) / segmentM;
      return {
        latitude: a.latitude + (b.latitude - a.latitude) * local,
        longitude: a.longitude + (b.longitude - a.longitude) * local
      };
    }
    travelled += segmentM;
  }
  return { ...path3[path3.length - 1] };
}

// modules/module_09_corridor_coordination/src/corridorService.ts
var SIMULATED_PRIORITY_MODE = "SIMULATED";
var CorridorService = class {
  corridors;
  notifications;
  roadUsers;
  notificationProvider;
  config;
  logger;
  constructor(deps) {
    this.corridors = deps.corridors;
    this.notifications = deps.notifications;
    this.roadUsers = deps.roadUsers;
    this.notificationProvider = deps.notificationProvider;
    this.config = deps.config;
    this.logger = deps.logger ?? noopLogger;
  }
  /**
   * Activates the corridor for a persisted planned route.
   *
   * Idempotent: activating an already-active corridor returns `ALREADY_ACTIVE`
   * and raises no second event or notification. A persistence failure surfaces as
   * `FAILED` and never yields a success event (the write and its event share one
   * transaction inside Module 11).
   */
  async activateForRoute(route) {
    const blank = (outcome, reason, status = null) => ({
      outcome,
      emergencyId: route.emergencyId,
      corridorId: null,
      status,
      reason,
      isSimulation: route.isSimulation,
      priorityMode: SIMULATED_PRIORITY_MODE,
      isLive: false,
      signalsControlled: false,
      radiusM: this.config.radiusM,
      simulatedRoadUsers: [],
      notifications: []
    });
    if (route.isSimulation && !this.config.includeSimulation) {
      return blank("SKIPPED", "simulation emergencies are not coordinated");
    }
    if (!route.hospitalId) {
      return blank("SKIPPED", "route has no destination hospital");
    }
    if (route.polyline.length < 2) {
      return blank("SKIPPED", "route has no usable geometry");
    }
    let geofence;
    try {
      const coordinates = route.polyline.map(([latitude, longitude]) => ({
        latitude,
        longitude
      }));
      geofence = buildCorridorGeofence(coordinates, this.config.radiusM);
    } catch (error) {
      return blank("SKIPPED", error instanceof Error ? error.message : "invalid route geometry");
    }
    const simulatedRoadUsers = await this.detectRoadUsers(geofence.centreLine);
    let activation;
    try {
      activation = await this.corridors.activateCorridor({
        emergencyId: route.emergencyId,
        ambulanceId: route.ambulanceId,
        hospitalId: route.hospitalId,
        fromLabel: route.originName,
        toLabel: route.destinationName,
        estimatedMinutes: route.estimatedMinutes ?? 0,
        isSimulation: route.isSimulation,
        priorityMode: SIMULATED_PRIORITY_MODE,
        radiusM: this.config.radiusM,
        geofence: geofence.centreLine,
        // Stored verbatim as the schema's "array of detections". Each detection
        // carries `simulated: true`, so the record is self-describing.
        roadUsers: simulatedRoadUsers,
        signals: []
      });
    } catch (error) {
      this.logger.error(
        {
          emergencyId: route.emergencyId,
          error: error instanceof Error ? error.message : String(error)
        },
        "corridor activation failed"
      );
      return blank("FAILED", "corridor persistence failed");
    }
    const notifications = activation.activated && simulatedRoadUsers.length > 0 ? await this.raiseRoadUserNotifications(route.emergencyId, activation.id, simulatedRoadUsers) : [];
    return {
      outcome: activation.activated ? "ACTIVATED" : "ALREADY_ACTIVE",
      emergencyId: route.emergencyId,
      corridorId: activation.id,
      status: activation.status,
      isSimulation: route.isSimulation,
      priorityMode: SIMULATED_PRIORITY_MODE,
      isLive: false,
      signalsControlled: false,
      radiusM: this.config.radiusM,
      simulatedRoadUsers,
      notifications
    };
  }
  /** Releases the corridor. Idempotent: a second call raises no second event. */
  async release(emergencyId, reason = "RELEASED") {
    const result = await this.corridors.releaseCorridor(emergencyId, reason);
    return { released: result.released, outcome: result.released ? "RELEASED" : "ALREADY_RELEASED" };
  }
  /** Read a corridor's persisted state (never presents it as a live integration). */
  async getState(emergencyId) {
    return {
      corridor: await this.corridors.getCorridor(emergencyId),
      isLive: false,
      signalsControlled: false
    };
  }
  async detectRoadUsers(path3) {
    try {
      return await this.roadUsers.detectNear(path3, this.config.radiusM, null);
    } catch (error) {
      this.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        "road-user detection failed; continuing with none"
      );
      return [];
    }
  }
  async raiseRoadUserNotifications(emergencyId, corridorId, users) {
    const request = {
      emergencyId,
      corridorId,
      channel: "PUSH",
      audience: "NEARBY_ROAD_USERS",
      body: `SIMULATED corridor notice: an emergency ambulance corridor is active on ${this.describe(users)} simulated road-user position(s). This is a mock coordination record; no message was sent to any road user.`
    };
    let result;
    try {
      result = await this.notificationProvider.notify(request);
    } catch (error) {
      this.logger.warn(
        { emergencyId, error: error instanceof Error ? error.message : String(error) },
        "notification provider failed; recording the intent as SUPPRESSED"
      );
      result = {
        providerName: this.notificationProvider.providerName,
        isLive: false,
        delivered: false,
        status: "FAILED",
        detail: "notification provider threw"
      };
    }
    try {
      const record = await this.notifications.create({
        emergencyId,
        corridorId,
        channel: request.channel,
        audience: request.audience,
        status: result.status,
        provider: result.providerName,
        delivered: result.delivered,
        body: request.body
      });
      return [
        {
          id: record.id,
          channel: record.channel,
          audience: record.audience,
          status: record.status,
          provider: record.provider,
          delivered: record.delivered
        }
      ];
    } catch (error) {
      this.logger.warn(
        { emergencyId, error: error instanceof Error ? error.message : String(error) },
        "notification persistence failed; corridor remains active"
      );
      return [];
    }
  }
  describe(users) {
    return users.length;
  }
};

// modules/module_09_corridor_coordination/src/corridorIntegration.ts
var CorridorIntegrationAdapter = class {
  corridors;
  routes;
  constructor(deps) {
    this.corridors = deps.corridors;
    this.routes = deps.routes;
  }
  /** Activates only from the latest persisted hospital-bound route. */
  async activateForEmergency(emergencyId) {
    const routes = await this.routes.routesForEmergency(emergencyId);
    const transport = routes.filter(
      (route2) => route2.emergencyId === emergencyId && route2.destinationName === "HOSPITAL" && route2.hospitalId !== null
    );
    const route = transport.at(-1);
    if (!route) return { outcome: "NO_TRANSPORT_ROUTE" };
    const activation = await this.corridors.activateForRoute(route);
    return { outcome: activation.outcome, routeId: route.id, activation };
  }
  async activateCorridor(input) {
    const routes = await this.routes.routesForEmergency(input.emergencyId);
    const transport = routes.filter(
      (route2) => route2.destinationName === "HOSPITAL" && route2.hospitalId === input.hospitalId
    );
    const route = transport.length > 0 ? transport[transport.length - 1] : null;
    if (!route) return { ok: false };
    const outcome = await this.corridors.activateForRoute(route);
    return { ok: outcome.outcome === "ACTIVATED" || outcome.outcome === "ALREADY_ACTIVE" };
  }
};

// modules/module_09_corridor_coordination/src/autoCorridorService.ts
var AUTO_CORRIDOR_EVENT_TYPES = [
  "HOSPITAL_SELECTED",
  "ROUTE_GENERATED"
];
var AutoCorridorService = class {
  corridors;
  routes;
  logger;
  unsubscribe;
  inFlight = /* @__PURE__ */ new Map();
  inFlightEvents = /* @__PURE__ */ new Set();
  disposed = false;
  constructor(deps) {
    this.corridors = deps.corridors;
    this.routes = deps.routes;
    this.logger = deps.logger ?? noopLogger;
    this.unsubscribe = deps.events.subscribe(
      AUTO_CORRIDOR_EVENT_TYPES,
      (event) => this.onEvent(event)
    );
  }
  /** Awaits every event the bus has handed to this subscriber that is still running. */
  async idle() {
    while (this.inFlightEvents.size > 0) {
      await Promise.allSettled([...this.inFlightEvents]);
    }
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
  }
  /** Handles one event record. Exposed so tests can drive it without a bus. */
  async handleEvent(event) {
    if (!AUTO_CORRIDOR_EVENT_TYPES.includes(event.type)) return null;
    const emergencyId = this.emergencyIdFrom(event);
    if (!emergencyId) return null;
    return this.coordinate(emergencyId);
  }
  /**
   * Coordinates the corridor for one emergency.
   *
   * The in-flight map is keyed by emergency and set synchronously before the
   * first `await`, so two events arriving back-to-back cannot both activate.
   */
  async coordinate(emergencyId) {
    if (this.disposed) return null;
    const existing = this.inFlight.get(emergencyId);
    if (existing) return existing;
    const run = this.run(emergencyId);
    this.inFlight.set(emergencyId, run);
    try {
      return await run;
    } finally {
      this.inFlight.delete(emergencyId);
    }
  }
  async run(emergencyId) {
    const route = await this.resolveTransportRoute(emergencyId);
    if (!route) return null;
    const outcome = await this.corridors.activateForRoute(route);
    if (outcome.outcome === "FAILED") {
      this.logger.warn({ emergencyId }, "auto-corridor could not activate");
    } else {
      this.logger.debug({ emergencyId, outcome: outcome.outcome }, "auto-corridor evaluated");
    }
    return outcome;
  }
  /** The most recent persisted transport route (destination `HOSPITAL`). */
  async resolveTransportRoute(emergencyId) {
    const routes = await this.routes.routesForEmergency(emergencyId);
    const transport = routes.filter(
      (route) => route.destinationName === "HOSPITAL" && route.hospitalId !== null
    );
    return transport.length > 0 ? transport[transport.length - 1] : null;
  }
  onEvent(event) {
    const task = this.handleEvent(event).then(
      () => void 0,
      (error) => {
        this.logger.error(
          {
            eventId: event.id,
            eventType: event.type,
            error: error instanceof Error ? error.message : String(error)
          },
          "auto-corridor subscriber threw"
        );
      }
    ).finally(() => {
      this.inFlightEvents.delete(task);
    });
    this.inFlightEvents.add(task);
  }
  emergencyIdFrom(event) {
    if (event.emergencyId) return event.emergencyId;
    const payload = event.payload;
    return typeof payload?.emergencyId === "string" ? payload.emergencyId : null;
  }
};

// modules/module_09_corridor_coordination/src/providers/roadUserProvider.ts
var MOCK_ROAD_USER_PROVIDER_NAME = "mock-road-user";
function offsetCoordinate(origin, eastM, northM) {
  const lngScale = metersPerDegreeLongitude(origin.latitude);
  return {
    latitude: origin.latitude + northM / METERS_PER_DEG_LAT,
    longitude: origin.longitude + (lngScale === 0 ? 0 : eastM / lngScale)
  };
}
var KINDS = ["VEHICLE", "PEDESTRIAN", "CYCLIST"];
var MockRoadUserProvider = class {
  providerName = MOCK_ROAD_USER_PROVIDER_NAME;
  /** Never a real feed. No consumer may present these as detected people. */
  isLive = false;
  maxUsers;
  constructor(options = {}) {
    const max = options.maxUsers ?? 3;
    this.maxUsers = Number.isFinite(max) && max > 0 ? Math.floor(max) : 0;
  }
  async detectNear(path3, radiusM, _ambulancePosition) {
    if (path3.length === 0 || this.maxUsers === 0 || !(radiusM > 0)) return [];
    const users = [];
    for (let i = 0; i < this.maxUsers; i += 1) {
      const fraction = (i + 1) / (this.maxUsers + 1);
      const anchor = pointAtFraction(path3, fraction);
      const side = i % 2 === 0 ? 1 : -1;
      const position = offsetCoordinate(anchor, side * radiusM * 0.3, 0);
      const distance = distancePointToPathM(position, path3);
      if (distance > radiusM) continue;
      users.push({
        id: `SIM-RU-${String(i + 1).padStart(4, "0")}`,
        kind: KINDS[i % KINDS.length],
        latitude: position.latitude,
        longitude: position.longitude,
        distanceToCorridorM: Number(distance.toFixed(1)),
        headingDeg: null,
        speedKmh: null,
        simulated: true
      });
    }
    return users;
  }
};

// modules/module_09_corridor_coordination/src/providers/notificationProvider.ts
var MOCK_NOTIFICATION_PROVIDER_NAME = "mock-notification";
var MockNotificationProvider = class {
  providerName = MOCK_NOTIFICATION_PROVIDER_NAME;
  /** Never a real provider. No consumer may present these as delivered. */
  isLive = false;
  async notify(_request) {
    return {
      providerName: this.providerName,
      isLive: false,
      delivered: false,
      status: "SUPPRESSED",
      detail: "Simulated notification: no message was sent and none left the system."
    };
  }
};

// modules/module_09_corridor_coordination/src/api/routes.ts
import { z as z13 } from "zod";
var emergencyParams3 = z13.object({ id: z13.string().min(1).max(128) });
function createModule9Routes(corridors, integration, policeNotifications) {
  const readRoles = ["OPERATOR", "DISPATCHER", "CLINICAL_SUPERVISOR", "ADMIN"];
  const actionRoles = ["DISPATCHER", "ADMIN"];
  const routes = [
    {
      method: "POST",
      url: "/api/emergencies/:id/corridor",
      module: "module_09",
      summary: "Activate a simulated corridor from a persisted transport route",
      auth: { roles: actionRoles },
      params: emergencyParams3,
      body: z13.object({}).strict(),
      handler: async (request, reply) => {
        const emergencyId = emergencyParams3.parse(request.params).id;
        const result = await integration.activateForEmergency(emergencyId);
        if (result.outcome === "NO_TRANSPORT_ROUTE") {
          throw new AppError(ErrorCode.NO_ROUTE_AVAILABLE, "A persisted hospital transport route is required before corridor activation.", 409);
        }
        if (result.outcome === "SKIPPED") {
          throw new AppError(ErrorCode.CONFLICT, result.activation.reason ?? "Corridor activation prerequisites were not met.", 409, {
            routeId: result.routeId
          });
        }
        if (result.outcome === "FAILED") {
          throw new AppError(ErrorCode.INTERNAL_ERROR, "Corridor activation failed.", 500, { routeId: result.routeId });
        }
        reply.send({
          emergencyId,
          outcome: result.outcome,
          routeId: result.routeId,
          corridor: result.activation,
          simulation: {
            priorityMode: "SIMULATED",
            isLive: false,
            signalsControlled: false,
            notificationsDelivered: false
          }
        });
      }
    },
    {
      method: "GET",
      url: "/api/emergencies/:id/corridor",
      module: "module_09",
      summary: "Simulated corridor state for an emergency",
      auth: { roles: readRoles },
      params: emergencyParams3,
      handler: async (request, reply) => {
        const id = emergencyParams3.parse(request.params).id;
        const state = await corridors.getState(id);
        reply.send({
          emergencyId: id,
          corridor: state.corridor,
          simulation: {
            priorityMode: "SIMULATED",
            isLive: state.isLive,
            signalsControlled: state.signalsControlled,
            notificationsDelivered: false
          }
        });
      }
    }
  ];
  if (policeNotifications) {
    routes.push(
      {
        method: "GET",
        url: "/api/emergencies/:id/police-notifications",
        module: "module_09",
        summary: "List simulated mock police control-room notices",
        auth: { roles: ["OPERATOR", "DISPATCHER", "ADMIN"] },
        params: emergencyParams3,
        handler: async (request, reply) => {
          const emergencyId = emergencyParams3.parse(request.params).id;
          const notifications = await policeNotifications.list(emergencyId);
          reply.send({ emergencyId, notifications, simulation: true, realPoliceContacted: false });
        }
      },
      {
        method: "POST",
        url: "/api/emergencies/:id/police-notifications",
        module: "module_09",
        summary: "Record a simulated notice to the mock police control room for a dispatched response route",
        auth: { roles: actionRoles },
        params: emergencyParams3,
        body: z13.object({ routeId: z13.string().min(1).max(128) }).strict(),
        handler: async (request, reply) => {
          const emergencyId = emergencyParams3.parse(request.params).id;
          const { routeId } = z13.object({ routeId: z13.string().min(1).max(128) }).parse(request.body);
          if (!request.user?.userId) throw new AppError(ErrorCode.UNAUTHORIZED, "Authentication is required.", 401);
          const notification = await policeNotifications.create(emergencyId, routeId, request.user.userId);
          reply.status(201).send({
            emergencyId,
            notification,
            simulation: true,
            recipient: "MOCK_POLICE_CONTROL_ROOM",
            realPoliceContacted: false,
            trafficCleared: false,
            signalPriorityGranted: false
          });
        }
      },
      {
        method: "POST",
        url: "/api/emergencies/:id/police-notifications/:notificationId/acknowledge",
        module: "module_09",
        summary: "Record an explicit simulated acknowledgement for a mock control-room notice",
        auth: { roles: actionRoles },
        params: z13.object({ id: z13.string().min(1).max(128), notificationId: z13.string().min(1).max(128) }).strict(),
        body: z13.object({}).strict(),
        handler: async (request, reply) => {
          const { id, notificationId } = z13.object({ id: z13.string().min(1).max(128), notificationId: z13.string().min(1).max(128) }).parse(request.params);
          if (!request.user?.userId) throw new AppError(ErrorCode.UNAUTHORIZED, "Authentication is required.", 401);
          const notification = await policeNotifications.acknowledge(id, notificationId, request.user.userId);
          reply.send({ emergencyId: id, notification, simulation: true, acknowledgedBy: "SIMULATED_OPERATOR", realPoliceAcknowledged: false });
        }
      }
    );
  }
  return routes;
}

// modules/module_09_corridor_coordination/src/policeNotificationService.ts
var SimulatedPoliceNotificationService = class {
  constructor(deps) {
    this.deps = deps;
  }
  async create(emergencyId, routeId, createdByUserId) {
    if (!this.deps.notifications.createPoliceRouteNotification) {
      throw new AppError(ErrorCode.INTERNAL_ERROR, "Simulated notification persistence is unavailable.", 503);
    }
    const route = (await this.deps.routes.routesForEmergency(emergencyId)).find((candidate) => candidate.id === routeId);
    if (!route) throw AppError.notFound("Route", routeId);
    this.assertRouteCanBeNotified(emergencyId, route);
    const confirmed = await hasDispatchEvidence(this.deps.dispatchEvents, emergencyId, route.ambulanceId);
    if (!confirmed) {
      throw new AppError(ErrorCode.CONFLICT, "A persisted explicit dispatch for this route ambulance is required.", 409);
    }
    this.deps.logger?.info({ emergencyId, ambulanceId: route.ambulanceId, routeId }, "creating simulated mock police control-room notice");
    return this.deps.notifications.createPoliceRouteNotification({
      emergencyId,
      createdByUserId,
      ambulanceId: route.ambulanceId,
      routeId,
      provider: route.provider,
      isLiveTraffic: route.isLiveTraffic,
      routeIsSimulation: route.isSimulation,
      estimatedMinutes: route.estimatedMinutes,
      geometry: route.polyline
    });
  }
  async acknowledge(emergencyId, notificationId, acknowledgedByUserId) {
    if (!this.deps.notifications.acknowledgePoliceRouteNotification) {
      throw new AppError(ErrorCode.INTERNAL_ERROR, "Simulated notification acknowledgement is unavailable.", 503);
    }
    return this.deps.notifications.acknowledgePoliceRouteNotification({ emergencyId, notificationId, acknowledgedByUserId });
  }
  async list(emergencyId) {
    const all = await this.deps.notifications.listForEmergency(emergencyId);
    return all.filter((item) => item.audience === "MOCK_POLICE_CONTROL_ROOM" && item.provider === "MOCK_POLICE_CONTROL_ROOM");
  }
  assertRouteCanBeNotified(emergencyId, route) {
    if (route.emergencyId !== emergencyId || route.originName !== "AMBULANCE" || route.destinationName !== "SCENE") {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "A persisted response route to the incident scene is required.", 422);
    }
    if (typeof route.provider !== "string" || route.provider.length === 0 || typeof route.isLiveTraffic !== "boolean") {
      throw new AppError(ErrorCode.CONFLICT, "Route provider and traffic provenance are unavailable.", 409);
    }
    if (!Array.isArray(route.polyline) || route.polyline.length < 2 || route.polyline.some(
      (point) => point.length !== 2 || !Number.isFinite(point[0]) || !Number.isFinite(point[1]) || point[0] < -90 || point[0] > 90 || point[1] < -180 || point[1] > 180
    )) {
      throw new AppError(ErrorCode.CONFLICT, "A valid persisted route geometry is required.", 409);
    }
  }
};
async function hasDispatchEvidence(events, emergencyId, ambulanceId) {
  let offset = 0;
  let total = 0;
  let latestAssignmentSequence = -1;
  let dispatchedSequence = -1;
  do {
    const page = await events.list({ emergencyId, types: ["AMBULANCE_ASSIGNED", "AMBULANCE_DISPATCHED"], limit: 500, offset });
    total = page.total;
    for (const event of page.items) {
      const payload = event.payload;
      if (payload.ambulanceId !== ambulanceId) continue;
      if (event.type === "AMBULANCE_ASSIGNED") latestAssignmentSequence = Math.max(latestAssignmentSequence, event.sequence);
      if (event.type === "AMBULANCE_DISPATCHED") dispatchedSequence = Math.max(dispatchedSequence, event.sequence);
    }
    offset += page.items.length;
    if (page.items.length === 0) break;
  } while (offset < total);
  return latestAssignmentSequence >= 0 && dispatchedSequence > latestAssignmentSequence;
}

// modules/module_09_corridor_coordination/src/module.ts
var Module9 = class {
  service;
  integration;
  autoCorridor;
  policeNotifications;
  config;
  constructor(deps) {
    this.config = deps.config ?? loadModule9Config();
    const logger2 = deps.logger ?? noopLogger;
    this.service = new CorridorService({
      corridors: deps.corridors,
      notifications: deps.notifications,
      roadUsers: new MockRoadUserProvider({ maxUsers: this.config.maxSimulatedRoadUsers }),
      notificationProvider: new MockNotificationProvider(),
      config: this.config,
      logger: logger2
    });
    this.integration = new CorridorIntegrationAdapter({
      corridors: this.service,
      routes: deps.routes
    });
    this.policeNotifications = deps.dispatchEvents && deps.notifications.createPoliceRouteNotification && deps.notifications.acknowledgePoliceRouteNotification ? new SimulatedPoliceNotificationService({
      routes: deps.routes,
      dispatchEvents: deps.dispatchEvents,
      notifications: deps.notifications,
      logger: logger2
    }) : void 0;
    this.autoCorridor = deps.bus && this.config.enabled ? new AutoCorridorService({
      events: deps.bus,
      corridors: this.service,
      routes: deps.routes,
      logger: logger2
    }) : void 0;
  }
  routes() {
    return createModule9Routes(this.service, this.integration, this.policeNotifications);
  }
  register(table) {
    table.addAll(this.routes());
  }
  dispose() {
    this.autoCorridor?.dispose();
  }
};

// modules/module_12_dashboard_analytics/src/config.ts
function parseBooleanEnv(name, value, defaultValue) {
  if (value === void 0) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error(`${name} must be either "true" or "false".`);
}
function loadModule12Config() {
  return {
    analytics: {
      defaultWindowDays: Number(process.env.MODULE12_DEFAULT_WINDOW_DAYS ?? 30),
      maxWindowDays: Number(process.env.MODULE12_MAX_WINDOW_DAYS ?? 365),
      includeSimulationByDefault: parseBooleanEnv("MODULE12_INCLUDE_SIM", process.env.MODULE12_INCLUDE_SIM, false)
    },
    dashboard: {
      refreshIntervalMs: Number(process.env.MODULE12_REFRESH_INTERVAL_MS ?? 5e3),
      maxEventsInTimeline: Number(process.env.MODULE12_MAX_TIMELINE ?? 100)
    },
    learning: {
      enabled: parseBooleanEnv("MODULE12_LEARNING_ENABLED", process.env.MODULE12_LEARNING_ENABLED, false),
      minSamplesForUpdate: Number(process.env.MODULE12_LEARNING_MIN_SAMPLES ?? 10)
    }
  };
}

// modules/module_12_dashboard_analytics/src/analytics/analyticsService.ts
var AnalyticsService = class {
  analyticsRead;
  config;
  logger;
  constructor(deps) {
    this.analyticsRead = deps.analyticsRead;
    this.config = deps.config;
    this.logger = deps.logger ?? noopLogger;
  }
  async getSummary(windowDays, includeSimulation) {
    const days = windowDays ?? this.config.analytics.defaultWindowDays;
    const sim = includeSimulation ?? this.config.analytics.includeSimulationByDefault;
    const durations = await this.analyticsRead.emergencyDurations(days, sim);
    const total = durations.length;
    const completed = durations.filter((d) => d.status === "COMPLETED").length;
    const responseTimes = durations.map((d) => d.responseTimeMin).filter((t) => t !== null);
    const totalTimes = durations.map((d) => d.totalDurationMin).filter((t) => t !== null);
    const avgResponse = responseTimes.length > 0 ? responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length : null;
    const avgTotal = totalTimes.length > 0 ? totalTimes.reduce((a, b) => a + b, 0) / totalTimes.length : null;
    const live = await this.analyticsRead.liveState(sim);
    const utilization = live.ambulances.length > 0 ? live.ambulances.filter((a) => a.status !== "AVAILABLE").length / live.ambulances.length : 0;
    return {
      windowDays: days,
      totalEmergencies: total,
      completedEmergencies: completed,
      averageResponseTimeMin: avgResponse ? Math.round(avgResponse * 100) / 100 : null,
      averageTotalDurationMin: avgTotal ? Math.round(avgTotal * 100) / 100 : null,
      ambulanceUtilizationRate: Math.round(utilization * 100) / 100
    };
  }
  async getEmergencyDurations(windowDays, includeSimulation) {
    const days = windowDays ?? this.config.analytics.defaultWindowDays;
    const sim = includeSimulation ?? this.config.analytics.includeSimulationByDefault;
    return this.analyticsRead.emergencyDurations(days, sim);
  }
  async getLiveState(includeSimulation) {
    const sim = includeSimulation ?? this.config.analytics.includeSimulationByDefault;
    return this.analyticsRead.liveState(sim);
  }
  async getEventBreakdown(windowDays, includeSimulation) {
    const days = windowDays ?? this.config.analytics.defaultWindowDays;
    const sim = includeSimulation ?? this.config.analytics.includeSimulationByDefault;
    return this.analyticsRead.eventBreakdown(days, sim);
  }
  async getLearningSamples(windowDays, includeSimulation) {
    const days = windowDays ?? this.config.analytics.defaultWindowDays;
    const sim = includeSimulation ?? this.config.analytics.includeSimulationByDefault;
    return this.analyticsRead.learningSamples({ windowDays: days, includeSimulation: sim });
  }
  async getSnapshotSeries(days) {
    return this.analyticsRead.snapshotSeries(days ?? 30);
  }
};

// modules/module_12_dashboard_analytics/src/dashboard/dashboardService.ts
var DashboardService = class {
  analyticsRead;
  events;
  config;
  logger;
  constructor(deps) {
    this.analyticsRead = deps.analyticsRead;
    this.events = deps.events;
    this.config = deps.config;
    this.logger = deps.logger ?? noopLogger;
  }
  async getLiveState(includeSimulation) {
    const sim = includeSimulation ?? this.config.analytics.includeSimulationByDefault;
    return this.analyticsRead.liveState(sim);
  }
  async getTimeline(emergencyId, limit) {
    const events = await this.events.timeline(emergencyId);
    const max = limit ?? this.config.dashboard.maxEventsInTimeline;
    return events.slice(0, max);
  }
  async getSystemMetrics(windowDays, includeSimulation) {
    const days = windowDays ?? this.config.analytics.defaultWindowDays;
    const sim = includeSimulation ?? this.config.analytics.includeSimulationByDefault;
    const [live, events, durations] = await Promise.all([
      this.analyticsRead.liveState(sim),
      this.analyticsRead.eventBreakdown(days, sim),
      this.analyticsRead.emergencyDurations(days, sim)
    ]);
    return {
      live,
      events,
      durations
    };
  }
};

// modules/module_12_dashboard_analytics/src/learning/learningService.ts
import { z as z14 } from "zod";
var featureValueSchema = z14.union([z14.number().finite(), z14.boolean(), z14.null()]);
var featureKeySchema = z14.string().regex(/^[a-z][a-zA-Z0-9_]{0,63}$/);
var timestampSchema = z14.string().datetime({ offset: true });
var learningFeatureSetSchema = z14.object({
  version: z14.literal(1),
  values: z14.record(featureKeySchema, featureValueSchema).refine((values) => Object.keys(values).length > 0, {
    message: "At least one version 1 feature is required."
  }),
  review: z14.object({
    status: z14.literal("VERIFIED"),
    eligibility: z14.literal("ELIGIBLE"),
    reviewedByUserId: z14.string().trim().min(1).max(128),
    reviewedAt: timestampSchema,
    outcomeObservedAt: timestampSchema,
    evidenceRefs: z14.array(z14.string().trim().min(1).max(256)).min(1),
    isSimulation: z14.literal(false),
    isTestData: z14.literal(false)
  }).strict()
}).strict();
var learningSampleInputSchema = z14.object({
  emergencyId: z14.string().regex(/^EMG-[A-Z0-9]{6,32}$/, "A canonical Module 11 emergencyId is required."),
  hospitalId: z14.string().trim().min(1).max(128).nullable().optional(),
  emergencyType: incidentTypeSchema,
  severity: emergencySeveritySchema,
  responseTimeMin: z14.number().finite().nonnegative().nullable().optional(),
  dispatchTimeMin: z14.number().finite().nonnegative().nullable().optional(),
  ambulanceDistanceKm: z14.number().finite().nonnegative().nullable().optional(),
  hospitalDistanceKm: z14.number().finite().nonnegative().nullable().optional(),
  protocolUsed: z14.string().trim().min(1).max(128).nullable().optional(),
  protocolVersion: z14.string().trim().min(1).max(128).nullable().optional(),
  escalationRequired: z14.boolean(),
  routeDurationMin: z14.number().finite().nonnegative().nullable().optional(),
  transportTimeMin: z14.number().finite().nonnegative().nullable().optional(),
  totalDurationMin: z14.number().finite().nonnegative().nullable().optional(),
  outcomeStatus: z14.enum(["SURVIVED_TO_DISCHARGE", "DECEASED", "UNKNOWN"]),
  survivalToDischarge: z14.boolean().nullable(),
  features: learningFeatureSetSchema,
  provenance: z14.literal("REAL_OBSERVED")
}).strict().superRefine((sample, context) => {
  const expectedSurvival = sample.outcomeStatus === "SURVIVED_TO_DISCHARGE" ? true : sample.outcomeStatus === "DECEASED" ? false : null;
  if (sample.survivalToDischarge !== expectedSurvival) {
    context.addIssue({
      code: z14.ZodIssueCode.custom,
      path: ["survivalToDischarge"],
      message: "Outcome status and survival label must agree; UNKNOWN must remain null."
    });
  }
});
var LearningService = class {
  analyticsRead;
  config;
  logger;
  constructor(deps) {
    this.analyticsRead = deps.analyticsRead;
    this.config = deps.config;
    this.logger = deps.logger ?? noopLogger;
  }
  async getInsights(windowDays, includeSimulation) {
    const days = windowDays ?? this.config.analytics.defaultWindowDays;
    const sim = includeSimulation ?? this.config.analytics.includeSimulationByDefault;
    const samples = await this.analyticsRead.learningSamples({ windowDays: days, includeSimulation: sim });
    const modelVersions = await this.analyticsRead.modelVersions(1);
    const survivalCases = samples.filter((s) => s.survivalToDischarge === true).length;
    const totalKnown = samples.filter((s) => s.survivalToDischarge !== null).length;
    const survivalRate = totalKnown > 0 ? survivalCases / totalKnown : null;
    return {
      modelVersion: modelVersions[0]?.version ?? 0,
      samples: samples.length,
      survivalRate: survivalRate === null ? null : Math.round(survivalRate * 100) / 100,
      topFactors: [],
      recommendations: []
    };
  }
  async storeLearningSample(input) {
    const sample = learningSampleInputSchema.parse(input);
    if (!this.config.learning.enabled) return;
    await this.analyticsRead.insertLearningSample({
      ...sample,
      features: {
        version: sample.features.version,
        values: sample.features.values,
        review: sample.features.review
      }
    });
  }
  async getSamples(windowDays, includeSimulation) {
    const days = windowDays ?? this.config.analytics.defaultWindowDays;
    const sim = includeSimulation ?? this.config.analytics.includeSimulationByDefault;
    return this.analyticsRead.learningSamples({ windowDays: days, includeSimulation: sim });
  }
  // Learning layer is isolated - never overrides protocol logic
  isSafetyCritical() {
    return false;
  }
};

// modules/module_12_dashboard_analytics/src/api/routes.ts
import { z as z15 } from "zod";
var includeSimulationQuerySchema = z15.preprocess((value) => {
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return value;
}, z15.boolean().optional());
var dashboardQuerySchema = z15.object({
  windowDays: z15.coerce.number().int().positive().optional(),
  includeSimulation: includeSimulationQuerySchema
});
function createModule12Routes(analytics, dashboard, learning) {
  const querySchema = dashboardQuerySchema;
  return [
    {
      method: "GET",
      url: "/api/dashboard/summary",
      module: "module_12",
      summary: "Get analytics summary",
      auth: { roles: ["OPERATOR", "DISPATCHER", "ADMIN"] },
      query: querySchema,
      handler: async (req, reply) => {
        const query = querySchema.parse(req.query);
        const summary = await analytics.getSummary(query.windowDays, query.includeSimulation);
        return reply.send({ summary });
      }
    },
    {
      method: "GET",
      url: "/api/dashboard/live",
      module: "module_12",
      summary: "Get live state",
      auth: { roles: ["OPERATOR", "DISPATCHER", "ADMIN"] },
      query: z15.object({ includeSimulation: includeSimulationQuerySchema }),
      handler: async (req, reply) => {
        const query = z15.object({ includeSimulation: includeSimulationQuerySchema }).parse(req.query);
        const live = await dashboard.getLiveState(query.includeSimulation);
        return reply.send(live);
      }
    },
    {
      method: "GET",
      url: "/api/dashboard/metrics",
      module: "module_12",
      summary: "Get system metrics",
      auth: { roles: ["OPERATOR", "DISPATCHER", "ADMIN"] },
      query: querySchema,
      handler: async (req, reply) => {
        const query = querySchema.parse(req.query);
        const metrics = await dashboard.getSystemMetrics(query.windowDays, query.includeSimulation);
        return reply.send(metrics);
      }
    },
    {
      method: "GET",
      url: "/api/dashboard/emergencies",
      module: "module_12",
      summary: "Get emergency durations",
      auth: { roles: ["OPERATOR", "DISPATCHER", "ADMIN"] },
      query: querySchema,
      handler: async (req, reply) => {
        const query = querySchema.parse(req.query);
        const emergencies = await analytics.getEmergencyDurations(query.windowDays, query.includeSimulation);
        return reply.send({ emergencies });
      }
    },
    {
      method: "GET",
      url: "/api/dashboard/ambulances",
      module: "module_12",
      summary: "Get ambulance status",
      auth: { roles: ["OPERATOR", "DISPATCHER", "ADMIN"] },
      query: z15.object({ includeSimulation: includeSimulationQuerySchema }),
      handler: async (req, reply) => {
        const query = z15.object({ includeSimulation: includeSimulationQuerySchema }).parse(req.query);
        const live = await dashboard.getLiveState(query.includeSimulation);
        return reply.send({ ambulances: live.ambulances });
      }
    },
    {
      method: "GET",
      url: "/api/dashboard/events/breakdown",
      module: "module_12",
      summary: "Get event breakdown",
      auth: { roles: ["OPERATOR", "DISPATCHER", "ADMIN"] },
      query: querySchema,
      handler: async (req, reply) => {
        const query = querySchema.parse(req.query);
        const breakdown = await analytics.getEventBreakdown(query.windowDays, query.includeSimulation);
        return reply.send({ breakdown });
      }
    },
    {
      method: "GET",
      url: "/api/dashboard/emergencies/:id/timeline",
      module: "module_12",
      summary: "Get event timeline for emergency",
      auth: { roles: ["OPERATOR", "DISPATCHER", "ADMIN"] },
      handler: async (req, reply) => {
        const id = String(req.params.id);
        const events = await dashboard.getTimeline(id);
        return reply.send({ emergencyId: id, events });
      }
    },
    {
      method: "GET",
      url: "/api/analytics/learning/samples",
      module: "module_12",
      summary: "Get learning samples",
      auth: { roles: ["ADMIN"] },
      query: querySchema,
      handler: async (req, reply) => {
        const query = querySchema.parse(req.query);
        const samples = await learning.getSamples(query.windowDays, query.includeSimulation);
        return reply.send({ samples });
      }
    },
    {
      method: "GET",
      url: "/api/analytics/learning/insights",
      module: "module_12",
      summary: "Get learning insights",
      auth: { roles: ["ADMIN"] },
      query: querySchema,
      handler: async (req, reply) => {
        const query = querySchema.parse(req.query);
        const insights = await learning.getInsights(query.windowDays, query.includeSimulation);
        return reply.send({ insights });
      }
    }
  ];
}

// modules/module_12_dashboard_analytics/src/module.ts
var Module12 = class {
  analytics;
  dashboard;
  learning;
  config;
  logger;
  constructor(deps) {
    this.config = deps.config ?? loadModule12Config();
    this.logger = deps.logger ?? noopLogger;
    this.analytics = new AnalyticsService({
      analyticsRead: deps.analyticsRead,
      config: this.config,
      logger: this.logger
    });
    this.dashboard = new DashboardService({
      analyticsRead: deps.analyticsRead,
      events: deps.events,
      config: this.config,
      logger: this.logger
    });
    this.learning = new LearningService({
      analyticsRead: deps.analyticsRead,
      config: this.config,
      logger: this.logger
    });
  }
  routes() {
    return createModule12Routes(this.analytics, this.dashboard, this.learning);
  }
  register(table) {
    table.addAll(this.routes());
  }
};

// modules/module10/module10/src/lifecycle/mapper.ts
import { INCIDENT_TYPES as INCIDENT_TYPES2 } from "@resus/core";
var PAYLOAD_EMERGENCY_ID_REQUIRED = /* @__PURE__ */ new Set([
  "CALL_CONNECTED",
  "NLP_EXTRACTION_COMPLETED",
  "AMBULANCE_ASSIGNED",
  "AMBULANCE_DISPATCHED",
  "HOSPITAL_SELECTED",
  "ROUTE_GENERATED",
  "CORRIDOR_ACTIVATED",
  "AMBULANCE_ARRIVED_SCENE",
  "PATIENT_ONBOARD",
  "AMBULANCE_ARRIVED_HOSPITAL",
  "EMERGENCY_COMPLETED"
]);
function eventReference(event) {
  return { eventId: event.id, sequence: event.sequence, timestamp: event.timestamp };
}
function mapLifecycleEvent(event, logger2) {
  const emergencyId = typeof event.emergencyId === "string" ? event.emergencyId : "";
  if (!emergencyId || emergencyId.trim() !== emergencyId) {
    logger2?.warn(
      { eventId: event.id, eventType: event.type, sequence: event.sequence },
      "Module 10 lifecycle projection ignored event without canonical emergencyId"
    );
    return null;
  }
  if (!event.id || !Number.isSafeInteger(event.sequence) || event.sequence < 1) return null;
  const payload = asRecord(event.payload);
  if (!payload) return null;
  const payloadEmergencyIdRequired = PAYLOAD_EMERGENCY_ID_REQUIRED.has(event.type);
  if (payloadEmergencyIdRequired && payload.emergencyId !== emergencyId || typeof payload.emergencyId === "string" && payload.emergencyId !== emergencyId) {
    logger2?.warn(
      { eventId: event.id, emergencyId, payloadEmergencyId: payload.emergencyId },
      "Module 10 lifecycle projection ignored event with missing or conflicting emergencyId"
    );
    return null;
  }
  const base = { emergencyId, eventId: event.id, sequence: event.sequence };
  switch (event.type) {
    case "EMERGENCY_CREATED": {
      if (!isIncidentType(payload.incidentType) || !isString(payload.severity) || typeof payload.isSimulation !== "boolean") return null;
      return { ...base, state: "EMERGENCY_CREATED", factKey: "emergencyCreated", fact: {
        incidentType: payload.incidentType,
        severity: payload.severity,
        isSimulation: payload.isSimulation
      } };
    }
    case "CALL_CONNECTED": {
      if (!isString(payload.callSessionId) || !isString(payload.channel) || !isString(payload.provider) || !isString(payload.transport) || typeof payload.isLiveTransport !== "boolean") return null;
      return { ...base, state: "CALL_CONNECTED", factKey: "callConnected", fact: {
        callSessionId: payload.callSessionId,
        isLiveTransport: payload.isLiveTransport
      } };
    }
    case "TRANSCRIPT_UPDATED": {
      if (payload.isFinal !== true) return null;
      if (!isString(payload.transcriptId) || !isString(payload.speaker) || !Number.isSafeInteger(payload.sequence)) return null;
      return { ...base, state: "TRANSCRIPT_FINAL", factKey: "finalTranscript", fact: {
        transcriptId: payload.transcriptId,
        sequence: payload.sequence,
        speaker: payload.speaker
      } };
    }
    case "NLP_EXTRACTION_COMPLETED": {
      if (!isString(payload.provider) || !isString(payload.model) || !isString(payload.incidentType) || !isString(payload.severity) || typeof payload.confidence !== "number" || typeof payload.latencyMs !== "number" || typeof payload.degraded !== "boolean") return null;
      return { ...base, factKey: "nlpExtraction", fact: {} };
    }
    case "EMERGENCY_CLASSIFIED": {
      if (!isIncidentType(payload.incidentType) || !isString(payload.severity) || typeof payload.confidence !== "number") return null;
      if (!["RULE", "LLM", "OPERATOR"].includes(String(payload.source))) return null;
      return { ...base, state: "CLASSIFICATION_CONFIRMED", factKey: "classification", fact: {
        incidentType: payload.incidentType,
        severity: payload.severity,
        confidence: payload.confidence,
        source: payload.source
      } };
    }
    case "AMBULANCE_ASSIGNED": {
      if (!isString(payload.assignmentId) || !isString(payload.ambulanceId)) return null;
      if (!["AUTOMATIC", "MANUAL_OVERRIDE"].includes(String(payload.source))) return null;
      return { ...base, state: "AMBULANCE_ASSIGNED", factKey: "ambulanceAssignment", fact: {
        assignmentId: payload.assignmentId,
        ambulanceId: payload.ambulanceId,
        source: payload.source
      } };
    }
    case "AMBULANCE_DISPATCHED": {
      if (!isString(payload.ambulanceId)) return null;
      return { ...base, state: "AMBULANCE_DISPATCHED", factKey: "ambulanceDispatch", fact: { ambulanceId: payload.ambulanceId } };
    }
    case "HOSPITAL_SELECTED": {
      if (!isString(payload.hospitalId)) return null;
      return { ...base, state: "HOSPITAL_SELECTED", factKey: "hospitalSelection", fact: { hospitalId: payload.hospitalId } };
    }
    case "ROUTE_GENERATED": {
      if (!isString(payload.routeId) || !isString(payload.provider) || typeof payload.isLiveTraffic !== "boolean") return null;
      return { ...base, state: "ROUTE_GENERATED", factKey: "route", fact: {
        routeId: payload.routeId,
        provider: payload.provider,
        isLiveTraffic: payload.isLiveTraffic
      } };
    }
    case "CORRIDOR_ACTIVATED": {
      if (!isString(payload.ambulanceId) || !isString(payload.hospitalId)) return null;
      return {
        ...base,
        state: "CORRIDOR_ACTIVATED",
        factKey: "corridor",
        fact: {
          ambulanceId: payload.ambulanceId,
          hospitalId: payload.hospitalId,
          simulationStatus: "NOT_REPORTED_BY_EVENT",
          signalControlStatus: "NOT_REPORTED_BY_EVENT"
        }
      };
    }
    case "AMBULANCE_ARRIVED_SCENE": {
      if (!isString(payload.ambulanceId) || payload.evidenceSource !== "OPERATOR_REPORTED" || !isDataClassification(payload.dataClassification) || !isValidTimestamp(payload.observedAt) || typeof payload.responseTimeMin !== "number" || payload.responseTimeMin < 0) return null;
      return { ...base, state: "AMBULANCE_ARRIVED_SCENE", factKey: "sceneArrival", fact: {
        ambulanceId: payload.ambulanceId,
        evidenceSource: "OPERATOR_REPORTED",
        dataClassification: payload.dataClassification,
        observedAt: payload.observedAt,
        responseTimeMin: payload.responseTimeMin
      } };
    }
    case "PATIENT_ONBOARD": {
      if (!isString(payload.ambulanceId) || !(payload.hospitalId === null || isString(payload.hospitalId)) || payload.evidenceSource !== "OPERATOR_REPORTED" || !isDataClassification(payload.dataClassification) || !isValidTimestamp(payload.observedAt)) return null;
      return { ...base, state: "PATIENT_ONBOARD", factKey: "patientOnboard", fact: {
        ambulanceId: payload.ambulanceId,
        hospitalId: payload.hospitalId,
        evidenceSource: "OPERATOR_REPORTED",
        dataClassification: payload.dataClassification,
        observedAt: payload.observedAt
      } };
    }
    case "AMBULANCE_ARRIVED_HOSPITAL": {
      if (!isString(payload.ambulanceId) || !isString(payload.hospitalId) || payload.evidenceSource !== "OPERATOR_REPORTED" || !isDataClassification(payload.dataClassification) || !isValidTimestamp(payload.observedAt)) return null;
      return { ...base, state: "AMBULANCE_ARRIVED_HOSPITAL", factKey: "hospitalArrival", fact: {
        ambulanceId: payload.ambulanceId,
        hospitalId: payload.hospitalId,
        evidenceSource: "OPERATOR_REPORTED",
        dataClassification: payload.dataClassification,
        observedAt: payload.observedAt
      } };
    }
    case "EMERGENCY_COMPLETED": {
      if (!isString(payload.emergencyId) || !isNumberAtLeastZero(payload.totalDurationMin) || payload.status !== "COMPLETED" || typeof payload.isSimulation !== "boolean" || payload.evidenceSource !== "OPERATOR_REPORTED" || !isValidTimestamp(payload.observedAt)) return null;
      if (!isDataClassification(payload.dataClassification)) return null;
      return { ...base, state: "OPERATIONAL_COMPLETION_RECORDED", factKey: "operationalCompletion", fact: {
        status: "COMPLETED",
        totalDurationMin: payload.totalDurationMin,
        isSimulation: payload.isSimulation,
        evidenceSource: "OPERATOR_REPORTED",
        dataClassification: payload.dataClassification,
        observedAt: payload.observedAt
      } };
    }
    default:
      return null;
  }
}
function asRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function isString(value) {
  return typeof value === "string" && value.length > 0;
}
function isNumberAtLeastZero(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function isValidTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
function isDataClassification(value) {
  return value === "OPERATIONAL" || value === "SIMULATION" || value === "TEST";
}
function isIncidentType(value) {
  return typeof value === "string" && INCIDENT_TYPES2.includes(value);
}

// modules/module10/module10/src/lifecycle/reducer.ts
var STATE_RANK = {
  NO_LIFECYCLE_EVENT: 0,
  EMERGENCY_CREATED: 1,
  CALL_CONNECTED: 2,
  TRANSCRIPT_FINAL: 3,
  CLASSIFICATION_CONFIRMED: 4,
  AMBULANCE_ASSIGNED: 5,
  AMBULANCE_DISPATCHED: 6,
  HOSPITAL_SELECTED: 7,
  ROUTE_GENERATED: 8,
  CORRIDOR_ACTIVATED: 9,
  AMBULANCE_ARRIVED_SCENE: 10,
  PATIENT_ONBOARD: 11,
  AMBULANCE_ARRIVED_HOSPITAL: 12,
  OPERATIONAL_COMPLETION_RECORDED: 13
};
function reduceLifecycleProjection(current, event, logger2) {
  const mapped = mapLifecycleEvent(event, logger2);
  if (!mapped) return current;
  const projection = current ?? {
    emergencyId: mapped.emergencyId,
    state: "NO_LIFECYCLE_EVENT",
    facts: {},
    processedEventIds: [],
    lastEventId: mapped.eventId,
    lastSequence: 0,
    anomalies: []
  };
  if (projection.emergencyId !== mapped.emergencyId) {
    logger2?.warn(
      { eventId: event.id, expectedEmergencyId: projection.emergencyId, actualEmergencyId: mapped.emergencyId },
      "Module 10 lifecycle projection ignored event for a different emergencyId"
    );
    return current;
  }
  if (projection.processedEventIds.includes(mapped.eventId)) return projection;
  const fact = { ...mapped.fact, event: eventReference(event) };
  const previousFact = projection.facts[mapped.factKey];
  const facts = previousFact?.event?.sequence !== void 0 && previousFact.event.sequence > mapped.sequence ? projection.facts : { ...projection.facts, [mapped.factKey]: fact };
  const anomalies = [...projection.anomalies];
  if (mapped.factKey === "corridor" && !projection.facts.route) {
    anomalies.push({ code: "MISSING_PREDECESSOR", eventId: mapped.eventId, missingFact: "route" });
  }
  const missingPredecessor = {
    sceneArrival: "ambulanceDispatch",
    patientOnboard: "sceneArrival",
    hospitalArrival: "patientOnboard",
    operationalCompletion: "hospitalArrival"
  };
  const requiredFact = missingPredecessor[mapped.factKey];
  if (requiredFact && !projection.facts[requiredFact]) {
    anomalies.push({ code: "MISSING_PREDECESSOR", eventId: mapped.eventId, missingFact: requiredFact });
  }
  const nextState = mapped.state && STATE_RANK[mapped.state] > STATE_RANK[projection.state] ? mapped.state : projection.state;
  return {
    ...projection,
    state: nextState,
    facts,
    processedEventIds: [...projection.processedEventIds, mapped.eventId],
    lastEventId: mapped.sequence >= projection.lastSequence ? mapped.eventId : projection.lastEventId,
    lastSequence: Math.max(projection.lastSequence, mapped.sequence),
    anomalies
  };
}

// modules/module10/module10/src/lifecycle/observer.ts
var MODULE10_LIFECYCLE_EVENT_TYPES = [
  "EMERGENCY_CREATED",
  "CALL_CONNECTED",
  "TRANSCRIPT_UPDATED",
  "NLP_EXTRACTION_COMPLETED",
  "EMERGENCY_CLASSIFIED",
  "AMBULANCE_ASSIGNED",
  "AMBULANCE_DISPATCHED",
  "HOSPITAL_SELECTED",
  "ROUTE_GENERATED",
  "CORRIDOR_ACTIVATED",
  "AMBULANCE_ARRIVED_SCENE",
  "PATIENT_ONBOARD",
  "AMBULANCE_ARRIVED_HOSPITAL",
  "EMERGENCY_COMPLETED"
];
var MODULE10_LIFECYCLE_REPLAY_PAGE_SIZE = 500;
var eventTypeSet = new Set(MODULE10_LIFECYCLE_EVENT_TYPES);
var Module10LifecycleObserver = class {
  projections = /* @__PURE__ */ new Map();
  processedEventIds = /* @__PURE__ */ new Set();
  bufferedEvents = [];
  processingByEmergency = /* @__PURE__ */ new Map();
  bus;
  events;
  logger;
  unsubscribe;
  state = "idle";
  startPromise;
  interruptStartup;
  constructor(deps) {
    this.bus = deps.bus;
    this.events = deps.events;
    this.logger = deps.logger;
  }
  get isReady() {
    return this.state === "ready";
  }
  /**
   * Subscribe first, replay the committed event log to a captured high-water
   * sequence, then drain live events buffered during replay. A failed replay
   * rejects startup; callers must not advertise this observer as recovered.
   */
  start() {
    if (this.state === "ready") return Promise.resolve();
    if (this.state === "starting" && this.startPromise) return this.startPromise;
    if (this.state === "stopping" || this.state === "stopped") {
      return Promise.reject(new Error("Module 10 lifecycle observer has been disposed"));
    }
    this.clearState();
    this.state = "starting";
    this.unsubscribe = this.bus.subscribe(
      [...MODULE10_LIFECYCLE_EVENT_TYPES],
      (event) => this.receive(event)
    );
    let rejectInterrupted;
    const interrupted = new Promise((_resolve, reject) => {
      rejectInterrupted = reject;
    });
    this.interruptStartup = () => rejectInterrupted(new Error("Module 10 lifecycle observer startup was interrupted"));
    const startPromise = Promise.race([this.replayAndDrain(), interrupted]).then(() => {
      if (this.state !== "starting") {
        throw new Error("Module 10 lifecycle observer startup was interrupted");
      }
      this.state = "ready";
    }).catch((error) => {
      this.unsubscribe?.();
      this.unsubscribe = void 0;
      this.bufferedEvents.length = 0;
      if (this.state !== "stopping" && this.state !== "stopped") {
        this.clearState();
        this.state = "failed";
      }
      this.logger?.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Module 10 lifecycle observer replay failed; startup is not ready"
      );
      throw error;
    }).finally(() => {
      if (this.startPromise === startPromise) {
        this.startPromise = void 0;
        this.interruptStartup = void 0;
      }
    });
    this.startPromise = startPromise;
    return startPromise;
  }
  getProjection(emergencyId) {
    if (!this.isReady || !emergencyId || emergencyId.trim() !== emergencyId) return null;
    const projection = this.projections.get(emergencyId);
    return projection ? structuredClone(projection) : null;
  }
  /** Stop accepting records, detach from the bus and drain queued work. */
  async dispose() {
    if (this.state === "stopped") return;
    this.state = "stopping";
    this.unsubscribe?.();
    this.unsubscribe = void 0;
    this.bufferedEvents.length = 0;
    this.interruptStartup?.();
    const startup = this.startPromise;
    if (startup) await startup.catch(() => void 0);
    await Promise.all([...this.processingByEmergency.values()]);
    this.clearState();
    this.state = "stopped";
  }
  receive(event) {
    if (this.state === "stopping" || this.state === "stopped" || this.state === "failed") return;
    if (!eventTypeSet.has(event.type)) {
      this.logger?.debug(
        { eventId: event.id, eventType: event.type },
        "Module 10 lifecycle observer ignored unsupported event type"
      );
      return;
    }
    if (this.state === "starting") {
      this.bufferedEvents.push(event);
      return;
    }
    return this.enqueue(event);
  }
  async replayAndDrain() {
    const highWaterSequence = await this.replayHistory();
    this.ensureStarting();
    this.logger?.info(
      { highWaterSequence },
      "Module 10 lifecycle event history replayed; draining buffered live events"
    );
    while (this.bufferedEvents.length > 0) {
      this.ensureStarting();
      const batch = this.bufferedEvents.splice(0).sort(compareEvents);
      for (const event of batch) {
        this.ensureStarting();
        await this.enqueue(event);
      }
    }
  }
  async replayHistory() {
    let cursor = 0;
    let highWaterSequence;
    let firstPage = true;
    while (true) {
      this.ensureStarting();
      const page = await this.events.list({
        types: [...MODULE10_LIFECYCLE_EVENT_TYPES],
        sinceSequence: cursor,
        limit: MODULE10_LIFECYCLE_REPLAY_PAGE_SIZE,
        offset: 0
      });
      this.ensureStarting();
      if (!Array.isArray(page.items) || !Number.isSafeInteger(page.latestSequence) || page.latestSequence < 0) {
        throw new Error("Module 11 returned an invalid lifecycle replay page");
      }
      if (page.items.length > MODULE10_LIFECYCLE_REPLAY_PAGE_SIZE) {
        throw new Error("Module 11 returned more lifecycle replay records than requested");
      }
      if (page.items.some(
        (event) => !Number.isSafeInteger(event.sequence) || event.sequence <= 0 || typeof event.id !== "string" || event.id.length === 0 || event.id.trim() !== event.id
      )) {
        throw new Error("Module 11 returned a malformed lifecycle replay event record");
      }
      if (firstPage) {
        highWaterSequence = page.latestSequence;
        firstPage = false;
      }
      const ordered = [...page.items].sort(compareEvents);
      const eligible = ordered.filter(
        (event) => Number.isSafeInteger(event.sequence) && event.sequence > cursor && event.sequence <= highWaterSequence
      );
      for (const event of eligible) {
        this.ensureStarting();
        await this.enqueue(event);
        cursor = Math.max(cursor, event.sequence);
      }
      if (ordered.some((event) => Number.isSafeInteger(event.sequence) && event.sequence > highWaterSequence)) {
        break;
      }
      if (ordered.length === 0) break;
      if (ordered.length < MODULE10_LIFECYCLE_REPLAY_PAGE_SIZE) break;
      if (eligible.length === 0) {
        throw new Error("Module 11 lifecycle replay page made no sequence progress");
      }
    }
    return highWaterSequence ?? 0;
  }
  enqueue(event) {
    const emergencyId = event.emergencyId;
    if (typeof emergencyId !== "string" || emergencyId.trim() !== emergencyId || emergencyId.length === 0) {
      this.apply(event);
      return Promise.resolve();
    }
    if (event.id && this.processedEventIds.has(event.id)) return Promise.resolve();
    const previous = this.processingByEmergency.get(emergencyId) ?? Promise.resolve();
    const queued = previous.then(() => {
      if (this.state === "stopping" || this.state === "stopped") return;
      this.apply(event);
    }).catch((error) => {
      this.logger?.error(
        { eventId: event.id, emergencyId, error: error instanceof Error ? error.message : String(error) },
        "Module 10 lifecycle event processing failed"
      );
    });
    this.processingByEmergency.set(emergencyId, queued);
    void queued.then(() => {
      if (this.processingByEmergency.get(emergencyId) === queued) {
        this.processingByEmergency.delete(emergencyId);
      }
    });
    return queued;
  }
  apply(event) {
    if (event.id && this.processedEventIds.has(event.id)) return;
    const current = typeof event.emergencyId === "string" ? this.projections.get(event.emergencyId) : void 0;
    const next = reduceLifecycleProjection(current, event, this.logger);
    if (next) {
      this.projections.set(next.emergencyId, next);
      if (event.id && next.processedEventIds.includes(event.id)) this.processedEventIds.add(event.id);
      else this.logger?.debug(
        { eventId: event.id, eventType: event.type, emergencyId: event.emergencyId },
        "Module 10 lifecycle observer ignored malformed projection input"
      );
    }
  }
  ensureStarting() {
    if (this.state !== "starting") throw new Error("Module 10 lifecycle observer startup was interrupted");
  }
  clearState() {
    this.projections.clear();
    this.processedEventIds.clear();
    this.bufferedEvents.length = 0;
    this.processingByEmergency.clear();
  }
};
function compareEvents(left, right) {
  const leftSequence = Number.isSafeInteger(left.sequence) ? left.sequence : Number.MAX_SAFE_INTEGER;
  const rightSequence = Number.isSafeInteger(right.sequence) ? right.sequence : Number.MAX_SAFE_INTEGER;
  const leftId = typeof left.id === "string" ? left.id : "";
  const rightId = typeof right.id === "string" ? right.id : "";
  return leftSequence - rightSequence || leftId.localeCompare(rightId);
}

// modules/module10/module10/src/lifecycle/routes.ts
import { AppError as AppError2 } from "@resus/core";
import { z as z16 } from "zod";
var lifecycleParams = z16.object({ id: z16.string().min(1) });
function createModule10LifecycleRoutes(observer) {
  return [{
    method: "GET",
    url: "/api/emergencies/:id/lifecycle",
    module: "module_10",
    summary: "Read observed lifecycle facts for an emergency",
    auth: { roles: ["OPERATOR", "DISPATCHER", "CLINICAL_SUPERVISOR", "ADMIN"] },
    params: lifecycleParams,
    handler: async (request, reply) => {
      const { id } = lifecycleParams.parse(request.params);
      const projection = observer.getProjection(id);
      if (!projection) {
        const error = AppError2.notFound("Lifecycle projection", id);
        return reply.status(error.statusCode).send({
          error: { code: error.code, message: error.message, details: error.details ?? null }
        });
      }
      return reply.send({ projection });
    }
  }];
}

// apps/server/src/asterisk/callDurationWatch.ts
var DEFAULT_CALL_DURATION_SWEEP_MS = 6e4;
function startCallDurationWatch(deps) {
  const clock = deps.now ?? (() => /* @__PURE__ */ new Date());
  const notBefore = clock();
  const intervalMs = deps.intervalMs ?? DEFAULT_CALL_DURATION_SWEEP_MS;
  let inFlight = false;
  let stopped = false;
  const timer = setInterval(() => {
    if (inFlight || stopped) return;
    inFlight = true;
    void deps.enforce(clock(), notBefore).catch((error) => {
      deps.logger.error(
        { reason: error.message },
        "maximum call duration sweep failed"
      );
    }).finally(() => {
      inFlight = false;
    });
  }, intervalMs);
  if (typeof timer.unref === "function") {
    timer.unref();
  }
  return {
    notBefore,
    stop() {
      stopped = true;
      clearInterval(timer);
    }
  };
}

// apps/server/src/asterisk/runtime.ts
async function startAsteriskRuntime(deps) {
  const { module1, config, logger: logger2 } = deps;
  if (module1.config.telephony.provider !== "asterisk") return null;
  const asterisk = module1.config.telephony.asterisk;
  if (!asterisk) {
    throw new Error('TRANSPORT_PROVIDER="asterisk" but no Asterisk configuration was resolved.');
  }
  const provider = module1.telephony;
  if (!(provider instanceof AsteriskTelephonyProvider)) {
    throw new Error(
      `TRANSPORT_PROVIDER="asterisk" resolved to the '${module1.telephony.providerName}' provider; expected the Asterisk adapter.`
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
      longitude: asterisk.inbound.longitude
    },
    logger: logger2
  });
  const bridge = new AudioBridge({
    provider,
    calls: deps.calls,
    speech: deps.speech,
    ...deps.conversation ? { conversation: deps.conversation } : {},
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
      silenceTimeoutMs: config.conversation.silenceTimeoutMs
    },
    logger: logger2
  });
  module1.calls.setSyntheticTimingMarkerSink(
    (callSessionId, marker) => bridge.recordSyntheticSpeechMarker(callSessionId, marker)
  );
  intake.start();
  let audioSocket;
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
  logger2.info(
    {
      ami: `${asterisk.ami.host}:${asterisk.ami.port}`,
      audioSocket: `${audioSocket.host}:${audioSocket.port}`,
      audioSocketAdvertised: `${asterisk.audioSocket.advertiseHost}:${asterisk.audioSocket.bindPort}`,
      greeting: config.asterisk.greeting !== ""
    },
    "Asterisk telephony runtime started"
  );
  const durationWatch = startCallDurationWatch({
    enforce: (now, notBefore) => module1.calls.enforceMaxDuration(now, notBefore),
    logger: logger2
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
    }
  };
}

// apps/server/src/dev/protocolChat.ts
var INCIDENT_TYPES3 = [
  "CARDIAC_ARREST",
  "SEVERE_BLEEDING",
  "CHOKING",
  "ACTIVE_SEIZURE",
  "CHEST_PAIN",
  "OTHER"
];
var PAGE = (
  /* html */
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Module 5 protocol harness (dev only)</title>
<style>
  :root { color-scheme: dark; --bg:#0f1115; --panel:#171a21; --line:#262b36; --text:#e6e9ef; --muted:#98a1b3;
          --accent:#5b8cff; --warn:#f0a13c; --bad:#e5484d; --good:#3fb950; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; }
  header { padding:12px 16px; border-bottom:1px solid var(--line); display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
  h1 { font-size:14px; margin:0; font-weight:600; }
  .badge { background:var(--warn); color:#1a1200; padding:2px 8px; border-radius:10px; font-size:11px; font-weight:700; }
  .badge.bad { background:var(--bad); color:#fff; }
  main { display:grid; grid-template-columns:340px 1fr; gap:0; height:calc(100vh - 53px); }
  aside { border-right:1px solid var(--line); padding:16px; overflow:auto; }
  section { padding:16px; display:flex; flex-direction:column; min-height:0; }
  label { display:block; font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); margin-bottom:6px; }
  select, textarea, button { width:100%; background:var(--panel); color:var(--text); border:1px solid var(--line);
    border-radius:6px; padding:8px; font:inherit; }
  textarea { min-height:74px; resize:vertical; }
  button { background:var(--accent); color:#06122e; border:0; font-weight:700; cursor:pointer; margin-top:10px; }
  button.ghost { background:transparent; color:var(--muted); border:1px solid var(--line); font-weight:400; }
  button:disabled { opacity:.45; cursor:not-allowed; }
  .field { margin-bottom:14px; }
  .row { display:flex; gap:8px; align-items:center; }
  #log { flex:1; overflow:auto; border:1px solid var(--line); border-radius:6px; background:var(--panel);
    padding:12px; margin-top:10px; min-height:0; }
  .turn { border-left:2px solid var(--line); padding:8px 0 8px 12px; margin-bottom:14px; }
  .turn.sys { border-left-color:var(--accent); }
  .turn.you { border-left-color:var(--muted); }
  .who { font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); margin-bottom:4px; }
  .say { white-space:pre-wrap; }
  .meta { margin-top:8px; display:flex; flex-wrap:wrap; gap:6px; }
  .tag { font-size:11px; border:1px solid var(--line); border-radius:10px; padding:1px 8px; color:var(--muted); }
  .tag.warn { color:var(--warn); border-color:var(--warn); }
  .tag.bad { color:var(--bad); border-color:var(--bad); }
  .tag.good { color:var(--good); border-color:var(--good); }
  table { width:100%; border-collapse:collapse; font-size:12px; margin-top:6px; }
  td { padding:2px 0; vertical-align:top; }
  td:first-child { color:var(--muted); width:42%; padding-right:8px; }
  details { margin-top:8px; }
  summary { cursor:pointer; color:var(--muted); font-size:12px; }
  #llm { margin-top:12px; font-size:12px; }
  .hint { color:var(--muted); font-size:12px; margin-top:10px; }
</style>
</head>
<body>
<header>
  <h1>Module 5 protocol harness</h1>
  <span class="badge">DEVELOPMENT ONLY</span>
  <span class="badge bad" id="envbadge">not production</span>
  <span class="tag" id="llmbadge">llm: checking\u2026</span>
  <span style="flex:1"></span>
  <button class="ghost" style="width:auto;margin:0;padding:6px 12px" onclick="copyTranscript()">copy transcript</button>
</header>
<main>
  <aside>
    <div class="field">
      <label for="incident">Incident type</label>
      <select id="incident">${INCIDENT_TYPES3.map((t) => `<option>${t}</option>`).join("")}</select>
    </div>
    <div class="field">
      <label for="utterance">What the bystander says</label>
      <textarea id="utterance" placeholder="he is unresponsive and not breathing"></textarea>
    </div>
    <button id="send">Start / send</button>
    <button class="ghost" id="reset">New emergency</button>
    <div class="hint" id="hint">
      Start a session, then keep answering. Try: <em>\u201CI don't know if he is responsive\u201D</em>,
      <em>\u201Cthere are wires sparking across the road\u201D</em>, <em>\u201Cnot sure\u201D</em> three times.
    </div>
    <div id="llm"></div>
  </aside>
  <section>
    <div class="row">
      <span class="tag" id="sessiontag">no session</span>
      <span class="tag" id="steptag">\u2014</span>
      <span class="tag" id="statustag">\u2014</span>
    </div>
    <div id="log"></div>
  </section>
</main>
<script>
let sessionId = null, emergencyId = null, token = null;
const $ = (id) => document.getElementById(id);

async function post(path, body) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  const res = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { ok: res.ok, status: res.status, data };
}

function tag(text, cls = '') { const el = document.createElement('span'); el.className = 'tag ' + cls; el.textContent = text; return el; }

function addTurn(who, text, metas = [], facts = null, reason = null) {
  const wrap = document.createElement('div');
  wrap.className = 'turn ' + (who === 'system' ? 'sys' : 'you');
  const label = document.createElement('div');
  label.className = 'who';
  label.textContent = who === 'system' ? 'assistant' : 'bystander';
  const say = document.createElement('div');
  say.className = 'say';
  say.textContent = text;
  wrap.append(label, say);

  if (metas.length) {
    const meta = document.createElement('div');
    meta.className = 'meta';
    metas.forEach((m) => meta.appendChild(tag(m.text, m.cls)));
    wrap.appendChild(meta);
  }

  if (reason) {
    const d = document.createElement('details');
    const s = document.createElement('summary');
    s.textContent = 'escalation reason';
    const p = document.createElement('div');
    p.className = 'say';
    p.style.color = 'var(--bad)';
    p.textContent = reason;
    d.append(s, p);
    wrap.appendChild(d);
  }

  if (facts && Object.keys(facts).length) {
    const d = document.createElement('details');
    const s = document.createElement('summary');
    s.textContent = 'facts extracted';
    const table = document.createElement('table');
    Object.entries(facts).forEach(([k, v]) => {
      const tr = document.createElement('tr');
      const a = document.createElement('td'); a.textContent = k;
      const b = document.createElement('td'); b.textContent = typeof v === 'string' ? v : JSON.stringify(v);
      tr.append(a, b); table.appendChild(tr);
    });
    d.append(s, table);
    wrap.appendChild(d);
  }

  $('log').appendChild(wrap);
  $('log').scrollTop = $('log').scrollHeight;
}

function renderTurn(turn) {
  const metas = [];
  metas.push({ text: 'step: ' + turn.currentStepId, cls: '' });
  metas.push({ text: turn.action, cls: turn.action === 'ESCALATED' ? 'bad' : turn.action === 'CLARIFY' ? 'warn' : 'good' });
  if (turn.requiresClarification) metas.push({ text: 'clarification', cls: 'warn' });
  if (turn.degraded) metas.push({ text: 'degraded extraction', cls: 'warn' });
  if (turn.missingFacts && turn.missingFacts.length) metas.push({ text: 'missing: ' + turn.missingFacts.join(', '), cls: 'warn' });
  if (turn.paraphrased === false) metas.push({ text: 'protocol text verbatim', cls: '' });
  if (turn.llmNotice) metas.push({ text: turn.llmNotice, cls: 'warn' });

  addTurn('system', turn.speech, metas, turn.session && turn.session.collectedFacts, turn.escalationReason || null);

  $('sessiontag').textContent = 'session ' + turn.session.id;
  $('steptag').textContent = turn.currentStepId;
  $('statustag').textContent = turn.status;
  $('statustag').className = 'tag ' + (turn.status === 'ESCALATED' ? 'bad' : turn.status === 'ACTIVE' || turn.status === 'WAITING_FOR_RESPONSE' ? '' : 'warn');
}

function fail(message) {
  const wrap = document.createElement('div');
  wrap.className = 'turn';
  const say = document.createElement('div');
  say.className = 'say';
  say.style.color = 'var(--bad)';
  say.textContent = message;
  wrap.appendChild(say);
  $('log').appendChild(wrap);
}

async function authenticate() {
  // Operator endpoints are authenticated, so the harness mints a local token
  // first. That route exists only when NODE_ENV is not production.
  const res = await fetch('/api/auth/dev-token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'operator@resus.local' }),
  });
  if (!res.ok) {
    fail('this server has no development token route; the harness needs NODE_ENV=development');
    $('send').disabled = true;
    return false;
  }
  token = (await res.json()).token;
  return true;
}

async function send() {
  const utterance = $('utterance').value.trim();
  const button = $('send');
  button.disabled = true;
  try {
    if (!token && !(await authenticate())) return;
    if (!sessionId) {
      const emergency = await post('/api/dev/harness/emergency', { incidentType: $('incident').value });
      if (!emergency.ok) return fail('could not create a development emergency: ' + JSON.stringify(emergency.data));
      emergencyId = emergency.data.emergency.id;
      const start = await post('/api/protocol-sessions', { emergencyId, incidentType: $('incident').value });
      if (!start.ok) return fail('could not start the session: ' + JSON.stringify(start.data));
      sessionId = start.data.session.id;
      renderTurn(start.data);
      $('utterance').value = '';
      $('send').textContent = 'Send';
      return;
    }
    if (!utterance) return;
    addTurn('you', utterance);
    const res = await post('/api/protocol-sessions/' + sessionId + '/utterance', { utterance });
    if (!res.ok) { fail('request failed (' + res.status + '): ' + JSON.stringify(res.data)); return; }
    renderTurn(res.data);
    $('utterance').value = '';
  } finally {
    button.disabled = false;
  }
}

function reset() {
  sessionId = null;
  emergencyId = null;
  $('log').textContent = '';
  $('sessiontag').textContent = 'no session';
  $('steptag').textContent = '\u2014';
  $('statustag').textContent = '\u2014';
  $('send').textContent = 'Start / send';
}

function copyTranscript() {
  const text = [...$('log').children]
    .map((node) => {
      const who = node.querySelector('.who');
      const say = node.querySelector('.say');
      if (!who || !say) return '';
      const meta = node.querySelector('.meta');
      return who.textContent.toUpperCase() + ': ' + say.textContent + (meta ? '\\n  [' + [...meta.children].map((t) => t.textContent).join(' | ') + ']' : '');
    })
    .filter(Boolean)
    .join('\\n');
  navigator.clipboard?.writeText(text);
}

async function loadLlm() {
  const res = await fetch('/api/health/llm');
  const health = await res.json();
  const badge = $('llmbadge');
  badge.textContent = 'llm: ' + health.provider + '/' + health.model + (health.degraded ? ' (degraded)' : '');
  badge.className = 'tag ' + (health.degraded ? 'warn' : 'good');

  const box = $('llm');
  const rows = [
    ['provider', health.provider],
    ['model', health.model],
    ['available', String(health.available)],
    ['degraded', String(health.degraded)],
    ['fallback', health.fallbackEnabled ? 'allowed' : 'blocked'],
    ['reason', health.reason ?? '\u2014'],
  ];
  const table = document.createElement('table');
  rows.forEach(([k, v]) => {
    const tr = document.createElement('tr');
    const a = document.createElement('td'); a.textContent = k;
    const b = document.createElement('td'); b.textContent = v;
    tr.append(a, b); table.appendChild(tr);
  });
  box.appendChild(table);
  if (health.degraded) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.style.color = 'var(--warn)';
    p.textContent = 'Running on the keyword fallback: extraction is degraded and every turn requires confirmation.';
    box.appendChild(p);
  }
}

$('send').addEventListener('click', send);
$('reset').addEventListener('click', reset);
$('utterance').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(); });
$('utterance').addEventListener('input', () => { $('send').textContent = sessionId ? 'Send' : 'Start session'; });
loadLlm();
</script>
</body>
</html>`
);
function registerDevHarness(fastify, module11, isProduction) {
  if (isProduction) return;
  fastify.get(
    "/dev/protocol-chat",
    async (_request, reply) => reply.type("text/html; charset=utf-8").send(PAGE)
  );
  fastify.post("/api/dev/harness/emergency", async (request, reply) => {
    const body = request.body ?? {};
    const incidentType = body.incidentType ?? "CARDIAC_ARREST";
    const emergency = await module11.emergencies.create({
      incidentType,
      severity: "CRITICAL",
      latitude: 12.9716,
      longitude: 77.5946,
      description: "Development harness session.",
      callerId: "dev-harness",
      isSimulation: true
    });
    return reply.send({ emergency });
  });
}

// apps/server/src/http/auth.ts
import bcrypt from "bcryptjs";
var AuthService = class {
  constructor(users, sign, verify, secret, expiresIn, allowDevelopmentToken = false) {
    this.users = users;
    this.sign = sign;
    this.verify = verify;
    this.allowDevelopmentToken = allowDevelopmentToken;
    this.secret = secret;
    this.expiresIn = expiresIn;
  }
  secret;
  expiresIn;
  /** True only when NODE_ENV=development; gates the dev-token route. */
  developmentTokenEnabled() {
    return this.allowDevelopmentToken;
  }
  async login(email, password) {
    const record = await this.users.findByEmail(email);
    const hash = record?.passwordHash ?? "$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv";
    const valid = await bcrypt.compare(password, hash);
    if (!record || !valid || !record.isActive) {
      throw new AppError(ErrorCode.UNAUTHORIZED, "Invalid email or password.", 401);
    }
    return this.issue(record);
  }
  /**
   * Development-only credential bootstrap.
   *
   * A fresh checkout has no users and no seed yet, so there would otherwise be
   * no way to reach any authenticated endpoint. This mints a local operator
   * token on request, without persisting an account. It is refused outright
   * unless NODE_ENV is development, so it can never be reachable in production.
   */
  async developmentToken(email) {
    if (!this.allowDevelopmentToken) {
      throw new AppError(
        ErrorCode.FORBIDDEN,
        "Development tokens are only available when NODE_ENV=development.",
        403
      );
    }
    const existing = await this.users.findByEmail(email);
    if (existing?.isActive) {
      return this.issue({
        id: existing.id,
        email: existing.email,
        role: existing.role,
        displayName: existing.displayName ?? void 0
      });
    }
    return this.issue({
      id: `USR_DEV_${email.toLowerCase().replace(/[^a-z0-9]/g, "_")}`,
      email: email.toLowerCase(),
      role: "ADMIN",
      displayName: "Development Operator"
    });
  }
  async issue(record) {
    const token = await this.sign(
      { sub: record.id, email: record.email, role: record.role, name: record.displayName },
      this.secret,
      this.expiresIn
    );
    return { token, user: { userId: record.id, email: record.email, role: record.role } };
  }
  /** Resolves the bearer token on a request, or null when absent/invalid. */
  async authenticate(request) {
    const header = request.headers.authorization;
    if (!header || !header.toLowerCase().startsWith("bearer ")) return null;
    try {
      const claims = await this.verify(header.slice(7).trim(), this.secret);
      const userId = String(claims.sub ?? "");
      if (!userId) return null;
      return { userId, role: String(claims.role ?? "OPERATOR"), email: String(claims.email ?? "") };
    } catch {
      return null;
    }
  }
};
function registerAuthRoutes(fastify, auth) {
  fastify.post("/api/auth/login", async (request, reply) => {
    const body = request.body ?? {};
    if (!body.email || !body.password) {
      return reply.status(422).send({
        error: { code: "VALIDATION_ERROR", message: "email and password are required." }
      });
    }
    return reply.send(await auth.login(body.email, body.password));
  });
  fastify.get("/api/auth/me", async (request, reply) => {
    const user = await auth.authenticate(request);
    if (!user) {
      return reply.status(401).send({ error: { code: "UNAUTHORIZED", message: "No valid token." } });
    }
    return reply.send(user);
  });
  if (auth.developmentTokenEnabled()) {
    fastify.post("/api/auth/dev-token", async (request, reply) => {
      const body = request.body ?? {};
      const email = body.email ?? "operator@resus.local";
      return reply.send(await auth.developmentToken(email));
    });
  }
}

// apps/server/src/http/routeAdapter.ts
function zodValidatorCompiler(opts) {
  const schema = opts.schema;
  if (!schema || typeof schema.safeParse !== "function") {
    return (data) => ({ value: data });
  }
  return (data) => {
    const result = schema.safeParse(data);
    if (result.success) return { value: result.data };
    return {
      error: AppError.validation("The request did not match the expected shape.", {
        issues: result.error.issues
      })
    };
  };
}
function registerRoutes(fastify, routes, options) {
  const modules = /* @__PURE__ */ new Set();
  fastify.setValidatorCompiler?.(zodValidatorCompiler);
  for (const route of routes) {
    modules.add(route.module);
    const schema = {};
    if (route.params) schema.params = route.params;
    if (route.query) schema.querystring = route.query;
    if (route.body) schema.body = route.body;
    fastify.route({
      method: route.method,
      url: route.url,
      ...Object.keys(schema).length > 0 ? { schema } : {},
      handler: buildHandler(route, options)
    });
  }
  return { count: routes.length, modules: [...modules].sort() };
}
function buildHandler(route, options) {
  const isPublic = route.auth?.public === true;
  const allowedRoles = route.auth?.roles ?? [];
  return async (raw, reply) => {
    try {
      const user = isPublic ? null : await options.authenticate(toHttpRequest(raw));
      if (!isPublic && !user) {
        return reply.status(401).send({
          error: { code: "UNAUTHORIZED", message: "Authentication is required for this endpoint." }
        });
      }
      if (user && allowedRoles.length > 0 && !allowedRoles.includes(user.role)) {
        return reply.status(403).send({
          error: {
            code: "FORBIDDEN",
            message: `Role '${user.role}' may not call this endpoint.`,
            allowedRoles
          }
        });
      }
      const httpReply = toHttpReply(reply);
      await route.handler(
        { ...toHttpRequest(raw), user: user ?? void 0 },
        httpReply
      );
    } catch (error) {
      if (isAppError(error)) {
        return reply.status(error.statusCode).send({
          error: { code: error.code, message: error.message, details: error.details ?? null }
        });
      }
      const message = error instanceof Error ? error.message : String(error);
      (raw.log ?? console).error?.({ err: error }, `unhandled error on ${route.method} ${route.url}`);
      return reply.status(500).send({
        error: { code: "INTERNAL_ERROR", message: "Unexpected server error.", details: { message } }
      });
    }
  };
}
function toHttpRequest(raw) {
  return {
    params: raw.params ?? {},
    query: raw.query ?? {},
    body: raw.body,
    headers: raw.headers ?? {},
    server: { now: () => /* @__PURE__ */ new Date() }
  };
}
function toHttpReply(reply) {
  return {
    status(code) {
      reply.status(code);
      return this;
    },
    header(name, value) {
      reply.header(name, value);
      return this;
    },
    send(payload) {
      reply.send(payload);
    }
  };
}

// apps/server/src/realtime/hub.ts
var RealtimeHub = class {
  clients = /* @__PURE__ */ new Map();
  logger;
  counter = 0;
  heartbeat = null;
  constructor(options = {}) {
    this.logger = options.logger ?? createConsoleLogger("info", "server.realtime");
    const interval = options.heartbeatMs ?? 25e3;
    if (interval > 0) {
      this.heartbeat = setInterval(() => this.sendHeartbeat(), interval);
      this.heartbeat.unref();
    }
  }
  /**
   * Registers a socket. `requested` limits what the client will receive; a client
   * that asks for nothing is subscribed to every channel, which is the default
   * for the dashboard.
   */
  attach(socket, requested) {
    this.counter += 1;
    const clientId = `ws-${Date.now().toString(36)}-${this.counter}`;
    const channels = normaliseChannels(requested);
    this.clients.set(clientId, { id: clientId, socket, channels: new Set(channels) });
    this.logger.info({ clientId, channels: channels.length }, "realtime client attached");
    this.send(clientId, {
      kind: "snapshot",
      channel: "system",
      payload: { clientId, channels, attachedAt: (/* @__PURE__ */ new Date()).toISOString() },
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    });
    return { clientId, channels };
  }
  detach(clientId) {
    this.clients.delete(clientId);
    this.logger.info({ clientId, remaining: this.clients.size }, "realtime client detached");
  }
  /** Narrows an attached client's channel set, acknowledging a subscribe frame. */
  resubscribe(clientId, requested) {
    const client = this.clients.get(clientId);
    if (!client) return [];
    const channels = normaliseChannels(requested);
    client.channels = new Set(channels);
    return channels;
  }
  /** `RealtimePublisherPort`. Called by Module 11 after a transaction commits. */
  publish(channel, message) {
    const frame = JSON.stringify({ ...message, channel });
    for (const client of this.clients.values()) {
      if (!client.channels.has(channel)) continue;
      try {
        client.socket.send(frame);
      } catch (error) {
        this.logger.warn(
          { clientId: client.id, error: String(error) },
          "failed to write to client; detaching"
        );
        this.detach(client.id);
      }
    }
  }
  subscriberCount(channel) {
    let count = 0;
    for (const client of this.clients.values()) {
      if (client.channels.has(channel)) count += 1;
    }
    return count;
  }
  get clientCount() {
    return this.clients.size;
  }
  send(clientId, message) {
    const client = this.clients.get(clientId);
    if (!client) return;
    try {
      client.socket.send(JSON.stringify(message));
    } catch {
      this.detach(clientId);
    }
  }
  sendHeartbeat() {
    if (this.clients.size === 0) return;
    this.publish("system", {
      kind: "heartbeat",
      channel: "system",
      payload: { clients: this.clients.size },
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    });
  }
  dispose() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const client of this.clients.values()) {
      try {
        client.socket.close(1001, "server shutting down");
      } catch {
      }
    }
    this.clients.clear();
  }
};
function normaliseChannels(requested) {
  if (!requested || requested.length === 0) return [...REALTIME_CHANNELS];
  const valid = new Set(REALTIME_CHANNELS);
  const filtered = requested.filter((c) => valid.has(c));
  return filtered.length > 0 ? filtered : [...REALTIME_CHANNELS];
}

// apps/server/src/asterisk/conversationController.ts
var DEFAULT_INCIDENT_TYPE = "OTHER";
var TERMINAL_STATUSES3 = /* @__PURE__ */ new Set(["ESCALATED", "COMPLETED", "CANCELLED"]);
var AsteriskConversationController = class {
  constructor(deps) {
    this.deps = deps;
    this.logger = deps.logger ?? noopLogger;
    this.defaultIncidentType = deps.defaultIncidentType ?? DEFAULT_INCIDENT_TYPE;
  }
  logger;
  defaultIncidentType;
  byCall = /* @__PURE__ */ new Map();
  /** Called once the media bridge has bound a live call to a `CallSession`. */
  async onCallConnected(input) {
    if (this.byCall.has(input.callSessionId)) {
      this.logger.warn(
        { callSessionId: input.callSessionId },
        "ignoring a second connect for a call that already has a protocol session"
      );
      return null;
    }
    const incidentType = await this.resolveIncidentType(input.emergencyId);
    let turn;
    try {
      turn = await this.deps.sessions.start({
        emergencyId: input.emergencyId,
        incidentType,
        startedBy: "SYSTEM"
      });
    } catch (error) {
      this.logger.error(
        {
          callSessionId: input.callSessionId,
          emergencyId: input.emergencyId,
          incidentType,
          reason: error.message
        },
        "could not start a protocol session for the live call; using the configured greeting"
      );
      return null;
    }
    const terminal = TERMINAL_STATUSES3.has(turn.status);
    this.byCall.set(input.callSessionId, { sessionId: turn.session.id, terminal });
    this.logger.info(
      {
        callSessionId: input.callSessionId,
        emergencyId: input.emergencyId,
        protocolSessionId: turn.session.id,
        incidentType,
        status: turn.status,
        terminal
      },
      "started a protocol session for the live call"
    );
    const speech = this.resolveSpeech(turn, input.language);
    await this.persistSystemTranscript(input.callSessionId, input.emergencyId, speech);
    return this.toTurn(turn, terminal, speech);
  }
  /** Called for each final, stored caller utterance. */
  async onCallerUtterance(input) {
    const state = this.byCall.get(input.callSessionId);
    if (!state) return null;
    if (state.terminal) return null;
    let turn;
    try {
      turn = await this.deps.sessions.handleUtterance({
        sessionId: state.sessionId,
        utterance: input.text
      });
    } catch (error) {
      this.logger.warn(
        {
          callSessionId: input.callSessionId,
          emergencyId: input.emergencyId,
          sessionId: state.sessionId,
          reason: error.message
        },
        "could not advance the protocol session; the caller will not be prompted again"
      );
      state.terminal = true;
      return null;
    }
    const terminal = TERMINAL_STATUSES3.has(turn.status);
    if (terminal) state.terminal = true;
    const speech = this.resolveSpeech(turn, input.language);
    await this.persistSystemTranscript(input.callSessionId, input.emergencyId, speech);
    return this.toTurn(turn, terminal, speech);
  }
  /** Releases per-call bookkeeping when the stream ends. */
  forget(callSessionId) {
    this.byCall.delete(callSessionId);
  }
  toTurn(turn, terminal, speech) {
    return {
      speech,
      tone: turn.tone,
      // Module 5 sets `paraphrased` from its safety gate; anything else is the
      // catalogue's own wording and may be recorded as such.
      verbatimProtocolText: !turn.paraphrased,
      terminal,
      // The stable question identifier lets the conversation-support layer name
      // the question in a timeout event without interpreting any clinical content.
      questionId: turn.decision?.requiredQuestion?.questionId ?? null
    };
  }
  /**
   * Renders the protocol's reviewed wording into the call's language.
   *
   * Module 5 decides *what* is said and issues stable identifiers for it; this
   * method only looks those identifiers up in the reviewed translation table. When
   * there is no translation, or the text is an approved paraphrase with no key, the
   * protocol wording is spoken unchanged and the fallback is logged — never
   * machine-translated and never invented.
   */
  resolveSpeech(turn, language) {
    const localizer = this.deps.localizer;
    if (!localizer) return turn.speech;
    const instructionId = turn.decision?.instruction?.instructionId ?? null;
    const questionId = turn.decision?.requiredQuestion?.questionId ?? null;
    const result = localizer.localise({
      language,
      instructionId,
      instruction: turn.instruction ?? turn.decision?.instruction?.text ?? null,
      questionId,
      question: turn.question ?? turn.decision?.requiredQuestion?.text ?? null,
      fallbackSpeech: turn.speech,
      paraphrased: turn.paraphrased
    });
    if (result.localised) {
      if (result.reason === "PARTIALLY_LOCALISED") {
        this.logger.warn(
          { instructionId, questionId, language },
          "only part of the protocol turn had a reviewed translation; the rest is spoken in the protocol language"
        );
      } else {
        this.logger.debug(
          { instructionId, questionId, language },
          "rendered the protocol turn in the call language"
        );
      }
    } else if (result.reason === "NO_TRANSLATION") {
      this.logger.debug(
        { instructionId, questionId, language },
        "no reviewed translation for this protocol turn; speaking the protocol wording unchanged"
      );
    }
    return result.speech;
  }
  async resolveIncidentType(emergencyId) {
    try {
      const emergency = await this.deps.emergencies.findById(emergencyId);
      const incidentType = emergency?.incidentType?.trim();
      return incidentType && incidentType !== "" ? incidentType : this.defaultIncidentType;
    } catch (error) {
      this.logger.warn(
        { emergencyId, reason: error.message },
        "could not read the emergency incident type; using the default"
      );
      return this.defaultIncidentType;
    }
  }
  /**
   * Persists what the system said, best-effort.
   *
   * The words are already chosen and about to be spoken, so a write failure must
   * not swallow the prompt. The failure is logged so the resulting gap in the
   * timeline can be explained.
   */
  async persistSystemTranscript(callSessionId, emergencyId, speech) {
    if (speech.trim() === "") return;
    try {
      await this.deps.transcripts.appendTranscript({
        callSessionId,
        emergencyId,
        speaker: "SYSTEM",
        text: speech,
        isFinal: true
      });
    } catch (error) {
      this.logger.error(
        { callSessionId, emergencyId, reason: error.message },
        "could not persist the SYSTEM transcript for a protocol instruction"
      );
    }
  }
};

// apps/server/src/conversation/localizer.ts
import { readFileSync as readFileSync2 } from "node:fs";
function sanitise(catalogue) {
  const clean = {};
  for (const [key, byLanguage] of Object.entries(catalogue)) {
    if (!key || typeof byLanguage !== "object" || byLanguage === null) continue;
    const languages = {};
    for (const [language, text] of Object.entries(byLanguage)) {
      if (typeof text === "string" && text.trim() !== "") languages[language] = text;
    }
    if (Object.keys(languages).length > 0) clean[key] = languages;
  }
  return clean;
}
function isCatalogue(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function fallback(request, reason) {
  return { speech: request.fallbackSpeech, localised: false, reason };
}
var InstructionLocalizer = class _InstructionLocalizer {
  constructor(catalogue, enabled) {
    this.catalogue = catalogue;
    this.enabled = enabled;
  }
  /** A localiser that never translates; the original protocol wording is spoken. */
  static disabled() {
    return new _InstructionLocalizer({}, false);
  }
  /** Builds a localiser from an already-parsed catalogue (used by tests). */
  static fromObject(catalogue) {
    return new _InstructionLocalizer(sanitise(catalogue), true);
  }
  /**
   * Loads a reviewed catalogue from a JSON file.
   *
   * A missing or malformed file disables localisation rather than throwing: the
   * live call must keep working, and the caller hearing the reviewed protocol
   * wording is always safe. The reason is logged so the misconfiguration is
   * noticed.
   */
  static fromFile(path3, logger2) {
    if (path3.trim() === "") return _InstructionLocalizer.disabled();
    try {
      const parsed = JSON.parse(readFileSync2(path3, "utf8"));
      if (!isCatalogue(parsed)) {
        logger2?.warn(
          { path: path3 },
          "the translation catalogue is not an instructionId -> language map; localisation is disabled"
        );
        return _InstructionLocalizer.disabled();
      }
      return new _InstructionLocalizer(sanitise(parsed), true);
    } catch (error) {
      logger2?.warn(
        { path: path3, reason: error.message },
        "could not load the translation catalogue; localisation is disabled"
      );
      return _InstructionLocalizer.disabled();
    }
  }
  localise(request) {
    if (!this.enabled) return fallback(request, "DISABLED");
    if (request.paraphrased) return fallback(request, "PARAPHRASED");
    if (!request.instructionId && !request.questionId) return fallback(request, "NO_KEY");
    const parts = [];
    let considered = 0;
    let translated = 0;
    if (request.instruction) {
      considered += 1;
      const text = this.lookup(request.instructionId, request.language);
      if (text) {
        parts.push(text);
        translated += 1;
      } else {
        parts.push(request.instruction);
      }
    }
    if (request.question) {
      considered += 1;
      const text = this.lookup(request.questionId, request.language);
      if (text) {
        parts.push(text);
        translated += 1;
      } else {
        parts.push(request.question);
      }
    }
    if (considered === 0 || translated === 0) return fallback(request, "NO_TRANSLATION");
    return {
      speech: parts.join(" "),
      localised: true,
      reason: translated === considered ? "LOCALISED" : "PARTIALLY_LOCALISED"
    };
  }
  lookup(id, language) {
    if (!id || !language) return null;
    const entry = this.catalogue[id];
    if (!entry) return null;
    return entry[language] ?? null;
  }
};

// apps/server/src/conversation/timeoutPolicy.ts
var SilenceRetryPolicy = class {
  constructor(retryLimit) {
    this.retryLimit = retryLimit;
    if (!Number.isInteger(retryLimit) || retryLimit < 0) {
      throw new Error("SilenceRetryPolicy retryLimit must be a non-negative integer.");
    }
  }
  attempts = /* @__PURE__ */ new Map();
  /** How many repeats are allowed before the conversation is escalated. */
  get repeatsAllowed() {
    return this.retryLimit;
  }
  /**
   * Records one silent window and returns what to do about it.
   *
   * The first `retryLimit` silences produce a re-prompt; the next one escalates.
   * With `retryLimit = 0` the very first silence escalates, so the feature can be
   * configured to give up immediately.
   */
  registerSilence(callSessionId) {
    const attempt = (this.attempts.get(callSessionId) ?? 0) + 1;
    this.attempts.set(callSessionId, attempt);
    if (attempt <= this.retryLimit) return { action: "REPROMPT", attempt };
    return { action: "ESCALATE", attempt };
  }
  /** Clears the budget because the caller answered: the next silence starts over. */
  reset(callSessionId) {
    this.attempts.delete(callSessionId);
  }
  /** Drops all state for a call that has ended. */
  clear(callSessionId) {
    this.attempts.delete(callSessionId);
  }
  /** Current silent-window count for a call; 0 when the caller is answering. */
  attemptFor(callSessionId) {
    return this.attempts.get(callSessionId) ?? 0;
  }
};

// apps/server/src/conversation/conversationSupport.ts
var ConversationSupportAdapter = class {
  constructor(deps) {
    this.deps = deps;
    this.logger = deps.logger ?? noopLogger;
    this.policy = new SilenceRetryPolicy(deps.config.silenceRetryLimit);
  }
  logger;
  policy;
  byCall = /* @__PURE__ */ new Map();
  async onCallConnected(input) {
    const turn = await this.deps.inner.onCallConnected(input);
    this.remember(input, turn);
    return turn;
  }
  async onCallerUtterance(input) {
    const turn = await this.deps.inner.onCallerUtterance(input);
    this.remember(input, turn);
    return turn;
  }
  /**
   * The caller has been silent since the last prompt.
   *
   * Returns the last authoritative turn again so the caller hears the same
   * reviewed instruction, or `null` once the budget is spent (the operator is
   * notified by the event instead of the caller being prompted forever).
   */
  async onCallerSilence(input) {
    const state = this.byCall.get(input.callSessionId);
    if (!state || state.escalated || state.terminal || !state.lastTurn) return null;
    if (state.lastTurn.speech.trim() === "") return null;
    const decision = this.policy.registerSilence(input.callSessionId);
    if (decision.action === "REPROMPT") {
      await this.publish(input.emergencyId, "CONVERSATION_TIMED_OUT", {
        emergencyId: input.emergencyId,
        questionId: state.questionId,
        waitedMs: this.deps.config.silenceTimeoutMs,
        nextAction: "REPROMPT"
      });
      this.logger.info(
        { callSessionId: input.callSessionId, attempt: decision.attempt },
        "caller was silent; repeating the current protocol instruction"
      );
      return { ...state.lastTurn, terminal: false };
    }
    await this.publish(input.emergencyId, "CONVERSATION_TIMED_OUT", {
      emergencyId: input.emergencyId,
      questionId: state.questionId,
      waitedMs: this.deps.config.silenceTimeoutMs,
      nextAction: "ESCALATE"
    });
    await this.publish(input.emergencyId, "CONVERSATION_ESCALATED", {
      emergencyId: input.emergencyId,
      reason: `The caller was silent through ${decision.attempt} prompts; the conversation needs an operator.`,
      trigger: "RETRY_LIMIT"
    });
    state.terminal = true;
    state.escalated = true;
    this.logger.warn(
      { callSessionId: input.callSessionId, attempt: decision.attempt },
      "caller remained silent through every retry; the conversation is no longer prompting"
    );
    return null;
  }
  forget(callSessionId) {
    this.byCall.delete(callSessionId);
    this.policy.clear(callSessionId);
    this.deps.inner.forget?.(callSessionId);
  }
  /** Remembers the authoritative turn and restarts the silence budget. */
  remember(input, turn) {
    if (!turn) return;
    const existing = this.byCall.get(input.callSessionId);
    const escalated = existing?.escalated ?? false;
    this.byCall.set(input.callSessionId, {
      emergencyId: input.emergencyId,
      language: input.language,
      lastTurn: turn,
      questionId: turn.questionId ?? null,
      terminal: turn.terminal || escalated,
      escalated
    });
    if (!escalated) this.policy.reset(input.callSessionId);
  }
  /**
   * Records a conversation-layer event, never letting a logging failure break the
   * call. These events mark the timeline; the caller's audio path must not depend
   * on them.
   */
  async publish(emergencyId, type, payload) {
    if (!this.deps.events) return;
    try {
      const event = { type, emergencyId, payload };
      await this.deps.events.record(event, { emergencyId });
    } catch (error) {
      this.logger.warn(
        { type, emergencyId, reason: error.message },
        "could not record a conversation-support event"
      );
    }
  }
};

// apps/server/src/conversation/protocolTurnOrchestrator.ts
var ProtocolTurnOrchestratorImpl = class {
  constructor(deps) {
    this.deps = deps;
    this.logger = deps.logger ?? noopLogger;
  }
  logger;
  async orchestrateTurn(input) {
    const bound = await this.resolveCall(input.sessionId);
    if (bound) {
      await this.appendTranscript(bound, "CALLER", input.utterance);
    }
    const turn = await input.decide();
    if (bound) {
      if (turn.speech.trim() !== "") {
        await this.appendTranscript(bound, "SYSTEM", turn.speech);
        await this.synthesise(bound, turn);
      }
    }
    return turn;
  }
  /**
   * Finds the protocol session's emergency and the live call bound to it.
   *
   * Returns null when either lookup fails or the call is not ACTIVE, so the
   * turn still runs without transcript or TTS — the decision is never held
   * hostage to a missing call row.
   */
  async resolveCall(sessionId) {
    let emergencyId;
    try {
      const found = await this.deps.sessions.get(sessionId);
      emergencyId = found.session.emergencyId;
    } catch (error) {
      this.logger.warn(
        { sessionId, reason: error.message },
        "could not resolve the protocol session; running the turn without transcript or TTS"
      );
      return null;
    }
    try {
      const call = await this.deps.calls.requireSessionFor(emergencyId);
      if (call.status !== "ACTIVE") {
        this.logger.debug(
          { emergencyId, callSessionId: call.id, status: call.status },
          "no live call bound to this emergency; running the turn without transcript or TTS"
        );
        return null;
      }
      return { callSessionId: call.id, emergencyId, language: call.language };
    } catch (error) {
      this.logger.debug(
        { emergencyId, reason: error.message },
        "no call session for this emergency; running the turn without transcript or TTS"
      );
      return null;
    }
  }
  /** Appends one transcript row, best-effort. */
  async appendTranscript(bound, speaker, text) {
    try {
      await this.deps.calls.appendTranscript({
        callSessionId: bound.callSessionId,
        emergencyId: bound.emergencyId,
        speaker,
        text,
        isFinal: true
      });
    } catch (error) {
      this.logger.error(
        { callSessionId: bound.callSessionId, speaker, reason: error.message },
        "could not persist a transcript row for an HTTP-driven protocol turn"
      );
    }
  }
  /** Synthesises the spoken reply, best-effort. */
  async synthesise(bound, turn) {
    try {
      await this.deps.speech.speak({
        text: turn.speech,
        language: bound.language,
        tone: turn.tone,
        // Module 5 sets `paraphrased` from its safety gate; only the
        // catalogue's own wording may be recorded as clinically-reviewed speech.
        verbatimProtocolText: !turn.paraphrased,
        emergencyId: bound.emergencyId,
        callSessionId: bound.callSessionId
      });
    } catch (error) {
      this.logger.warn(
        { callSessionId: bound.callSessionId, reason: error.message },
        "could not synthesise the protocol reply for an HTTP-driven turn"
      );
    }
  }
};

// apps/server/src/nlp/module3Classifier.ts
import { z as z17 } from "zod";
var severitySchema = z17.object({
  level: z17.string(),
  numeric_score: z17.number(),
  rationale: z17.string().optional(),
  key_risk_factors: z17.array(z17.string()).optional(),
  cpr_required: z17.boolean().optional(),
  aed_required: z17.boolean().optional()
});
var locationSchema = z17.object({
  raw_text: z17.string().nullish(),
  landmark: z17.string().nullish(),
  street_address: z17.string().nullish(),
  area_district: z17.string().nullish(),
  city: z17.string().nullish(),
  pin_code: z17.string().nullish(),
  gps_hint: z17.string().nullish(),
  confidence: z17.number().optional()
}).partial();
var patientSchema = z17.object({
  age: z17.number().nullish(),
  gender: z17.string().nullish(),
  count: z17.number().optional(),
  consciousness: z17.string().optional(),
  breathing: z17.string().optional(),
  pulse_present: z17.boolean().nullish(),
  chief_complaint: z17.string().nullish(),
  secondary_symptoms: z17.array(z17.string()).optional(),
  known_conditions: z17.array(z17.string()).optional(),
  mobility: z17.string().nullish()
}).partial();
var missingFieldsSchema = z17.record(z17.string(), z17.unknown()).optional();
var multilingualSchema = z17.record(z17.string(), z17.unknown()).optional();
var module3ResponseSchema = z17.object({
  session_id: z17.string().optional(),
  extraction_id: z17.string().optional(),
  extracted_at: z17.string().optional(),
  incident_category: z17.string(),
  incident_subcategory: z17.string().nullish(),
  caller_intent: z17.string().optional(),
  severity: severitySchema,
  location: locationSchema.optional(),
  patient: patientSchema.optional(),
  bystanders_present: z17.boolean().nullish(),
  hazards: z17.array(z17.string()).optional(),
  missing_fields: missingFieldsSchema,
  multilingual: multilingualSchema,
  extraction_confidence: z17.number().min(0).max(1),
  validation_warnings: z17.array(z17.string()).optional()
});
var DEFAULT_TIMEOUT_MS = 8e3;
var FALLBACK_MARKER = "FALLBACK TRIGGERED";
var Module3Classifier = class {
  providerName;
  model;
  baseUrl;
  timeoutMs;
  fetchImpl;
  logger;
  constructor(options) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.providerName = options.providerName ?? "module3-emergency-nlp";
    this.model = options.model ?? "claude-sonnet-4-6";
    this.logger = options.logger ?? noopLogger;
    if (typeof this.fetchImpl !== "function") {
      throw new Error("Module3Classifier requires a fetch implementation.");
    }
  }
  /** Invokes Module 3's `/extract`. Never throws for an expected failure. */
  async classify(input) {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}/extract`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            session_id: input.sessionId,
            transcript_text: input.transcriptText,
            detected_language: input.language ?? "unknown",
            is_final_chunk: input.isFinalChunk ?? true,
            cumulative_transcript: input.cumulativeTranscript
          }),
          signal: controller.signal
        });
      } catch (error) {
        if (controller.signal.aborted || error?.name === "AbortError") {
          return this.timeoutFailure();
        }
        return {
          ok: false,
          kind: "UNAVAILABLE",
          reason: `Module 3 is unreachable: ${error instanceof Error ? error.message : String(error)}`
        };
      }
      if (!response.ok) {
        const excerpt = await this.readExcerpt(response);
        if (controller.signal.aborted) return this.timeoutFailure();
        this.logger.warn(
          { status: response.status, emergencyId: input.emergencyId },
          "Module 3 returned a non-success status"
        );
        return {
          ok: false,
          kind: "HTTP_ERROR",
          status: response.status,
          reason: `Module 3 returned HTTP ${response.status}.`,
          details: excerpt ? { rawExcerpt: excerpt } : void 0
        };
      }
      let body;
      try {
        body = await response.json();
      } catch (error) {
        if (controller.signal.aborted || error?.name === "AbortError") {
          return this.timeoutFailure();
        }
        return { ok: false, kind: "MALFORMED", reason: "Module 3 response was not valid JSON." };
      }
      const parsed = module3ResponseSchema.safeParse(body);
      if (!parsed.success) {
        this.logger.warn(
          { emergencyId: input.emergencyId, issues: parsed.error.issues.length },
          "Module 3 response did not match the extraction schema"
        );
        return {
          ok: false,
          kind: "MALFORMED",
          reason: "Module 3 response did not match the extraction schema.",
          details: parsed.error.issues
        };
      }
      const data = parsed.data;
      const warnings = data.validation_warnings ?? [];
      const degraded = warnings.some((warning) => warning.includes(FALLBACK_MARKER));
      return {
        ok: true,
        extraction: {
          emergencyId: input.emergencyId,
          sessionId: data.session_id ?? input.sessionId,
          provider: this.providerName,
          model: this.model,
          category: data.incident_category,
          severityLevel: data.severity.level,
          severityScore: data.severity.numeric_score,
          confidence: data.extraction_confidence,
          cprRequired: data.severity.cpr_required ?? false,
          degraded,
          latencyMs: Date.now() - startedAt,
          extractedAt: data.extracted_at ?? (/* @__PURE__ */ new Date()).toISOString(),
          warnings
        }
      };
    } finally {
      clearTimeout(timer);
    }
  }
  timeoutFailure() {
    return {
      ok: false,
      kind: "TIMEOUT",
      reason: `Module 3 did not respond within ${this.timeoutMs}ms.`
    };
  }
  async readExcerpt(response) {
    try {
      const text = await response.text();
      return text.slice(0, 500) || null;
    } catch {
      return null;
    }
  }
};

// apps/server/src/nlp/classifyRoutes.ts
import { z as z18 } from "zod";
var classifyBodySchema = z18.object({
  /** Overrides the stored transcript. Bounded to Module 3's own input limit. */
  transcriptText: z18.string().min(1).max(4096).optional(),
  language: z18.string().min(1).max(16).optional(),
  isFinalChunk: z18.boolean().optional(),
  /** Correlation id; defaults to the emergency's call session. */
  sessionId: z18.string().min(1).max(128).optional()
});
function failureToError(failure) {
  switch (failure.kind) {
    case "TIMEOUT":
      return new AppError(ErrorCode.LLM_TIMEOUT, failure.reason, 504);
    case "MALFORMED":
      return new AppError(ErrorCode.LLM_MALFORMED_RESPONSE, failure.reason, 502);
    case "HTTP_ERROR":
      return new AppError(ErrorCode.LLM_UNAVAILABLE, failure.reason, 502, failure.details);
    case "UNAVAILABLE":
    default:
      return new AppError(ErrorCode.LLM_UNAVAILABLE, failure.reason, 503);
  }
}
var EmergencyClassificationService = class {
  constructor(deps) {
    this.deps = deps;
    this.logger = deps.logger ?? noopLogger;
  }
  logger;
  async classify(emergencyId, body, user) {
    if (!this.deps.enabled) {
      throw new AppError(
        ErrorCode.PROVIDER_NOT_CONFIGURED,
        "Module 3 NLP integration is disabled. Set MODULE3_NLP_ENABLED=true to enable it.",
        503
      );
    }
    if (body.isFinalChunk === false) {
      throw AppError.validation("Module 3 extraction requires a final transcript.");
    }
    const emergency = await this.deps.emergencies.findById(emergencyId);
    if (!emergency) throw AppError.notFound("Emergency", emergencyId);
    const sessionId = body.sessionId ?? await this.resolveSessionId(emergencyId);
    const transcriptText2 = await this.resolveTranscriptText(emergencyId, body);
    const outcome = await this.deps.classifier.classify({
      emergencyId,
      sessionId,
      transcriptText: transcriptText2,
      language: body.language,
      isFinalChunk: body.isFinalChunk
    });
    if (!outcome.ok) {
      await this.recordRejected(emergencyId, outcome.reason, user);
      throw failureToError(outcome);
    }
    await this.deps.events.record(
      defineEvent("NLP_EXTRACTION_COMPLETED", {
        emergencyId,
        entityType: "emergency",
        entityId: emergencyId,
        actorType: user ? "OPERATOR" : "SYSTEM",
        actorId: user?.userId ?? null,
        payload: {
          emergencyId,
          provider: outcome.extraction.provider,
          model: outcome.extraction.model,
          incidentType: outcome.extraction.category,
          severity: outcome.extraction.severityLevel,
          confidence: outcome.extraction.confidence,
          latencyMs: outcome.extraction.latencyMs,
          degraded: outcome.extraction.degraded
        }
      }),
      { emergencyId }
    ).catch((error) => {
      this.logger.error(
        { emergencyId, reason: error.message },
        "could not record NLP_EXTRACTION_COMPLETED"
      );
    });
    return outcome.extraction;
  }
  async resolveSessionId(emergencyId) {
    try {
      const session = await this.deps.calls.requireSessionFor(emergencyId);
      return session.id;
    } catch {
      this.logger.debug({ emergencyId }, "no call session for emergency; using emergency id");
      return emergencyId;
    }
  }
  async resolveTranscriptText(emergencyId, body) {
    const provided = body.transcriptText?.trim();
    if (provided) return provided;
    const transcripts = await this.deps.calls.transcriptsFor(emergencyId);
    const finals = transcripts.filter((entry) => entry.isFinal && entry.text.trim().length > 0).sort((a, b) => a.sequence - b.sequence);
    const latest = finals.at(-1)?.text.trim();
    if (!latest) {
      throw AppError.validation(
        "No transcript text is available for this emergency. Provide transcriptText or record a final transcript first."
      );
    }
    return latest;
  }
  async recordRejected(emergencyId, reason, user) {
    await this.deps.events.record(
      defineEvent("NLP_EXTRACTION_REJECTED", {
        emergencyId,
        entityType: "emergency",
        entityId: emergencyId,
        actorType: user ? "OPERATOR" : "SYSTEM",
        actorId: user?.userId ?? null,
        payload: {
          emergencyId,
          provider: this.deps.classifier.providerName,
          reason
        }
      }),
      { emergencyId }
    ).catch((error) => {
      this.logger.error(
        { emergencyId, reason: error.message },
        "could not record NLP_EXTRACTION_REJECTED"
      );
    });
  }
};
function createNlpClassifyRoutes(service) {
  return [
    {
      method: "POST",
      url: "/api/emergencies/:id/classify",
      module: "module_03",
      summary: "Extract candidate facts from a final transcript (no normalized classification, status change, protocol action or dispatch).",
      auth: { roles: ["OPERATOR", "DISPATCHER", "CLINICAL_SUPERVISOR", "ADMIN"] },
      body: classifyBodySchema,
      handler: async (request, reply) => {
        const id = String(request.params.id ?? "");
        const body = classifyBodySchema.parse(request.body ?? {});
        const extraction = await service.classify(id, body, request.user);
        reply.send({ emergencyId: id, extraction });
      }
    }
  ];
}

// apps/server/src/app.ts
async function buildServer(config = loadServerConfig(), dependencies = {}) {
  const logger2 = dependencies.logger ?? createConsoleLogger(config.logLevel, "server");
  const fastify = Fastify({ logger: false });
  await fastify.register(cors, {
    origin: config.corsOrigins === "*" ? true : config.corsOrigins,
    credentials: true
  });
  fastify.setErrorHandler((error, request, reply) => {
    if (isAppError(error)) {
      return reply.status(error.statusCode).send({ error: { code: error.code, message: error.message, details: error.details ?? null } });
    }
    request.log.error({ err: error }, "unhandled error");
    return reply.status(500).send({ error: { code: "INTERNAL_ERROR", message: "Unexpected server error." } });
  });
  const realtime = new RealtimeHub({ logger: logger2 });
  const module11 = createModule11({
    db: dependencies.db ?? getPrismaClient(),
    nodeEnv: config.nodeEnv,
    logger: logger2,
    realtime,
    ownsClient: dependencies.ownsDatabaseClient
  });
  const module10LifecycleObserver = new Module10LifecycleObserver({
    bus: module11.bus,
    events: module11.eventQuery,
    logger: logger2
  });
  fastify.addHook("onClose", async () => module10LifecycleObserver.dispose());
  try {
    await module10LifecycleObserver.start();
  } catch (error) {
    await fastify.close();
    realtime.dispose();
    await module11.dispose();
    throw error;
  }
  const module2 = new Module2({
    calls: module11.calls,
    events: module11.eventPublisher,
    logger: logger2
  });
  const module5 = new Module5({
    sessions: module11.protocols,
    logger: logger2,
    turnOrchestrator: new ProtocolTurnOrchestratorImpl({
      // The orchestrator only needs the emergency id off the protocol session;
      // Module 11's port already exposes it via getSession.
      sessions: {
        async get(sessionId) {
          const session = await module11.protocols.getSession(sessionId);
          if (!session) throw new Error(`Protocol session '${sessionId}' was not found.`);
          return { session: { emergencyId: session.emergencyId } };
        }
      },
      calls: module11.calls,
      speech: module2.speech,
      logger: logger2
    })
  });
  const module1 = new Module1({
    emergencies: module11.emergencies,
    calls: module11.calls,
    events: module11.eventPublisher,
    logger: logger2
  });
  const module6 = new Module6({
    ambulances: module11.ambulances,
    events: module11.eventPublisher,
    bus: module11.bus,
    emergencies: module11.emergencies,
    logger: logger2
  });
  const module7 = new Module7({
    hospitals: module11.hospitals,
    hospitalResources: module11.hospitals,
    emergencies: module11.emergencies,
    events: module11.eventPublisher,
    bus: module11.bus,
    logger: logger2
  });
  const module8 = new Module8({
    routes: module11.routes,
    emergencies: module11.emergencies,
    ambulances: module11.ambulances,
    hospitals: module11.hospitals,
    events: module11.eventPublisher,
    dispatchEvents: module11.eventQuery,
    bus: module11.bus,
    ...dependencies.routingProviders?.primary ? { primaryProvider: dependencies.routingProviders.primary } : {},
    ...dependencies.routingProviders?.fallback ? { fallbackProvider: dependencies.routingProviders.fallback } : {},
    logger: logger2
  });
  const module9 = new Module9({
    corridors: module11.routes,
    notifications: module11.notifications,
    routes: module11.routes,
    bus: module11.bus,
    dispatchEvents: module11.eventQuery,
    logger: logger2
  });
  const module12 = new Module12({
    analyticsRead: module11.analyticsRead,
    events: module11.eventQuery
  });
  const nlpClassifier = new Module3Classifier({
    baseUrl: config.nlp.baseUrl,
    timeoutMs: config.nlp.timeoutMs,
    logger: logger2
  });
  const classification = new EmergencyClassificationService({
    classifier: nlpClassifier,
    emergencies: module11.emergencies,
    calls: module11.calls,
    events: module11.eventPublisher,
    logger: logger2,
    enabled: config.nlp.enabled
  });
  await fastify.register(jwt, { secret: config.jwtSecret });
  const auth = new AuthService(
    module11.users,
    // The secret is configured once on the fastify-jwt plugin, so the
    // AuthService never needs to pass it per call.
    async (payload, _secret, expiresIn) => fastify.jwt.sign(payload, { expiresIn }),
    async (token, _secret) => fastify.jwt.verify(token),
    config.jwtSecret,
    config.jwtExpiresIn,
    !config.isProduction
  );
  registerAuthRoutes(fastify, auth);
  const table = new RouteTable();
  table.addAll(module11.routeDefinitions());
  module5.register(table);
  module1.register(table);
  module2.register(table);
  module6.register(table);
  module7.register(table);
  module8.register(table);
  module9.register(table);
  module12.register(table);
  table.addAll(createModule10LifecycleRoutes(module10LifecycleObserver));
  table.addAll(createNlpClassifyRoutes(classification));
  const registered = registerRoutes(fastify, table.routes, {
    authenticate: async (request) => auth.authenticate(request)
  });
  fastify.get("/api/health", async () => ({
    status: "ok",
    env: config.nodeEnv,
    routes: registered.count,
    modules: registered.modules,
    realtimeClients: realtime.clientCount,
    timestamp: (/* @__PURE__ */ new Date()).toISOString()
  }));
  fastify.get("/api", async () => ({
    name: "Pre-Hospital Emergency Survival System",
    modules: registered.modules,
    routes: table.routes.map((route) => ({
      method: route.method,
      url: route.url,
      module: route.module,
      summary: route.summary,
      auth: route.auth ?? { public: false }
    }))
  }));
  await fastify.register(websocket);
  fastify.addContentTypeParser(
    ["application/octet-stream", "audio/wav", "audio/webm", "audio/ogg", "audio/mpeg", "audio/*"],
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body)
  );
  registerDevHarness(fastify, module11, config.isProduction);
  fastify.get("/ws", { websocket: true }, (socket, request) => {
    const url = new URL(request.url, "http://localhost");
    const requested = url.searchParams.get("channels")?.split(",") ?? void 0;
    const { clientId } = realtime.attach(socket, requested);
    socket.on("close", () => realtime.detach(clientId));
    socket.on("error", () => realtime.detach(clientId));
    socket.on("message", (raw) => {
      try {
        const parsed = JSON.parse(raw.toString());
        if (parsed.action === "subscribe" && Array.isArray(parsed.channels)) {
          realtime.resubscribe(clientId, parsed.channels);
          logger2.debug(
            { clientId, channels: parsed.channels.length },
            "realtime subscription updated"
          );
        }
      } catch {
        logger2.debug({ clientId }, "ignoring unparseable websocket frame");
      }
    });
  });
  const asterisk = await startAsteriskRuntime({
    module1,
    speech: module2.speech,
    calls: module11.calls,
    // Module 5 owns what is said; the controller renders it into the call's
    // language (Module 4's language layer) and the adapter adds the caller-silence
    // retry budget and its conversation-layer events. Both are inert by default:
    // no localiser unless a reviewed table is configured, and no silence timer
    // unless a positive timeout is set.
    conversation: new ConversationSupportAdapter({
      inner: new AsteriskConversationController({
        sessions: module5.sessions,
        emergencies: module11.emergencies,
        transcripts: module11.calls,
        logger: logger2,
        ...config.conversation.localisationEnabled && config.conversation.translationsFile ? { localizer: InstructionLocalizer.fromFile(config.conversation.translationsFile, logger2) } : {}
      }),
      events: module11.eventPublisher,
      config: {
        silenceTimeoutMs: config.conversation.silenceTimeoutMs,
        silenceRetryLimit: config.conversation.silenceRetryLimit
      },
      logger: logger2
    }),
    config,
    logger: logger2
  });
  const shutdown = async () => {
    logger2.info("shutting down");
    module7.dispose();
    module8.dispose();
    module9.dispose();
    if (asterisk) await asterisk.stop();
    await module10LifecycleObserver.dispose();
    realtime.dispose();
    await fastify.close();
    await module11.dispose();
  };
  return { fastify, module11, module1, module2, module5, module6, module7, module8, module9, module12, realtime, logger: logger2, asterisk, shutdown };
}

// apps/server/src/main.ts
async function main() {
  const config = loadServerConfig();
  const server = await buildServer(config);
  const catalogue = await server.module5.preload();
  const shutdown = async (signal) => {
    server.logger.info({ signal }, "received signal");
    await server.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  await server.fastify.listen({ port: config.port, host: config.host });
  server.logger.info(
    {
      port: config.port,
      host: config.host,
      env: config.nodeEnv,
      protocols: catalogue.protocols,
      steps: catalogue.steps
    },
    "server ready"
  );
  if (!config.isProduction) {
    server.logger.info(
      { url: `http://localhost:${config.port}/dev/protocol-chat` },
      "Module 5 development harness"
    );
  }
}
main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[server] failed to start: ${message}`);
  process.exit(1);
});
//# sourceMappingURL=server.js.map
