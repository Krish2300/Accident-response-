/**
 * External provider ports.
 *
 * Every capability this system cannot implement locally sits behind an interface
 * declared here, so the whole platform runs end-to-end with no external service
 * and a real integration can be dropped in without touching module logic.
 *
 * The rule this file exists to enforce
 * ------------------------------------
 * A provider may be *unavailable*. It may never be *pretended*.
 *
 * Therefore every port below carries:
 *   - `providerName` and `isLive`, so a caller can tell a real SIP leg from a
 *     development mock, and
 *   - an explicit failure path, so an unreachable provider surfaces as a typed
 *     error instead of silently returning empty or fabricated results.
 *
 * Development implementations are named `Mock*` and always report
 * `isLive: false`. Nothing in this repository configures a real telephony
 * carrier, traffic-signal controller or SMS gateway, so every response the
 * system produces in development is labelled as simulated at the point it is
 * recorded (see `isSimulation` on events and rows).
 */
import type { Coordinate } from './geo.js';

// -----------------------------------------------------------------------------
// Module 1 — telephony / call transport
// -----------------------------------------------------------------------------

export type CallTransport = 'SIP' | 'WEBRTC' | 'PSTN' | 'LOOPBACK' | 'TEXT';

export interface CallInvite {
  /** Caller-supplied number or SIP user, when the transport exposes one. */
  callerId?: string | null;
  channel?: string;
  language?: string;
}

export interface CallHandle {
  callSessionId: string;
  transport: CallTransport;
  providerName: string;
  /** False for every development transport. Never report a mock as live. */
  isLive: boolean;
  startedAt: string;
}

export interface TelephonyProvider {
  readonly providerName: string;
  readonly isLive: boolean;
  /** Establishes a call session. Throws AppError on provider failure. */
  originate(invite: CallInvite): Promise<CallHandle>;
  /** Terminates a session. Must be idempotent. */
  hangup(callSessionId: string, reason: string): Promise<void>;
  /** Cheap liveness probe used by the health endpoint. */
  probe(): Promise<{ reachable: boolean; detail: string }>;
}

// -----------------------------------------------------------------------------
// Module 2 — speech
// -----------------------------------------------------------------------------

/**
 * How much of what the caller said the system was prepared to rely on.
 *
 * Exported rather than kept inside Module 2 because the decision is not only
 * about speech: Module 5 needs the same threshold when deciding whether a
 * fact came from a clear answer or a mumbled one, and the two must not be able
 * to disagree about the same audio.
 */
export const VOICE_CONFIDENCE = {
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
  DISCARD_BELOW: 0.45,
} as const;

export type VoiceConfidenceBand = 'HIGH' | 'LOW' | 'UNUSABLE';

/**
 * Classifies a confidence score.
 *
 * `discardBelow` exists so a deployment can raise the floor above the shared
 * default without inventing a second policy: HIGH stays anchored to
 * `VOICE_CONFIDENCE.HIGH`, and only the point at which a result is thrown away
 * moves. Omitting it uses the shared threshold.
 */
export function confidenceBand(
  confidence: number,
  discardBelow: number = VOICE_CONFIDENCE.DISCARD_BELOW,
): VoiceConfidenceBand {
  if (confidence >= VOICE_CONFIDENCE.HIGH) return 'HIGH';
  if (confidence >= discardBelow) return 'LOW';
  return 'UNUSABLE';
}

/**
 * Detection of the languages the system can attempt.
 *
 * Malayalam is included because the deployment context is Kerala. A number of
 * languages appear in Indian emergency calls; the list is deliberately the
 * languages the *providers* are configured for, not an aspiration, and adding a
 * language here without a provider that supports it only moves the failure from
 * "language not supported" to a silently wrong transcription.
 */
export const SUPPORTED_LANGUAGES = ['en', 'ml'] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

/**
 * Returns the base language code, or null when it is not one the system handles.
 * `en-IN`, `en_US` and `EN` all resolve to `en`.
 */
export function normaliseLanguageCode(language: string): SupportedLanguage | null {
  const base = language.trim().toLowerCase().split(/[-_]/)[0] ?? '';
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(base) ? (base as SupportedLanguage) : null;
}

export interface TranscriptionRequest {
  callSessionId: string;
  emergencyId: string;
  language: string;
  /** Raw audio or a reference to a captured buffer. */
  audio: Uint8Array;
  isFinal: boolean;
}

export interface TranscriptionResult {
  text: string;
  language: string;
  /** 0..1. Below the configured threshold the result is treated as unusable. */
  confidence: number;
  isFinal: boolean;
  providerName: string;
  isLive: boolean;
  /** Words the engine could not resolve. Present when the audio was unclear. */
  unclearSpans?: Array<{ startMs: number; endMs: number }>;
}

export interface SpeechProvider {
  readonly providerName: string;
  readonly isLive: boolean;
  /** Languages this provider can actually transcribe. */
  readonly supportedLanguages: readonly string[];
  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult>;
}

export interface SynthesisRequest {
  text: string;
  language: string;
  /** CALM | URGENT | REASSURING. Providers may vary pace and pitch by tone. */
  tone: 'CALM' | 'URGENT' | 'REASSURING';
  /**
   * True when the text is the protocol catalogue's own wording. A provider that
   * cannot honour this must still record it, so the transcript records whether
   * the caller heard reviewed text or a paraphrase.
   */
  verbatimProtocolText: boolean;
}

export interface SynthesisResult {
  audio: Uint8Array;
  mimeType: string;
  providerName: string;
  isLive: boolean;
  voice: string;
  durationMs: number | null;
}

export interface TextToSpeechProvider {
  readonly providerName: string;
  readonly isLive: boolean;
  readonly supportedLanguages: readonly string[];
  synthesize(request: SynthesisRequest): Promise<SynthesisResult>;
}

// -----------------------------------------------------------------------------
// Module 3 — language understanding
// -----------------------------------------------------------------------------

export interface ExtractionRequest {
  text: string;
  language: string;
  /** Facts already established, so a provider does not re-assert them. */
  knownFacts: Record<string, unknown>;
  /** The question the system just asked, when there is one. */
  currentQuestion?: string | null;
}

export interface ExtractionResponse {
  facts: Record<string, unknown>;
  confidence: number;
  providerName: string;
  model: string;
  /** True when the provider is a deterministic matcher, not a language model. */
  degraded: boolean;
}

/**
 * Interpretation only.
 *
 * A provider may extract facts. It may not choose a protocol step, write an
 * instruction, or decide an emergency state — those belong to the protocol
 * engine and the state engine respectively. Implementations must not accept a
 * prompt asking them to do so.
 */
export interface LanguageUnderstandingProvider {
  readonly providerName: string;
  readonly model: string;
  readonly isLanguageModel: boolean;
  readonly isLive: boolean;
  readonly supportedLanguages: readonly string[];
  extract(request: ExtractionRequest): Promise<ExtractionResponse>;
}

// -----------------------------------------------------------------------------
// Module 8 — routing
// -----------------------------------------------------------------------------

export interface RouteRequest {
  origin: Coordinate;
  destination: Coordinate;
  /** Free-flow assumption. Providers multiply by observed traffic. */
  averageSpeedKmh?: number;
  /** Ask for alternatives beyond the best route. */
  alternatives?: number;
}

export interface RouteCandidate {
  distanceKm: number;
  estimatedMinutes: number;
  /** Ordered [lat, lng] pairs. At least two points. */
  geometry: Array<[number, number]>;
  /** Multiplier against free-flow time. 1.0 means free flow. */
  trafficFactor: number;
}

export interface RouteResult {
  providerName: string;
  /** False when the provider has no live traffic feed. */
  isLiveTraffic: boolean;
  selected: RouteCandidate;
  alternatives: RouteCandidate[];
  /** Why this candidate was chosen, in words a dispatcher can read. */
  selectionReason: string;
}

export interface RoutingProvider {
  readonly providerName: string;
  readonly isLive: boolean;
  readonly isLiveTraffic: boolean;
  route(request: RouteRequest): Promise<RouteResult>;
}

// -----------------------------------------------------------------------------
// Module 9 — position and notifications
// -----------------------------------------------------------------------------

export interface PositionReport {
  entityId: string;
  latitude: number;
  longitude: number;
  speedKmh?: number | null;
  headingDeg?: number | null;
  accuracyM?: number | null;
  recordedAt: string;
  source: string;
  isLive: boolean;
}

export interface PositionProvider {
  readonly providerName: string;
  readonly isLive: boolean;
  /** Latest known position, or null when the entity has never reported one. */
  latest(entityId: string): Promise<PositionReport | null>;
  /**
   * Polls for updates. Implementations that cannot track must return an empty
   * array rather than inventing positions.
   */
  poll(entityIds: string[]): Promise<PositionReport[]>;
}

export interface RoadUser {
  id: string;
  kind: 'VEHICLE' | 'PEDESTRIAN' | 'CYCLIST' | 'UNKNOWN';
  latitude: number;
  longitude: number;
  distanceToCorridorM: number;
  headingDeg?: number | null;
  speedKmh?: number | null;
}

export type NotificationAudience =
  | 'NEARBY_ROAD_USERS'
  | 'TRAFFIC_CONTROL'
  | 'HOSPITAL_ED'
  | 'OPERATORS'
  | 'AMBULANCE_CREW';

export interface NotificationRequest {
  emergencyId: string;
  corridorId?: string | null;
  channel: 'PUSH' | 'SMS' | 'VOICE' | 'WEB' | 'IN_APP';
  audience: NotificationAudience;
  body: string;
  location?: Coordinate | null;
}

export interface NotificationResult {
  providerName: string;
  isLive: boolean;
  /** False unless a real provider confirmed the message left the system. */
  delivered: boolean;
  status: 'QUEUED' | 'SENT' | 'DELIVERED' | 'FAILED' | 'SUPPRESSED';
  detail: string;
}

export interface NotificationProvider {
  readonly providerName: string;
  readonly isLive: boolean;
  notify(request: NotificationRequest): Promise<NotificationResult>;
}

export interface TrafficPriorityProvider {
  readonly providerName: string;
  readonly isLive: boolean;
  /**
   * Requests green waves along a corridor.
   *
   * No implementation in this repository controls a real signal: there is no
   * controller integration and no credential for one. Development
   * implementations simulate the request and report `isLive: false`, and
   * corridors are stored with `priorityMode: SIMULATED` accordingly.
   */
  requestPriority(corridorId: string, path: Coordinate[]): Promise<{
    granted: boolean;
    detail: string;
    signalsTouched: number;
  }>;
  releasePriority(corridorId: string): Promise<void>;
}

/**
 * Detects road users inside a corridor geofence.
 *
 * There is no live traffic feed in development, so the development
 * implementation derives detections from ambulance telemetry and labels them
 * `isLive: false`. A real implementation would subscribe to a traffic feed.
 */
export interface RoadUserProvider {
  readonly providerName: string;
  readonly isLive: boolean;
  detectNear(path: Coordinate[], radiusM: number, ambulancePosition: Coordinate | null): Promise<RoadUser[]>;
}
