import { describe, expect, it, vi } from 'vitest';
import {
  AppError,
  isAppError,
  noopLogger,
  type EventPublisherPort,
  type SystemEventEnvelope,
  type SystemEventRecord,
} from '@resus/core';
import { Module3Classifier } from '../apps/server/src/nlp/module3Classifier.js';
import {
  EmergencyClassificationService,
  createNlpClassifyRoutes,
  type ClassifyBody,
} from '../apps/server/src/nlp/classifyRoutes.js';

/**
 * Route + orchestration tests for the Module 3 classify endpoint.
 *
 * The classifier is the real adapter driven by an injected `fetch`; the
 * persistence ports are fakes. This isolates the wiring — which event is
 * recorded, what status a failure maps to, and that nothing else is written.
 */

const CARDIAC = {
  session_id: 'CALL-1',
  incident_category: 'CARDIAC',
  severity: { level: 'P1', numeric_score: 10, cpr_required: true },
  missing_fields: { location_missing: false },
  extraction_confidence: 0.9,
  validation_warnings: [],
};

const FALLBACK = {
  session_id: 'CALL-1',
  incident_category: 'UNKNOWN',
  severity: { level: 'P2', numeric_score: 6, cpr_required: false },
  missing_fields: { location_missing: true },
  extraction_confidence: 0,
  validation_warnings: ['FALLBACK TRIGGERED: unexpected: TypeError'],
};

interface Harness {
  run: (body?: ClassifyBody, params?: Record<string, string>) => Promise<unknown>;
  recorded: SystemEventEnvelope[];
  fetchImpl: ReturnType<typeof vi.fn>;
}

function harness(options: {
  enabled?: boolean;
  fetchImpl?: ReturnType<typeof vi.fn>;
  emergencyExists?: boolean;
  transcripts?: Array<{ text: string; isFinal: boolean; sequence: number; speaker: string }>;
}): Harness {
  const recorded: SystemEventEnvelope[] = [];
  const events = {
    record: async (event: SystemEventEnvelope): Promise<SystemEventRecord> => {
      recorded.push(event);
      return {
        id: `EVT-${recorded.length}`,
        sequence: recorded.length,
        type: event.type,
        emergencyId: event.emergencyId ?? null,
        entityType: event.entityType ?? null,
        entityId: event.entityId ?? null,
        timestamp: new Date().toISOString(),
        actorType: event.actorType ?? null,
        actorId: event.actorId ?? null,
        payload: event.payload,
        metadata: null,
      };
    },
    recordMany: async (events: SystemEventEnvelope[]) => events.map((e) => e as unknown as SystemEventRecord),
    recordInTransaction: async () => {
      throw new Error('recordInTransaction is not used by this route');
    },
  } as unknown as EventPublisherPort;

  const fetchImpl = options.fetchImpl ?? vi.fn(async () => new Response('{}', { status: 500 }));

  const service = new EmergencyClassificationService({
    classifier: new Module3Classifier({
      baseUrl: 'http://module3.test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 50,
      logger: noopLogger,
    }),
    emergencies: {
      findById: async (id: string) =>
        options.emergencyExists === false ? null : { id, isSimulation: false },
    },
    calls: {
      requireSessionFor: async () => ({ id: 'CALL-1' }),
      transcriptsFor: async () => options.transcripts ?? [],
    },
    events,
    logger: noopLogger,
    enabled: options.enabled ?? true,
  });

  const route = createNlpClassifyRoutes(service)[0]!;

  const run = async (body: ClassifyBody = {}, params: Record<string, string> = { id: 'EMG-1' }) => {
    let sent: unknown;
    const reply = {
      status() {
        return reply;
      },
      header() {
        return reply;
      },
      send(payload: unknown) {
        sent = payload;
      },
    };
    await route.handler(
      { params, body, user: { userId: 'U1', role: 'OPERATOR', email: 'op@resus.local' } } as never,
      reply as never,
    );
    return sent;
  };

  return { run, recorded, fetchImpl };
}

async function captureError(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (isAppError(error)) return error;
    throw error;
  }
  throw new Error('expected the call to reject');
}

describe('POST /api/emergencies/:id/classify', () => {
  it('is not mounted when disabled and refuses without calling Module 3', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(CARDIAC), { status: 200 }));
    const h = harness({ enabled: false, fetchImpl });

    const error = await captureError(h.run());
    expect(error.code).toBe('PROVIDER_NOT_CONFIGURED');
    expect(error.statusCode).toBe(503);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('404s for an unknown emergency', async () => {
    const h = harness({ emergencyExists: false });
    const error = await captureError(h.run({}, { id: 'EMG-missing' }));
    expect(error.statusCode).toBe(404);
  });

  it('422s when no transcript text is available', async () => {
    const h = harness({ transcripts: [] });
    const error = await captureError(h.run());
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.statusCode).toBe(422);
  });

  it('uses the latest final transcript when none is supplied', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(CARDIAC), { status: 200 }));
    const h = harness({
      fetchImpl,
      transcripts: [
        { text: 'partial', isFinal: false, sequence: 1, speaker: 'CALLER' },
        { text: 'first final', isFinal: true, sequence: 2, speaker: 'CALLER' },
        { text: 'second final', isFinal: true, sequence: 3, speaker: 'CALLER' },
      ],
    });

    const sent = await h.run();
    expect((sent as { extraction: { category: string } }).extraction.category).toBe('CARDIAC');
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    expect(body.transcript_text).toBe('second final');
  });

  it('records NLP_EXTRACTION_COMPLETED and never EMERGENCY_CLASSIFIED on success', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(CARDIAC), { status: 200 }));
    const h = harness({ fetchImpl });

    const sent = await h.run({ transcriptText: 'help' });

    expect(h.recorded).toHaveLength(1);
    const event = h.recorded[0]!;
    expect(event.type).toBe('NLP_EXTRACTION_COMPLETED');
    expect(event.emergencyId).toBe('EMG-1');
    expect(event.payload).toMatchObject({
      emergencyId: 'EMG-1',
      incidentType: 'CARDIAC',
      severity: 'P1',
      confidence: 0.9,
      degraded: false,
    });
    expect(h.recorded.some((e) => e.type === 'EMERGENCY_CLASSIFIED')).toBe(false);
    expect(h.recorded.some((e) => ['PROTOCOL_STARTED', 'PROTOCOL_STEP_COMPLETED', 'AMBULANCE_DISPATCHED'].includes(e.type))).toBe(false);
    expect((sent as { emergencyId: string }).emergencyId).toBe('EMG-1');
  });

  it('rejects an explicitly partial transcript before calling Module 3 or recording events', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(CARDIAC), { status: 200 }));
    const h = harness({ fetchImpl });

    const error = await captureError(h.run({ transcriptText: 'he is not…', isFinalChunk: false }));

    expect(error.statusCode).toBe(422);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(h.recorded).toHaveLength(0);
  });

  it('records a degraded extraction truthfully', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(FALLBACK), { status: 200 }));
    const h = harness({ fetchImpl });

    await h.run({ transcriptText: 'help' });

    expect(h.recorded).toHaveLength(1);
    expect(h.recorded[0]!.type).toBe('NLP_EXTRACTION_COMPLETED');
    expect((h.recorded[0]!.payload as { degraded: boolean }).degraded).toBe(true);
  });

  it('records NLP_EXTRACTION_REJECTED and maps an HTTP failure to 502', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }));
    const h = harness({ fetchImpl });

    const error = await captureError(h.run({ transcriptText: 'help' }));

    expect(h.recorded).toHaveLength(1);
    expect(h.recorded[0]!.type).toBe('NLP_EXTRACTION_REJECTED');
    expect(error.code).toBe('LLM_UNAVAILABLE');
    expect(error.statusCode).toBe(502);
  });

  it('maps an unreachable service to 503 and records rejection', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const h = harness({ fetchImpl });

    const error = await captureError(h.run({ transcriptText: 'help' }));

    expect(error.code).toBe('LLM_UNAVAILABLE');
    expect(error.statusCode).toBe(503);
    expect(h.recorded[0]!.type).toBe('NLP_EXTRACTION_REJECTED');
  });

  it('maps a timeout to 504 and records rejection', async () => {
    const fetchImpl = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        }),
    );
    const h = harness({ fetchImpl: fetchImpl as unknown as ReturnType<typeof vi.fn>, transcripts: [] });

    const error = await captureError(h.run({ transcriptText: 'help' }));

    expect(error.code).toBe('LLM_TIMEOUT');
    expect(error.statusCode).toBe(504);
    expect(h.recorded[0]!.type).toBe('NLP_EXTRACTION_REJECTED');
  });
});
