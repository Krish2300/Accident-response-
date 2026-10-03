/**
 * Data provenance.
 *
 * Section 31 of the specification requires every analytic value to be labelled
 * as one of these four classes. Nothing in this system may present an estimate,
 * a simulation record or a model output as if it were an observation.
 */
export const DATA_PROVENANCE = {
  /** Recorded from a real system event. Verifiable by replaying the event log. */
  REAL_OBSERVED: 'REAL_OBSERVED',
  /** Produced by the labelled ambulance simulator. Never mixed with real data. */
  SIMULATION: 'SIMULATION',
  /** Computed from observed data by a transparent formula. */
  STATISTICAL_ESTIMATE: 'STATISTICAL_ESTIMATE',
  /** Output of the outcome-learning layer. Always carries its sample count. */
  MODEL_OUTPUT: 'MODEL_OUTPUT',
} as const;

export type DataProvenance = (typeof DATA_PROVENANCE)[keyof typeof DATA_PROVENANCE];

export interface Provenanced<T> {
  value: T;
  provenance: DataProvenance;
  /** Human readable explanation of how the value was produced. */
  basis?: string;
  /** Number of underlying observations, when applicable. */
  sampleSize?: number;
  /** Marks a value as preliminary / under-sampled. */
  provisional?: boolean;
}

export function observed<T>(value: T, sampleSize?: number): Provenanced<T> {
  return {
    value,
    provenance: DATA_PROVENANCE.REAL_OBSERVED,
    basis: 'Recorded directly from system events.',
    ...(sampleSize === undefined ? {} : { sampleSize }),
  };
}

export function estimated<T>(value: T, sampleSize: number, provisional: boolean): Provenanced<T> {
  return {
    value,
    provenance: DATA_PROVENANCE.STATISTICAL_ESTIMATE,
    basis: 'Computed from recorded events by a documented aggregation.',
    sampleSize,
    provisional,
  };
}

export function simulated<T>(value: T, basis: string): Provenanced<T> {
  return {
    value,
    provenance: DATA_PROVENANCE.SIMULATION,
    basis,
    provisional: true,
  };
}
