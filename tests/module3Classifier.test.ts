import { describe, expect, it, vi } from 'vitest';
import { noopLogger } from '@resus/core';
import { Module3Classifier } from '../apps/server/src/nlp/module3Classifier.js';

/**
 * Adapter tests for the Module 3 HTTP client.
 *
 * These drive the real adapter with an injected `fetch`, so every branch of the
 * transport boundary — success, fallback, non-2xx, malformed body, schema
 * mismatch, timeout and unreachable host — is exercised without a running Python
 * service. They prove the adapter's behaviour, not Module 3's model output.
 */

const VALID_EXTRACTION = {
  session_id: 'CALL-1',
  extraction_id: 'EXT-1',
  extracted_at: '2026-01-01T00:00:00Z',
  incident_category: 'CARDIAC',
  severity: {
    level: 'P1',
    numeric_score: 10,
    rationale: 'Unconscious and apneic.',
    key_risk_factors: ['unconscious', 'not_breathing'],
    cpr_required: true,
    aed_required: true,
  },
  caller_intent: 'Caller needs an ambulance immediately.',
  missing_fields: { location_missing: false },
  multilingual: { original_language: 'en' },
  extraction_confidence: 0.95,
  validation_warnings: [],
};

const FALLBACK_EXTRACTION = {
  session_id: 'CALL-2',
  incident_category: 'UNKNOWN',
  severity: { level: 'P2', numeric_score: 6, cpr_required: false },
  missing_fields: { location_missing: true },
  extraction_confidence: 0,
  validation_warnings: ['FALLBACK TRIGGERED: unexpected: TypeError'],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function classifier(fetchImpl: typeof fetch, timeoutMs = 1_000): Module3Classifier {
  return new Module3Classifier({
    baseUrl: 'http://module3.test',
    timeoutMs,
    fetchImpl,
    logger: noopLogger,
  });
}

describe('Module3Classifier', () => {
  it('maps a valid extraction and preserves Module 3 vocabulary verbatim', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(VALID_EXTRACTION));
    const result = await classifier(fetchImpl as unknown as typeof fetch).classify({
      emergencyId: 'EMG-1',
      sessionId: 'CALL-1',
      transcriptText: 'My father collapsed and is not breathing.',
      language: 'en',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.extraction).toMatchObject({
      emergencyId: 'EMG-1',
      sessionId: 'CALL-1',
      category: 'CARDIAC',
      severityLevel: 'P1',
      severityScore: 10,
      confidence: 0.95,
      cprRequired: true,
      degraded: false,
    });
  });

  it('sends the transcript and a forced final chunk to /extract', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(VALID_EXTRACTION));
    await classifier(fetchImpl as unknown as typeof fetch).classify({
      emergencyId: 'EMG-1',
      sessionId: 'CALL-1',
      transcriptText: 'help',
      language: 'ml',
    });

    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe('http://module3.test/extract');
    expect(call[1].method).toBe('POST');
    const body = JSON.parse(call[1].body as string);
    expect(body).toMatchObject({
      session_id: 'CALL-1',
      transcript_text: 'help',
      detected_language: 'ml',
      is_final_chunk: true,
    });
  });

  it('flags the module fallback as degraded instead of a real classification', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(FALLBACK_EXTRACTION));
    const result = await classifier(fetchImpl as unknown as typeof fetch).classify({
      emergencyId: 'EMG-2',
      sessionId: 'CALL-2',
      transcriptText: 'help',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.extraction.degraded).toBe(true);
    expect(result.extraction.category).toBe('UNKNOWN');
    expect(result.extraction.warnings[0]).toContain('FALLBACK TRIGGERED');
  });

  it('reports HTTP errors with the status and never parses the body as a result', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }));
    const result = await classifier(fetchImpl as unknown as typeof fetch).classify({
      emergencyId: 'EMG-3',
      sessionId: 'CALL-3',
      transcriptText: 'help',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('HTTP_ERROR');
    expect(result.status).toBe(500);
  });

  it('reports malformed JSON as MALFORMED', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('not-json', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const result = await classifier(fetchImpl as unknown as typeof fetch).classify({
      emergencyId: 'EMG-4',
      sessionId: 'CALL-4',
      transcriptText: 'help',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('MALFORMED');
  });

  it('reports a response missing required fields as MALFORMED', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ incident_category: 'CARDIAC' }));
    const result = await classifier(fetchImpl as unknown as typeof fetch).classify({
      emergencyId: 'EMG-5',
      sessionId: 'CALL-5',
      transcriptText: 'help',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('MALFORMED');
    expect(result.details).toBeDefined();
  });

  it('reports an unreachable service as UNAVAILABLE', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const result = await classifier(fetchImpl as unknown as typeof fetch).classify({
      emergencyId: 'EMG-6',
      sessionId: 'CALL-6',
      transcriptText: 'help',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('UNAVAILABLE');
    expect(result.reason).toContain('ECONNREFUSED');
  });

  it('aborts a slow request and reports TIMEOUT', async () => {
    const fetchImpl = (_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });

    const result = await classifier(fetchImpl as unknown as typeof fetch, 20).classify({
      emergencyId: 'EMG-7',
      sessionId: 'CALL-7',
      transcriptText: 'help',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('TIMEOUT');
  });

  it.each([
    { status: 200, description: 'success JSON' },
    { status: 500, description: 'error excerpt' },
  ])('keeps the timeout active while reading a slow $description body', async ({ status }) => {
    let bodyAborted = false;
    const fetchImpl = async (_url: unknown, init?: RequestInit): Promise<Response> =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener('abort', () => {
              bodyAborted = true;
              controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            });
          },
        }),
        { status },
      );

    const result = await classifier(fetchImpl as unknown as typeof fetch, 20).classify({
      emergencyId: 'EMG-SLOW-BODY',
      sessionId: 'CALL-SLOW-BODY',
      transcriptText: 'help',
    });

    expect(bodyAborted).toBe(true);
    expect(result).toMatchObject({ ok: false, kind: 'TIMEOUT' });
  });
});
