import { z } from 'zod';
import { AppError, type RouteDefinition } from '@resus/core';
import type { Module5 } from '../module.js';

const startSessionBody = z
  .object({
    emergencyId: z.string().min(1).max(64),
    /** Omit to auto-select a protocol from `incidentType`. */
    protocolId: z.string().min(1).max(64).optional(),
    version: z.string().min(1).max(32).optional(),
    incidentType: z.string().min(1).max(64).optional(),
    facts: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
    startedBy: z.string().max(64).optional(),
  })
  .refine((body) => Boolean(body.protocolId || body.incidentType), {
    message: 'Either protocolId or incidentType is required.',
    path: ['protocolId'],
  });

const utteranceBody = z.object({
  utterance: z.string().min(1).max(2000),
  forceEscalationReason: z.string().max(500).nullish(),
});

const cancelBody = z.object({
  reason: z.string().max(500).default('Cancelled by operator.'),
});

const escalateBody = z.object({
  reason: z.string().min(1).max(500),
});

const OPERATOR = ['OPERATOR', 'DISPATCHER', 'CLINICAL_SUPERVISOR', 'ADMIN'];

/**
 * Module 5 HTTP surface.
 *
 * The caller-facing turns are public (a bystander is not authenticated); every
 * operator action is authenticated. Replies always carry both the approved
 * protocol text and the speech, so a client can display the authoritative
 * instruction verbatim if it disagrees with the phrasing.
 */
export function createModule5Routes(module5: Module5): RouteDefinition<any>[] {
  const { sessions } = module5;

  return [
    {
      method: 'GET',
      url: '/api/protocols',
      module: 'module_05',
      summary: 'List every protocol in the versioned catalogue',
      auth: { public: true },
      handler: (_request, reply) => reply.send({ protocols: sessions.listProtocols() }),
    },
    {
      method: 'GET',
      url: '/api/protocols/:incidentType',
      module: 'module_05',
      summary: 'Protocols applicable to one incident type',
      auth: { public: true },
      handler: async (request, reply) =>
        reply.send({
          incidentType: String(request.params.incidentType ?? ''),
          protocols: sessions.protocolsForIncident(String(request.params.incidentType ?? '')),
        }),
    },
    {
      method: 'POST',
      url: '/api/protocol-sessions',
      module: 'module_05',
      summary: 'Start a bystander protocol session',
      auth: { public: true },
      body: startSessionBody,
      handler: async (request, reply) => {
        const body = startSessionBody.parse(request.body);
        return reply.status(201).send(await sessions.start(body));
      },
    },
    {
      method: 'GET',
      url: '/api/protocol-sessions/:id',
      module: 'module_05',
      summary: 'Read a session and its step history',
      auth: { public: true },
      handler: async (request, reply) => {
        const id = String(request.params.id ?? '');
        const found = await sessions.get(id).catch(() => null);
        if (!found) throw AppError.notFound('Protocol session', id);
        return reply.send(found);
      },
    },
    {
      method: 'GET',
      url: '/api/emergencies/:id/protocol-sessions',
      module: 'module_05',
      summary: 'Protocol sessions started for one emergency',
      auth: { roles: OPERATOR },
      handler: async (request, reply) =>
        reply.send({
          emergencyId: String(request.params.id ?? ''),
          sessions: await sessions.listForEmergency(String(request.params.id ?? '')),
        }),
    },
    {
      method: 'POST',
      url: '/api/protocol-sessions/:id/utterance',
      module: 'module_05',
      summary: 'Submit what the bystander said; returns the next authoritative instruction',
      auth: { public: true },
      body: utteranceBody,
      handler: async (request, reply) => {
        const body = utteranceBody.parse(request.body);
        return reply.send(
          await sessions.handleUtterance({
            sessionId: String(request.params.id ?? ''),
            utterance: body.utterance,
            forceEscalationReason: body.forceEscalationReason ?? null,
          }),
        );
      },
    },
    {
      method: 'POST',
      url: '/api/protocol-sessions/:id/escalate',
      module: 'module_05',
      summary: 'Operator override: hand the call to a human now',
      auth: { roles: OPERATOR },
      body: escalateBody,
      handler: async (request, reply) => {
        const body = escalateBody.parse(request.body);
        return reply.send(await sessions.escalate(String(request.params.id ?? ''), body.reason));
      },
    },
    {
      method: 'POST',
      url: '/api/protocol-sessions/:id/cancel',
      module: 'module_05',
      summary: 'Stop the protocol (professional help has arrived)',
      auth: { roles: OPERATOR },
      body: cancelBody,
      handler: async (request, reply) => {
        const body = cancelBody.parse(request.body);
        return reply.send(await sessions.cancel(String(request.params.id ?? ''), body.reason));
      },
    },
    {
      method: 'GET',
      url: '/api/health/llm',
      module: 'module_05',
      summary: 'Language-model availability and degradation state',
      auth: { public: true },
      handler: async (_request, reply) => reply.send(await module5.llm.health()),
    },
  ];
}
