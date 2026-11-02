import { AppError, type RouteDefinition } from '@resus/core';
import { z } from 'zod';
import type { Module10LifecycleObserver } from './observer';

const lifecycleParams = z.object({ id: z.string().min(1) });

/** Read-only server route following the existing /api/emergencies/:id/... convention. */
export function createModule10LifecycleRoutes(
  observer: Pick<Module10LifecycleObserver, 'getProjection'>,
): RouteDefinition[] {
  return [{
    method: 'GET',
    url: '/api/emergencies/:id/lifecycle',
    module: 'module_10',
    summary: 'Read observed lifecycle facts for an emergency',
    auth: { roles: ['OPERATOR', 'DISPATCHER', 'CLINICAL_SUPERVISOR', 'ADMIN'] },
    params: lifecycleParams,
    handler: async (request, reply) => {
      const { id } = lifecycleParams.parse(request.params);
      const projection = observer.getProjection(id);
      if (!projection) {
        // This is an expected absence, so serialize it here as 404. Other
        // thrown failures continue through the shared adapter's 5xx handling.
        const error = AppError.notFound('Lifecycle projection', id);
        return reply.status(error.statusCode).send({
          error: { code: error.code, message: error.message, details: error.details ?? null },
        });
      }
      return reply.send({ projection });
    },
  }];
}
