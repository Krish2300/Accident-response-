import { z } from 'zod';
import type { Logger } from '@resus/core';
import { noopLogger } from '@resus/core';

/**
 * Client adapter for Module 3 (Emergency NLP).
 *
 * Module 3 is a standalone Python FastAPI service; the only stable boundary it
 * offers is `POST /extract`. This adapter invokes that service and translates
 * its response into a typed result the server can record, validate and log.
 *
 * It is deliberately a *transport* boundary and nothing more. It does not
 * classify, score or re-interpret: the module's own category, severity level and
 * confidence are carried through verbatim. Classification is kept distinct from
 * clinical triage and from Module 5's protocol decisions, which are never made
 * here.
 *
 * Every failure mode that can occur at this boundary (service down, timeout,
 * non-2xx, or a response that does not match the extraction schema) is returned
 * as a typed failure, never thrown, so the caller can record it and degrade
 * honestly instead of inventing a classification.
 */

const severitySchema = z.object({
  level: z.string(),
  numeric_score: z.number(),
  rationale: z.string().optional(),
  key_risk_factors: z.array(z.string()).optional(),
  cpr_required: z.boolean().optional(),
  aed_required: z.boolean().optional(),
});

const locationSchema = z
  .object({
    raw_text: z.string().nullish(),
    landmark: z.string().nullish(),
    street_address: z.string().nullish(),
    area_district: z.string().nullish(),
    city: z.string().nullish(),
    pin_code: z.string().nullish(),
    gps_hint: z.string().nullish(),
    confidence: z.number().optional(),
  })
  .partial();

const patientSchema = z
  .object({
    age: z.number().nullish(),
    gender: z.string().nullish(),
    count: z.number().optional(),
    consciousness: z.string().optional(),
    breathing: z.string().optional(),
    pulse_present: z.boolean().nullish(),
    chief_complaint: z.string().nullish(),
    secondary_symptoms: z.array(z.string()).optional(),
    known_conditions: z.array(z.string()).optional(),
    mobility: z.string().nullish(),
  })
  .partial();

const missingFieldsSchema = z.record(z.string(), z.unknown()).optional();

const multilingualSchema = z.record(z.string(), z.unknown()).optional();

/**
 * The subset of Module 3's `ExtractedIncidentData` this adapter actually reads.
 *
 * Extra fields the module may add are ignored; the fields that are required here
 * are the ones the projection cannot function without. `raw_llm_response` is
 * excluded by the module's own schema and is never expected.
 */
const module3ResponseSchema = z.object({
  session_id: z.string().optional(),
  extraction_id: z.string().optional(),
  extracted_at: z.string().optional(),
  incident_category: z.string(),
  incident_subcategory: z.string().nullish(),
  caller_intent: z.string().optional(),
  severity: severitySchema,
  location: locationSchema.optional(),
  patient: patientSchema.optional(),
  bystanders_present: z.boolean().nullish(),
  hazards: z.array(z.string()).optional(),
  missing_fields: missingFieldsSchema,
  multilingual: multilingualSchema,
  extraction_confidence: z.number().min(0).max(1),
  validation_warnings: z.array(z.string()).optional(),
});

export type Module3Extraction = z.infer<typeof module3ResponseSchema>;

/** Untrusted candidate facts returned by Module 3; not a normalized classification. */
export interface NlpExtractionCandidate {
  emergencyId: string;
  sessionId: string;
  provider: string;
  model: string;
  /** Module 3's own category, e.g. `CARDIAC`. Not mapped to a local enum. */
  category: string;
  /** Module 3's own priority tier, e.g. `P1`. Not mapped to a local enum. */
  severityLevel: string;
  severityScore: number;
  confidence: number;
  cprRequired: boolean;
  /**
   * True when Module 3 answered with its safe fallback rather than a model
   * extraction. A degraded result is recorded, never presented as a real one.
   */
  degraded: boolean;
  latencyMs: number;
  extractedAt: string;
  warnings: string[];
}

/** @deprecated Use NlpExtractionCandidate; this value is not authoritative classification. */
export type NlpClassification = NlpExtractionCandidate;

export interface ClassifyInput {
  emergencyId: string;
  /** Correlation id passed to Module 3 as `session_id`. */
  sessionId: string;
  transcriptText: string;
  language?: string;
  isFinalChunk?: boolean;
  cumulativeTranscript?: string;
}

export type ClassifyFailureKind = 'UNAVAILABLE' | 'TIMEOUT' | 'MALFORMED' | 'HTTP_ERROR';

export interface ClassifyFailure {
  ok: false;
  kind: ClassifyFailureKind;
  reason: string;
  status?: number;
  details?: unknown;
}

export interface ClassifySuccess {
  ok: true;
  extraction: NlpExtractionCandidate;
}

export type ClassifyOutcome = ClassifySuccess | ClassifyFailure;

export interface Module3ClassifierOptions {
  baseUrl: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  providerName?: string;
  model?: string;
  logger?: Logger;
}

const DEFAULT_TIMEOUT_MS = 8_000;
const FALLBACK_MARKER = 'FALLBACK TRIGGERED';

export class Module3Classifier {
  readonly providerName: string;
  readonly model: string;

  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger;

  constructor(options: Module3ClassifierOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.providerName = options.providerName ?? 'module3-emergency-nlp';
    this.model = options.model ?? 'claude-sonnet-4-6';
    this.logger = options.logger ?? noopLogger;

    if (typeof this.fetchImpl !== 'function') {
      throw new Error('Module3Classifier requires a fetch implementation.');
    }
  }

  /** Invokes Module 3's `/extract`. Never throws for an expected failure. */
  async classify(input: ClassifyInput): Promise<ClassifyOutcome> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}/extract`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            session_id: input.sessionId,
            transcript_text: input.transcriptText,
            detected_language: input.language ?? 'unknown',
            is_final_chunk: input.isFinalChunk ?? true,
            cumulative_transcript: input.cumulativeTranscript,
          }),
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted || (error as Error)?.name === 'AbortError') {
          return this.timeoutFailure();
        }
        return {
          ok: false,
          kind: 'UNAVAILABLE',
          reason: `Module 3 is unreachable: ${error instanceof Error ? error.message : String(error)}`,
        };
      }

      if (!response.ok) {
        const excerpt = await this.readExcerpt(response);
        if (controller.signal.aborted) return this.timeoutFailure();
        this.logger.warn(
          { status: response.status, emergencyId: input.emergencyId },
          'Module 3 returned a non-success status',
        );
        return {
          ok: false,
          kind: 'HTTP_ERROR',
          status: response.status,
          reason: `Module 3 returned HTTP ${response.status}.`,
          details: excerpt ? { rawExcerpt: excerpt } : undefined,
        };
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch (error) {
        if (controller.signal.aborted || (error as Error)?.name === 'AbortError') {
          return this.timeoutFailure();
        }
        return { ok: false, kind: 'MALFORMED', reason: 'Module 3 response was not valid JSON.' };
      }

      const parsed = module3ResponseSchema.safeParse(body);
      if (!parsed.success) {
        this.logger.warn(
          { emergencyId: input.emergencyId, issues: parsed.error.issues.length },
          'Module 3 response did not match the extraction schema',
        );
        return {
          ok: false,
          kind: 'MALFORMED',
          reason: 'Module 3 response did not match the extraction schema.',
          details: parsed.error.issues,
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
          extractedAt: data.extracted_at ?? new Date().toISOString(),
          warnings,
        },
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private timeoutFailure(): ClassifyFailure {
    return {
      ok: false,
      kind: 'TIMEOUT',
      reason: `Module 3 did not respond within ${this.timeoutMs}ms.`,
    };
  }

  private async readExcerpt(response: Response): Promise<string | null> {
    try {
      const text = await response.text();
      return text.slice(0, 500) || null;
    } catch {
      return null;
    }
  }
}
