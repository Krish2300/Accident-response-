import { z } from 'zod';
import {
  AppError,
  ErrorCode,
  defineEvent,
  type AuthContext,
  type EventPublisherPort,
  type Logger,
  type RouteDefinition,
} from '@resus/core';
import { noopLogger } from '@resus/core';
import {
  Module3Classifier,
  type ClassifyFailure,
  type NlpExtractionCandidate,
} from './module3Classifier.js';

/**
 * Module 3 candidate-extraction route (keeps the established /classify URL).
 *
 * This is the single entry point that lets the running system invoke Module 3.
 * It is operator-triggered and explicit: nothing here subscribes to a live
 * transcript or fires on its own, so normalized classification can never silently change
 * what the system is doing mid-call.
 *
 * What this route deliberately does NOT do:
 *  - It never writes `EMERGENCY_CLASSIFIED`. That event belongs to the explicit
 *    operator normalization path; its `incidentType`/`severity` contract does
 *    not match Module 3's category/priority vocabulary. Publishing it here would
 *    silently turn candidate facts into an authoritative decision.
 *  - It never mutates the emergency, its status or its ambulance assignment, and
 *    it never touches Module 5's protocol decisions.
 *
 * It records what Module 3 actually returned (`NLP_EXTRACTION_COMPLETED`, with
 * `degraded` set truthfully) or that it failed (`NLP_EXTRACTION_REJECTED`), and
 * returns the result to the caller.
 */

export interface ClassifyEmergencyLookup {
  findById(id: string): Promise<{ id: string; isSimulation: boolean } | null>;
}

export interface ClassifyTranscriptLookup {
  transcriptsFor(emergencyId: string): Promise<
    Array<{ text: string; isFinal: boolean; sequence: number; speaker: string }>
  >;
  requireSessionFor(emergencyId: string): Promise<{ id: string }>;
}

export interface EmergencyClassificationDeps {
  classifier: Module3Classifier;
  emergencies: ClassifyEmergencyLookup;
  calls: ClassifyTranscriptLookup;
  events: EventPublisherPort;
  logger?: Logger;
  /** When false the route refuses with 503 instead of calling Module 3. */
  enabled: boolean;
}

export const classifyBodySchema = z.object({
  /** Overrides the stored transcript. Bounded to Module 3's own input limit. */
  transcriptText: z.string().min(1).max(4096).optional(),
  language: z.string().min(1).max(16).optional(),
  isFinalChunk: z.boolean().optional(),
  /** Correlation id; defaults to the emergency's call session. */
  sessionId: z.string().min(1).max(128).optional(),
});

export type ClassifyBody = z.infer<typeof classifyBodySchema>;

function failureToError(failure: ClassifyFailure): AppError {
  switch (failure.kind) {
    case 'TIMEOUT':
      return new AppError(ErrorCode.LLM_TIMEOUT, failure.reason, 504);
    case 'MALFORMED':
      return new AppError(ErrorCode.LLM_MALFORMED_RESPONSE, failure.reason, 502);
    case 'HTTP_ERROR':
      return new AppError(ErrorCode.LLM_UNAVAILABLE, failure.reason, 502, failure.details);
    case 'UNAVAILABLE':
    default:
      return new AppError(ErrorCode.LLM_UNAVAILABLE, failure.reason, 503);
  }
}

export class EmergencyClassificationService {
  private readonly logger: Logger;

  constructor(private readonly deps: EmergencyClassificationDeps) {
    this.logger = deps.logger ?? noopLogger;
  }

  async classify(
    emergencyId: string,
    body: ClassifyBody,
    user?: AuthContext,
  ): Promise<NlpExtractionCandidate> {
    if (!this.deps.enabled) {
      throw new AppError(
        ErrorCode.PROVIDER_NOT_CONFIGURED,
        'Module 3 NLP integration is disabled. Set MODULE3_NLP_ENABLED=true to enable it.',
        503,
      );
    }

    // Module 2 emits partial captions separately and does not persist them as
    // transcripts. Refuse an explicitly partial override before lookup/provider
    // access so it cannot be mistaken for reviewable final candidate facts.
    if (body.isFinalChunk === false) {
      throw AppError.validation('Module 3 extraction requires a final transcript.');
    }

    const emergency = await this.deps.emergencies.findById(emergencyId);
    if (!emergency) throw AppError.notFound('Emergency', emergencyId);

    const sessionId = body.sessionId ?? (await this.resolveSessionId(emergencyId));
    const transcriptText = await this.resolveTranscriptText(emergencyId, body);

    const outcome = await this.deps.classifier.classify({
      emergencyId,
      sessionId,
      transcriptText,
      language: body.language,
      isFinalChunk: body.isFinalChunk,
    });

    if (!outcome.ok) {
      await this.recordRejected(emergencyId, outcome.reason, user);
      throw failureToError(outcome);
    }

    await this.deps.events
      .record(
        defineEvent('NLP_EXTRACTION_COMPLETED', {
          emergencyId,
          entityType: 'emergency',
          entityId: emergencyId,
          actorType: user ? 'OPERATOR' : 'SYSTEM',
          actorId: user?.userId ?? null,
          payload: {
            emergencyId,
            provider: outcome.extraction.provider,
            model: outcome.extraction.model,
            incidentType: outcome.extraction.category,
            severity: outcome.extraction.severityLevel,
            confidence: outcome.extraction.confidence,
            latencyMs: outcome.extraction.latencyMs,
            degraded: outcome.extraction.degraded,
          },
        }),
        { emergencyId },
      )
      .catch((error: unknown) => {
        this.logger.error(
          { emergencyId, reason: (error as Error).message },
          'could not record NLP_EXTRACTION_COMPLETED',
        );
      });

    return outcome.extraction;
  }

  private async resolveSessionId(emergencyId: string): Promise<string> {
    try {
      const session = await this.deps.calls.requireSessionFor(emergencyId);
      return session.id;
    } catch {
      // No call session row (e.g. an emergency seeded without one). Module 3's
      // `session_id` is only a correlation id, so the emergency id is a faithful
      // substitute rather than an invented one.
      this.logger.debug({ emergencyId }, 'no call session for emergency; using emergency id');
      return emergencyId;
    }
  }

  private async resolveTranscriptText(emergencyId: string, body: ClassifyBody): Promise<string> {
    const provided = body.transcriptText?.trim();
    if (provided) return provided;

    const transcripts = await this.deps.calls.transcriptsFor(emergencyId);
    const finals = transcripts
      .filter((entry) => entry.isFinal && entry.text.trim().length > 0)
      .sort((a, b) => a.sequence - b.sequence);
    const latest = finals.at(-1)?.text.trim();

    if (!latest) {
      throw AppError.validation(
        'No transcript text is available for this emergency. Provide transcriptText or record a final transcript first.',
      );
    }
    return latest;
  }

  private async recordRejected(
    emergencyId: string,
    reason: string,
    user?: AuthContext,
  ): Promise<void> {
    await this.deps.events
      .record(
        defineEvent('NLP_EXTRACTION_REJECTED', {
          emergencyId,
          entityType: 'emergency',
          entityId: emergencyId,
          actorType: user ? 'OPERATOR' : 'SYSTEM',
          actorId: user?.userId ?? null,
          payload: {
            emergencyId,
            provider: this.deps.classifier.providerName,
            reason,
          },
        }),
        { emergencyId },
      )
      .catch((error: unknown) => {
        this.logger.error(
          { emergencyId, reason: (error as Error).message },
          'could not record NLP_EXTRACTION_REJECTED',
        );
      });
  }
}

export function createNlpClassifyRoutes(
  service: EmergencyClassificationService,
): RouteDefinition<ClassifyBody>[] {
  return [
    {
      method: 'POST',
      url: '/api/emergencies/:id/classify',
      module: 'module_03',
      summary:
        'Extract candidate facts from a final transcript (no normalized classification, status change, protocol action or dispatch).',
      auth: { roles: ['OPERATOR', 'DISPATCHER', 'CLINICAL_SUPERVISOR', 'ADMIN'] },
      body: classifyBodySchema,
      handler: async (request, reply) => {
        const id = String(request.params.id ?? '');
        const body = classifyBodySchema.parse(request.body ?? {});
        const extraction = await service.classify(id, body, request.user);
        reply.send({ emergencyId: id, extraction });
      },
    },
  ];
}
