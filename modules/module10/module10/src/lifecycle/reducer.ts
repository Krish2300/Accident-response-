import type { SystemEventRecord } from '@resus/core';
import { eventReference, mapLifecycleEvent } from './mapper';
import type {
  Module10LifecycleFactKey,
  Module10LifecycleFacts,
  Module10LifecycleProjection,
  Module10LifecycleState,
  Module10LifecycleDiagnosticLogger,
} from './types';

const STATE_RANK: Record<Module10LifecycleState, number> = {
  NO_LIFECYCLE_EVENT: 0,
  EMERGENCY_CREATED: 1,
  CALL_CONNECTED: 2,
  TRANSCRIPT_FINAL: 3,
  CLASSIFICATION_CONFIRMED: 4,
  AMBULANCE_ASSIGNED: 5,
  AMBULANCE_DISPATCHED: 6,
  HOSPITAL_SELECTED: 7,
  ROUTE_GENERATED: 8,
  CORRIDOR_ACTIVATED: 9,
  AMBULANCE_ARRIVED_SCENE: 10,
  PATIENT_ONBOARD: 11,
  AMBULANCE_ARRIVED_HOSPITAL: 12,
  OPERATIONAL_COMPLETION_RECORDED: 13,
};

export function reduceLifecycleProjection(
  current: Module10LifecycleProjection | undefined,
  event: SystemEventRecord,
  logger?: Module10LifecycleDiagnosticLogger,
): Module10LifecycleProjection | undefined {
  const mapped = mapLifecycleEvent(event, logger);
  if (!mapped) return current;

  const projection = current ?? {
    emergencyId: mapped.emergencyId,
    state: 'NO_LIFECYCLE_EVENT' as const,
    facts: {},
    processedEventIds: [],
    lastEventId: mapped.eventId,
    lastSequence: 0,
    anomalies: [],
  };
  if (projection.emergencyId !== mapped.emergencyId) {
    logger?.warn(
      { eventId: event.id, expectedEmergencyId: projection.emergencyId, actualEmergencyId: mapped.emergencyId },
      'Module 10 lifecycle projection ignored event for a different emergencyId',
    );
    return current;
  }
  if (projection.processedEventIds.includes(mapped.eventId)) return projection;

  const fact = { ...mapped.fact, event: eventReference(event) } as Module10LifecycleFacts[Module10LifecycleFactKey];
  const previousFact = projection.facts[mapped.factKey] as { event?: { sequence?: number } } | undefined;
  const facts = previousFact?.event?.sequence !== undefined && previousFact.event.sequence > mapped.sequence
    ? projection.facts
    : { ...projection.facts, [mapped.factKey]: fact } as Module10LifecycleFacts;
  const anomalies = [...projection.anomalies];
  if (mapped.factKey === 'corridor' && !projection.facts.route) {
    anomalies.push({ code: 'MISSING_PREDECESSOR', eventId: mapped.eventId, missingFact: 'route' });
  }
  const missingPredecessor: Partial<Record<Module10LifecycleFactKey, 'ambulanceDispatch' | 'sceneArrival' | 'patientOnboard' | 'hospitalArrival'>> = {
    sceneArrival: 'ambulanceDispatch',
    patientOnboard: 'sceneArrival',
    hospitalArrival: 'patientOnboard',
    operationalCompletion: 'hospitalArrival',
  };
  const requiredFact = missingPredecessor[mapped.factKey];
  if (requiredFact && !projection.facts[requiredFact]) {
    anomalies.push({ code: 'MISSING_PREDECESSOR', eventId: mapped.eventId, missingFact: requiredFact });
  }

  const nextState = mapped.state && STATE_RANK[mapped.state] > STATE_RANK[projection.state]
    ? mapped.state
    : projection.state;
  return {
    ...projection,
    state: nextState,
    facts,
    processedEventIds: [...projection.processedEventIds, mapped.eventId],
    lastEventId: mapped.sequence >= projection.lastSequence ? mapped.eventId : projection.lastEventId,
    lastSequence: Math.max(projection.lastSequence, mapped.sequence),
    anomalies,
  };
}
