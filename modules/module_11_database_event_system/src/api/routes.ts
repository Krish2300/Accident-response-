import { z } from 'zod';
import {
  SYSTEM_EVENT_TYPES,
  OUTCOME_CORRECTION_REASON_CODES,
  OUTCOME_ELIGIBILITY_DECISIONS,
  OUTCOME_REVIEW_DECISIONS,
  OUTCOME_REVIEW_REASON_CODES,
  AppError,
  ErrorCode,
  incidentTypeSchema,
  isSystemEventType,
  outcomeStatusSchema,
  paginated,
  type RouteDefinition,
} from '@resus/core';
import type { Module11 } from '../module.js';
import type { LifecycleMilestoneType } from '../repositories/emergencyRepository.js';
import { OUTCOME_ACCESS_CAPABILITIES, type OutcomeScopeCapability } from '../repositories/protocolRepository.js';

const listEventsQuery = z.object({
  emergencyId: z.string().optional(),
  entityId: z.string().optional(),
  // Fastify's query parser represents a comma-delimited value as an array.
  // Normalize that parsed form as well as the documented CSV form before
  // filtering event types, so clients can use the same query contract.
  types: z
    .preprocess(
      (value) => Array.isArray(value) && value.every((item) => typeof item === 'string')
        ? value.join(',')
        : value,
      z.string().optional(),
    )
    .transform((value) =>
      value
        ? value
            .split(',')
            .map((item) => item.trim())
            .filter((item) => isSystemEventType(item))
        : undefined,
    ),
  sinceSequence: z.coerce.number().int().nonnegative().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const createEmergencyBody = z.object({
  incidentType: incidentTypeSchema,
  severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  description: z.string().max(2000).nullish(),
  callerId: z.string().max(64).nullish(),
  address: z.string().max(300).nullish(),
  isSimulation: z.boolean().default(false),
  /** Optional immediate classification. */
  classify: z.boolean().default(false),
  classificationConfidence: z.number().min(0).max(1).optional(),
});

const updateEmergencyBody = z.object({
  status: z
    .enum([
      'CREATED',
      'CALL_ACTIVE',
      'CLASSIFIED',
      'PROTOCOL_ACTIVE',
      'AWAITING_AMBULANCE',
      'AMBULANCE_ASSIGNED',
      'EN_ROUTE',
      'ON_SCENE',
      'PATIENT_ONBOARD',
      'TRANSPORTING',
      'AT_HOSPITAL',
      'COMPLETED',
      'CANCELLED',
    ])
    .optional(),
  severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']).optional(),
  /**
   * An operator-reviewed, normalized classification for an existing emergency.
   * Module 3 candidate vocabulary is never accepted as authoritative input here.
   */
  normalizedClassification: z
    .object({
      incidentType: incidentTypeSchema,
      severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']),
      confidence: z.number().min(0).max(1).default(1),
    })
    .optional(),
  description: z.string().max(2000).nullish(),
  selectedHospitalId: z.string().nullish(),
}).superRefine((body, context) => {
  if (body.normalizedClassification && (body.status !== undefined || body.severity !== undefined)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Use normalizedClassification alone for an operator classification decision.',
      path: ['normalizedClassification'],
    });
  }
});

const outcomeAssertionBody = z.object({
  category: outcomeStatusSchema,
  categoryVersion: z.literal('OUTCOME_V1'),
  survivalToDischarge: z.boolean().nullable().optional(),
  observedAt: z.string().datetime({ offset: true }).nullable().optional(),
  evidenceRefs: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/)).max(32).nullable().optional(),
}).strict();

const outcomeCorrectionBody = outcomeAssertionBody.extend({
  correctionReasonCode: z.enum(OUTCOME_CORRECTION_REASON_CODES),
}).strict();

const outcomeReviewBody = z.object({
  decision: z.enum(OUTCOME_REVIEW_DECISIONS),
  reasonCode: z.enum(OUTCOME_REVIEW_REASON_CODES).optional(),
  eligibilityDecision: z.enum(OUTCOME_ELIGIBILITY_DECISIONS),
  eligibilityReasonCode: z.enum(OUTCOME_REVIEW_REASON_CODES),
  supersedesReviewId: z.string().min(1).max(128).optional(),
}).strict().superRefine((body, context) => {
  if (body.decision !== 'APPROVED' && !body.reasonCode) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Rejected or deferred reviews require a reason code.', path: ['reasonCode'] });
  }
});

const outcomeHistoryQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

const outcomeParams = z.object({ id: z.string().min(1).max(128) });
const outcomeReviewParams = z.object({ id: z.string().min(1).max(128), outcomeId: z.string().min(1).max(128) });
const lifecycleMilestoneParams = z.object({
  id: z.string().min(1).max(128),
  milestone: z.enum(['scene-arrival', 'patient-onboard', 'hospital-arrival', 'operational-completion']),
});
const lifecycleMilestoneTypes = {
  'scene-arrival': 'AMBULANCE_ARRIVED_SCENE',
  'patient-onboard': 'PATIENT_ONBOARD',
  'hospital-arrival': 'AMBULANCE_ARRIVED_HOSPITAL',
  'operational-completion': 'EMERGENCY_COMPLETED',
} as const satisfies Record<z.infer<typeof lifecycleMilestoneParams>['milestone'], LifecycleMilestoneType>;

const submitterRoles = ['OUTCOME_SUBMITTER'] as const;
const reviewerRoles = ['OUTCOME_REVIEWER'] as const;
const outcomeReadRoles = ['OUTCOME_SUBMITTER', 'OUTCOME_REVIEWER'] as const;
const grantManagerRoles = ['ADMIN'] as const;

const outcomeGrantParams = z.object({
  id: z.string().min(1).max(128),
  grantId: z.string().min(1).max(128),
});
const outcomeGrantBody = z.object({
  granteeUserId: z.string().min(1).max(128),
  capability: z.enum(OUTCOME_ACCESS_CAPABILITIES),
}).strict();

/**
 * Optional bounded revocation reason. Trimmed first so whitespace-only input
 * fails `min(1)`; not mandatory, matching the nullable column and Stage 4.26
 * behavior. Parsed in the handler (not declared as the Fastify body schema)
 * so bodyless DELETE requests from existing clients keep working.
 */
const revokeGrantBody = z.object({
  revokeReason: z.string().trim().min(1).max(500).optional(),
}).strict();

/** Shared bounded pagination for the ADMIN grant-list and grant-audit reads. */
const outcomeGrantPageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

/**
 * Module 11 HTTP surface.
 *
 * `GET /api/events`, `GET /api/events/:id`, `GET /api/emergencies/:id/events`
 * are the event log endpoints. The emergency intake endpoints exist because
 * every workflow in the specification starts with a created emergency; in a
 * larger deployment this moves to the call-intake module unchanged.
 */
export function createModule11Routes(
  module11: Module11,
  options: { nodeEnv?: 'development' | 'test' | 'production' } = {},
): RouteDefinition<any>[] {
  const { emergencies, events, calls } = module11;

  return [
    {
      method: 'GET',
      url: '/api/events',
      module: 'module_11',
      summary: 'Query the append-only system event log',
      auth: { roles: ['OPERATOR', 'DISPATCHER', 'CLINICAL_SUPERVISOR', 'ADMIN'] },
      query: listEventsQuery,
      handler: async (request, reply) => {
        const query = listEventsQuery.parse(request.query);
        const result = await events.list({
          emergencyId: query.emergencyId,
          entityId: query.entityId,
          types: query.types as never,
          sinceSequence: query.sinceSequence,
          since: query.since,
          until: query.until,
          limit: query.limit,
          offset: query.offset,
        });
        return reply.send({
          items: result.items,
          total: result.total,
          limit: query.limit ?? 100,
          offset: query.offset ?? 0,
          latestSequence: result.latestSequence,
        });
      },
    },
    {
      method: 'GET',
      url: '/api/events/types',
      module: 'module_11',
      summary: 'Event type vocabulary',
      auth: { public: true },
      handler: async (_request, reply) => reply.send({ types: SYSTEM_EVENT_TYPES }),
    },
    {
      method: 'GET',
      url: '/api/events/:id',
      module: 'module_11',
      summary: 'Fetch a single event by id',
      auth: { roles: ['OPERATOR', 'DISPATCHER', 'CLINICAL_SUPERVISOR', 'ADMIN'] },
      handler: async (request, reply) => {
        const id = String(request.params.id ?? '');
        const event = await events.getById(id);
        if (!event) throw AppError.notFound('Event', id);
        return reply.send(event);
      },
    },
    {
      method: 'GET',
      url: '/api/emergencies/:id/events',
      module: 'module_11',
      summary: 'Ordered timeline of one emergency (derived from the event log)',
      auth: { roles: ['OPERATOR', 'DISPATCHER', 'CLINICAL_SUPERVISOR', 'ADMIN'] },
      handler: async (request, reply) => {
        const id = String(request.params.id ?? '');
        await emergencies.requireById(id);
        return reply.send({ emergencyId: id, events: await events.timeline(id) });
      },
    },
    {
      method: 'GET',
      url: '/api/emergencies',
      module: 'module_11',
      summary: 'List emergencies',
      auth: { roles: ['OPERATOR', 'DISPATCHER', 'CLINICAL_SUPERVISOR', 'ADMIN'] },
      query: z.object({
        status: z.string().optional(),
        includeSimulation: z.coerce.boolean().default(false),
        limit: z.coerce.number().int().min(1).max(200).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      }),
      handler: async (request, reply) => {
        const query = request.query as { status?: string; includeSimulation?: boolean; limit?: number; offset?: number };
        const items = await emergencies.list({
          statuses: query.status ? query.status.split(',') : undefined,
          includeSimulation: query.includeSimulation,
          limit: query.limit,
          offset: query.offset,
        });
        return reply.send(
          paginated(items, items.length, query.limit ?? 100, query.offset ?? 0),
        );
      },
    },
    {
      method: 'GET',
      url: '/api/emergencies/:id',
      module: 'module_11',
      summary: 'Read one emergency',
      auth: { roles: ['OPERATOR', 'DISPATCHER', 'CLINICAL_SUPERVISOR', 'ADMIN'] },
      handler: async (request, reply) => reply.send(await emergencies.requireById(String(request.params.id ?? ''))),
    },
    {
      method: 'POST',
      url: '/api/emergencies',
      module: 'module_11',
      summary: 'Create an emergency (writes the row and the EMERGENCY_CREATED event in one transaction)',
      auth: { roles: ['OPERATOR', 'DISPATCHER', 'ADMIN'] },
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
          actor: { actorType: 'OPERATOR', actorId: request.user?.userId ?? null },
        });

        // A call session is opened for every emergency so transcripts have a home.
        const call = await calls.startSession({
          emergencyId: emergency.id,
          callerId: body.callerId ?? null,
          isSimulation: body.isSimulation,
        });

        let classified = emergency;
        if (body.classify) {
          classified = await emergencies.setStatus(
            emergency.id,
            'CLASSIFIED',
            {
              type: 'EMERGENCY_CLASSIFIED',
              payload: {
                incidentType: body.incidentType,
                severity: body.severity,
                confidence: body.classificationConfidence ?? 1,
                source: 'OPERATOR',
              },
            },
            { actorType: 'OPERATOR', actorId: request.user?.userId ?? null },
          );
        }

        return reply.status(201).send({ emergency: classified, callSession: call });
      },
    },
    {
      method: 'PATCH',
      url: '/api/emergencies/:id',
      module: 'module_11',
      summary: 'Operator update or explicit normalized classification of an emergency',
      auth: { roles: ['OPERATOR', 'DISPATCHER', 'ADMIN'] },
      body: updateEmergencyBody,
      handler: async (request, reply) => {
        const id = String(request.params.id ?? '');
        const body = updateEmergencyBody.parse(request.body);
        if (body.normalizedClassification) {
          const current = await emergencies.requireById(id);
          const classification = body.normalizedClassification;
          const shouldMarkClassified = current.status === 'CREATED' || current.status === 'CALL_ACTIVE';
          const emergency = await emergencies.update(
            id,
            {
              incidentType: classification.incidentType,
              severity: classification.severity,
              ...(shouldMarkClassified ? { status: 'CLASSIFIED' } : {}),
              description: body.description,
              selectedHospitalId: body.selectedHospitalId,
            },
            {
              type: 'EMERGENCY_CLASSIFIED',
              payload: {
                incidentType: classification.incidentType,
                severity: classification.severity,
                confidence: classification.confidence,
                source: 'OPERATOR',
              },
            },
            { actorType: 'OPERATOR', actorId: request.user?.userId ?? null },
          );
          return reply.send(emergency);
        }
        const emergency = await emergencies.update(
          id,
          {
            status: body.status,
            severity: body.severity,
            description: body.description,
            selectedHospitalId: body.selectedHospitalId,
          },
          body.status
            ? {
                type: 'EMERGENCY_STATUS_CHANGED',
                payload: { from: (await emergencies.requireById(id)).status, to: body.status, source: 'OPERATOR' },
              }
            : undefined,
          { actorType: 'OPERATOR', actorId: request.user?.userId ?? null },
        );
        return reply.send(emergency);
      },
    },
    {
      method: 'GET',
      url: '/api/emergencies/:id/transcripts',
      module: 'module_11',
      summary: 'Verbatim call transcript for an emergency',
      auth: { roles: ['OPERATOR', 'DISPATCHER', 'CLINICAL_SUPERVISOR', 'ADMIN'] },
      handler: async (request, reply) => {
        const id = String(request.params.id ?? '');
        await emergencies.requireById(id);
        return reply.send({ emergencyId: id, transcripts: await calls.transcriptsFor(id) });
      },
    },
    {
      method: 'POST',
      url: '/api/emergencies/:id/lifecycle-milestones/:milestone',
      module: 'module_11',
      summary: 'Record an explicit operator-reported operational lifecycle milestone',
      auth: { roles: ['OPERATOR', 'DISPATCHER', 'ADMIN'] },
      params: lifecycleMilestoneParams,
      handler: async (request, reply) => {
        const { id, milestone } = lifecycleMilestoneParams.parse(request.params);
        const result = await emergencies.recordLifecycleMilestone({
          emergencyId: id,
          milestone: lifecycleMilestoneTypes[milestone],
          actorId: request.user!.userId,
          actorRole: request.user!.role,
        });
        return reply.status(result.duplicate ? 200 : 201).send({
          event: result.event,
          duplicate: result.duplicate,
          evidenceSource: 'OPERATOR_REPORTED',
          operationalOnly: true,
        });
      },
    },
    {
      method: 'POST',
      url: '/api/emergencies/:id/outcomes',
      module: 'module_11',
      summary: 'Append an outcome assertion for independent review',
      auth: { roles: [...submitterRoles] },
      params: outcomeParams,
      body: outcomeAssertionBody,
      handler: async (request, reply) => {
        const { id } = outcomeParams.parse(request.params);
        const body = outcomeAssertionBody.parse(request.body);
        const idempotencyKey = readIdempotencyKey(request.headers);
        const emergency = await emergencies.requireById(id);
        await requireOutcomeScope(module11, request.user!.userId, id, 'SUBMIT');
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
          submittedByUserId: request.user!.userId,
          idempotencyKey,
        });
        const reviewStatus = await module11.outcomes.reviewStatusForAssertion(id, assertion.id);
        return reply.status(201).send(publicAssertion(assertion, reviewStatus ?? 'PENDING'));
      },
    },
    {
      method: 'GET',
      url: '/api/emergencies/:id/outcomes',
      module: 'module_11',
      summary: 'Read append-only outcome assertion and review history',
      auth: { roles: [...outcomeReadRoles] },
      params: outcomeParams,
      query: outcomeHistoryQuery,
      handler: async (request, reply) => {
        const { id } = outcomeParams.parse(request.params);
        const query = outcomeHistoryQuery.parse(request.query);
        await emergencies.requireById(id);
        await requireOutcomeScope(module11, request.user!.userId, id, 'READ');
        const history = await module11.outcomes.historyForEmergency(id, query.limit, query.offset);
        const legacyOutcome = await module11.outcomes.forEmergency(id);
        return reply.send({
          emergencyId: id,
          items: history.items.map((record) => ({
            ...publicAssertion(record, record.reviewStatus),
            isCurrent: record.isCurrent,
            predecessorId: record.predecessorId,
            successorId: record.successorId,
            reviews: record.reviews.map(publicReview),
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
            classification: 'UNVERIFIED_LEGACY' as const,
          } : null,
        });
      },
    },
    {
      method: 'POST',
      url: '/api/emergencies/:id/outcomes/:outcomeId/reviews',
      module: 'module_11',
      summary: 'Append an independent outcome review decision',
      auth: { roles: [...reviewerRoles] },
      params: outcomeReviewParams,
      body: outcomeReviewBody,
      handler: async (request, reply) => {
        const { id, outcomeId } = outcomeReviewParams.parse(request.params);
        const body = outcomeReviewBody.parse(request.body);
        const idempotencyKey = readIdempotencyKey(request.headers);
        await emergencies.requireById(id);
        await requireOutcomeScope(module11, request.user!.userId, id, 'REVIEW');
        const assertion = await module11.outcomes.assertionForEmergency(id, outcomeId);
        if (!assertion) throw AppError.notFound('Outcome assertion', outcomeId);
        const eligibleForLearning = body.eligibilityDecision === 'ELIGIBLE';
        if (eligibleForLearning && (
          body.decision !== 'APPROVED' || assertion.dataClassification !== 'OPERATIONAL' ||
          assertion.provenance !== 'REAL_OBSERVED' || !['SURVIVED_TO_DISCHARGE', 'DECEASED'].includes(assertion.category)
        )) throw AppError.validation('Only an approved operational survival outcome with verified provenance may be marked learning eligible.');
        const review = await module11.outcomes.recordReview({
          outcomeRecordId: outcomeId,
          reviewerUserId: request.user!.userId,
          decision: body.decision,
          reviewReasonCode: body.reasonCode,
          eligibleForLearning,
          eligibilityReasonCode: body.eligibilityReasonCode,
          idempotencyKey,
          supersedesReviewId: body.supersedesReviewId,
        });
        const history = await module11.outcomes.historyForEmergency(id, 200, 0);
        const reviewedAssertion = history.items.find((item) => item.id === outcomeId);
        return reply.status(201).send({
          review: publicReview(review),
          reviewStatus: reviewedAssertion?.reviewStatus ?? review.decision,
          reviews: reviewedAssertion?.reviews.map(publicReview) ?? [publicReview(review)],
        });
      },
    },
    {
      method: 'POST',
      url: '/api/emergencies/:id/outcomes/:outcomeId/supersessions',
      module: 'module_11',
      summary: 'Append a corrected outcome assertion that supersedes an earlier assertion',
      auth: { roles: [...submitterRoles] },
      params: outcomeReviewParams,
      body: outcomeCorrectionBody,
      handler: async (request, reply) => {
        const { id, outcomeId } = outcomeReviewParams.parse(request.params);
        const body = outcomeCorrectionBody.parse(request.body);
        const idempotencyKey = readIdempotencyKey(request.headers);
        const emergency = await emergencies.requireById(id);
        await requireOutcomeScope(module11, request.user!.userId, id, 'SUBMIT');
        if (!await module11.outcomes.assertionForEmergency(id, outcomeId)) {
          throw AppError.notFound('Outcome assertion', outcomeId);
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
          submittedByUserId: request.user!.userId,
          idempotencyKey,
          supersedesOutcomeId: outcomeId,
        });
        const reviewStatus = await module11.outcomes.reviewStatusForAssertion(id, assertion.id);
        return reply.status(201).send(publicAssertion(assertion, reviewStatus ?? 'PENDING'));
      },
    },
    {
      method: 'POST',
      url: '/api/emergencies/:id/outcome-grants',
      module: 'module_11',
      summary: 'Grant an emergency-scoped outcome capability to a user',
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
          grantedByUserId: request.user!.userId,
        });
        return reply.status(201).send(publicGrant(grant));
      },
    },
    {
      method: 'DELETE',
      url: '/api/emergencies/:id/outcome-grants/:grantId',
      module: 'module_11',
      summary: 'Revoke an emergency-scoped outcome capability grant',
      auth: { roles: [...grantManagerRoles] },
      params: outcomeGrantParams,
      handler: async (request, reply) => {
        const { id, grantId } = outcomeGrantParams.parse(request.params);
        const parsedBody = revokeGrantBody.safeParse(request.body ?? {});
        if (!parsedBody.success) {
          throw AppError.validation('The request did not match the expected shape.', { issues: parsedBody.error.issues });
        }
        await emergencies.requireById(id);
        const grant = await module11.outcomes.revokeGrant(grantId, id, request.user!.userId, parsedBody.data.revokeReason ?? null);
        if (!grant) throw AppError.notFound('Outcome access grant', grantId);
        return reply.send(publicGrant(grant));
      },
    },
    {
      method: 'GET',
      url: '/api/emergencies/:id/outcome-grant-events',
      module: 'module_11',
      summary: 'ADMIN-only audit history of outcome access grant lifecycle events',
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
          offset: query.offset ?? 0,
        });
      },
    },
    {
      method: 'GET',
      url: '/api/emergencies/:id/outcome-grants',
      module: 'module_11',
      summary: 'ADMIN-only list of current outcome access grant rows for one emergency',
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
          offset: query.offset ?? 0,
        });
      },
    },
  ];
}

async function requireOutcomeScope(
  module11: Module11,
  userId: string,
  emergencyId: string,
  capability: OutcomeScopeCapability,
): Promise<void> {
  if (!(await module11.outcomes.hasEmergencyAccess(userId, emergencyId, capability))) {
    throw new AppError(ErrorCode.FORBIDDEN, 'You are not authorized to access outcome records for this emergency.', 403);
  }
}

function readIdempotencyKey(headers: Record<string, unknown>): string {
  const value = headers['idempotency-key'] ?? headers['Idempotency-Key'];
  if (typeof value !== 'string' || value.length < 8 || value.length > 200) {
    throw AppError.validation('A valid Idempotency-Key header is required.');
  }
  return value;
}

function outcomeDataClassification(isSimulation: boolean, nodeEnv = process.env.NODE_ENV): {
  dataClassification: 'OPERATIONAL' | 'SIMULATION' | 'TEST';
  provenance: 'REAL_OBSERVED' | 'SIMULATION';
} {
  if (isSimulation) return { dataClassification: 'SIMULATION', provenance: 'SIMULATION' };
  // NODE_ENV is server-controlled and lets isolated test runs mark all their
  // records as synthetic. It is never accepted from the request body.
  if (nodeEnv === 'test') return { dataClassification: 'TEST', provenance: 'SIMULATION' };
  return { dataClassification: 'OPERATIONAL', provenance: 'REAL_OBSERVED' };
}

function publicAssertion(
  assertion: {
    id: string; emergencyId: string; category: string; categoryVersion: string;
    provenance: string; dataClassification: string; survivalToDischarge: boolean | null;
    observedAt: string | null; recordedAt: string; submittedByUserId: string | null;
    evidenceRefs: string[] | null; correctionReasonCode: string | null; supersedesOutcomeId: string | null;
  },
  reviewStatus: string,
) {
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
    reviewStatus,
  };
}

function publicReview(review: {
  id: string; outcomeRecordId: string; reviewerUserId: string; decision: string;
  reviewReasonCode: string | null; reviewedAt: string; eligibleForLearning: boolean; eligibilityReasonCode: string;
  supersedesReviewId: string | null; isCurrent?: boolean;
}) {
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
    ...(review.isCurrent === undefined ? {} : { isCurrent: review.isCurrent }),
  };
}

function publicGrant(grant: {
  id: string; emergencyId: string; granteeUserId: string; capability: string;
  grantedByUserId: string; createdAt: string; revokedAt: string | null;
  revokedByUserId: string | null; revokeReason: string | null;
}) {
  return {
    id: grant.id,
    emergencyId: grant.emergencyId,
    granteeUserId: grant.granteeUserId,
    capability: grant.capability,
    grantedByUserId: grant.grantedByUserId,
    createdAt: grant.createdAt,
    revokedAt: grant.revokedAt,
    revokedByUserId: grant.revokedByUserId,
    revokeReason: grant.revokeReason,
  };
}
