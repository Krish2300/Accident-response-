import { z } from 'zod';
import { RouteTable, type RouteDefinition } from '@resus/core';
import type { SpeakInput, SpeechService } from '../speechService.js';

/**
 * HTTP surface for Module 2.
 *
 * Audio cannot be sent as JSON without base64 inflating every request by a third,
 * so transcription and synthesis take the raw body with `Content-Type` deciding
 * how to read it. Both routes therefore authenticate but are not protected by a
 * schema on `body` — validating a binary body with zod would mean either buffering
 * it twice or guessing at the encoding.
 *
 * The transcription route is public for the same reason Module 1's call route is:
 * the audio comes from the call itself, from a caller who has no credentials. In a
 * deployment the telephony gateway authenticates the call leg and this route is
 * reachable only from that gateway; the `CALL_CENTRE` role restriction documents
 * the intent for an operator-facing build.
 */
const transcribeQuery = z.object({
  callSessionId: z.string().min(1),
  emergencyId: z.string().min(1),
  language: z.string().max(8).optional(),
  speaker: z.enum(['CALLER', 'BYSTANDER', 'OPERATOR']).optional(),
  isFinal: z.enum(['true', 'false']).optional(),
});

const speakSchema = z.object({
  emergencyId: z.string().min(1).nullable().optional(),
  callSessionId: z.string().min(1).nullable().optional(),
  text: z.string().min(1).max(4000),
  language: z.string().min(2).max(8),
  tone: z.enum(['CALM', 'URGENT', 'REASSURING']),
  // Required, not defaulted: the record must state whether this is the
  // catalogue's own wording or an approved paraphrase.
  verbatimProtocolText: z.boolean(),
});

export function createModule2Routes(service: SpeechService): RouteDefinition<any>[] {
  return [
    {
      method: 'POST',
      url: '/speech/transcribe',
      module: 'module_02',
      summary: 'Transcribe caller audio; final results are stored, interim results are not',
      auth: { roles: ['CALL_CENTRE', 'OPERATOR', 'ADMIN'] },
      // Metadata is a query schema rather than a body schema because the body is
      // raw audio: the route adapter hands `body` to Fastify for validation, so
      // declaring one here would reject every binary payload.
      query: transcribeQuery,
      handler: async (request, reply) => {
        const query = request.query as unknown as z.infer<typeof transcribeQuery>;
        const audio = readAudioBody(request.body);
        const result = await service.transcribe({
          callSessionId: query.callSessionId,
          emergencyId: query.emergencyId,
          audio,
          language: query.language,
          speaker: query.speaker,
          isFinal: query.isFinal === undefined ? true : query.isFinal === 'true',
        });
        // 202 when the utterance was heard but rejected: nothing is wrong with the
        // request, the audio simply was not usable.
        reply.status(result.accepted ? 200 : 202).send(result);
      },
    },
    {
      method: 'POST',
      url: '/speech/speak',
      module: 'module_02',
      summary: 'Synthesize text to speech for a caller',
      auth: { roles: ['CALL_CENTRE', 'OPERATOR', 'ADMIN'] },
      body: speakSchema,
      handler: async (request, reply) => {
        const input = request.body as z.infer<typeof speakSchema>;
        const result = await service.speak(input as unknown as SpeakInput);
        reply.status(200).send(result);
      },
    },
    {
      method: 'GET',
      url: '/speech/status',
      module: 'module_02',
      summary: 'Report the speech and synthesis providers, and whether they are live',
      auth: { public: true },
      handler: async (_request, reply) => {
        reply.send(service.status());
      },
    },
    {
      method: 'GET',
      url: '/speech/partial/:callSessionId',
      module: 'module_02',
      summary: 'Read the latest interim transcription for a call',
      auth: { roles: ['CALL_CENTRE', 'OPERATOR', 'ADMIN'] },
      params: z.object({ callSessionId: z.string().min(1) }),
      handler: async (request, reply) => {
        const { callSessionId } = request.params as { callSessionId: string };
        const speaker = String(request.query.speaker ?? 'CALLER') as 'CALLER';
        reply.send({ callSessionId, speaker, text: service.pendingPartial(callSessionId, speaker) });
      },
    },
  ];
}

/**
 * Reads the request body as audio.
 *
 * The route adapter validates the schema's scalar fields but leaves the raw body
 * in place, so a binary payload survives to here intact. Three shapes are
 * accepted, because "how do I post audio" is otherwise a question every client has
 * to answer differently:
 *
 *   - a raw binary body (`Content-Type: audio/wav`) — used in production
 *   - a plain string body — the development audio carrier
 *   - `{ audio: "<base64>" }` — convenient for JSON clients
 *
 * A shape that matches none of them yields an empty buffer, which the service
 * reports as a recorded EMPTY_AUDIO failure rather than crashing on a type error.
 */
function readAudioBody(body: unknown): Uint8Array {

  if (body instanceof Uint8Array) return body;
  if (Buffer.isBuffer(body)) return new Uint8Array(body);
  if (typeof body === 'string') return new TextEncoder().encode(body);

  if (body && typeof body === 'object') {
    const audio = (body as Record<string, unknown>).audio;
    if (typeof audio === 'string') {
      try {
        return new Uint8Array(Buffer.from(audio, 'base64'));
      } catch {
        return new Uint8Array(0);
      }
    }
  }

  return new Uint8Array(0);
}

export function registerModule2Routes(table: RouteTable, service: SpeechService): void {
  table.addAll(createModule2Routes(service));
}