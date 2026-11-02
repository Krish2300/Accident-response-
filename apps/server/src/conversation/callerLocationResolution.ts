import { ErrorCode, isValidCoordinate, type Logger, noopLogger, AppError } from '@resus/core';
import type { EmergencyRepository } from '@resus/module_11_database_event_system';
import type { SystemEventRecord } from '@resus/core';

export type CallerLocationLookup =
  | { outcome: 'CANDIDATE' | 'AMBIGUOUS'; latitude: number; longitude: number; confidence: number }
  | { outcome: 'NOT_FOUND' | 'UNAVAILABLE' | 'INVALID_RESULT'; confidence?: null };

/** The adapter boundary for an explicitly configured caller-text geocoder. */
export interface CallerLocationResolver {
  readonly providerName: string;
  resolve(locationText: string): Promise<CallerLocationLookup>;
}

/** Safe default: no geocoder is configured, so caller text is never geocoded. */
export class UnconfiguredCallerLocationResolver implements CallerLocationResolver {
  readonly providerName = 'unconfigured';
  async resolve(_locationText: string): Promise<CallerLocationLookup> {
    return { outcome: 'UNAVAILABLE' };
  }
}

export class CallerLocationResolutionService {
  constructor(private readonly deps: {
    emergencies: EmergencyRepository;
    resolver?: CallerLocationResolver;
    timeoutMs?: number;
    logger?: Logger;
  }) {}

  /**
   * Capture the text fact as an auditable candidate. It never updates an
   * emergency coordinate or triggers assignment/routing; an operator must
   * confirm a valid coordinate through the separate authenticated route.
   */
  async capture(emergencyId: string, rawText: string, attempt = 1): Promise<SystemEventRecord | undefined> {
    const locationText = rawText.trim();
    if (!locationText || locationText.length > 200) return undefined;
    const logger = this.deps.logger ?? noopLogger;
    const resolver = this.deps.resolver ?? new UnconfiguredCallerLocationResolver();
    const requestedTimeout = this.deps.timeoutMs ?? 3000;
    const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0 ? requestedTimeout : 3000;
    let result: CallerLocationLookup;
    try {
      result = await withTimeout(resolver.resolve(locationText), timeoutMs);
      if ('latitude' in result && (!isValidCoordinate({ latitude: result.latitude, longitude: result.longitude }) ||
        !Number.isFinite(result.confidence) || result.confidence < 0 || result.confidence > 1)) {
        result = { outcome: 'INVALID_RESULT' };
      }
    } catch (error) {
      logger.warn({ emergencyId, provider: resolver.providerName, reason: error instanceof Error ? error.name : 'unknown' }, 'caller location lookup unavailable');
      result = { outcome: 'UNAVAILABLE' };
    }
    return this.deps.emergencies.recordCallerLocationCandidate({
      emergencyId,
      locationText,
      provider: resolver.providerName,
      outcome: result.outcome,
      confidence: 'confidence' in result && typeof result.confidence === 'number' ? result.confidence : null,
      latitude: 'latitude' in result ? result.latitude : null,
      longitude: 'longitude' in result ? result.longitude : null,
      attempt,
    });
  }

  async retry(emergencyId: string, resolutionId: string, previous: SystemEventRecord): Promise<SystemEventRecord | undefined> {
    if (previous.type !== 'EMERGENCY_LOCATION_CANDIDATE' || previous.emergencyId !== emergencyId) return undefined;
    const payload = previous.payload as Record<string, unknown>;
    if (!['UNAVAILABLE', 'NOT_FOUND', 'AMBIGUOUS', 'INVALID_RESULT'].includes(String(payload.outcome))) return undefined;
    const attempt = Number(payload.attempt ?? 1);
    if (attempt >= 3) throw new AppError(ErrorCode.CONFLICT, 'Caller location lookup has reached the three-attempt limit.', 409);
    return this.capture(emergencyId, String(payload.callerLocationText ?? ''), attempt + 1);
  }
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('LOCATION_LOOKUP_TIMEOUT')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
