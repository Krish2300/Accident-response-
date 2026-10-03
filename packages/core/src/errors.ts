/**
 * Error taxonomy shared by every module.
 *
 * The API layer serialises `AppError` into the wire format required by the
 * specification:
 *   { "error": true, "code": "...", "message": "...", "details": ... }
 *
 * Nothing is ever swallowed silently: unknown failures become
 * `INTERNAL_ERROR` while keeping the cause in the server log.
 */

export const ErrorCode = {
  // generic
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  RATE_LIMITED: 'RATE_LIMITED',

  // LLM / module 5
  LLM_UNAVAILABLE: 'LLM_UNAVAILABLE',
  LLM_TIMEOUT: 'LLM_TIMEOUT',
  LLM_MODEL_NOT_FOUND: 'LLM_MODEL_NOT_FOUND',
  LLM_MALFORMED_RESPONSE: 'LLM_MALFORMED_RESPONSE',
  LLM_OUTPUT_SCHEMA_VIOLATION: 'LLM_OUTPUT_SCHEMA_VIOLATION',
  PROTOCOL_NOT_FOUND: 'PROTOCOL_NOT_FOUND',
  PROTOCOL_INVALID_TRANSITION: 'PROTOCOL_INVALID_TRANSITION',
  PROTOCOL_STEP_NOT_ACTIONABLE: 'PROTOCOL_STEP_NOT_ACTIONABLE',
  PROTOCOL_SESSION_NOT_FOUND: 'PROTOCOL_SESSION_NOT_FOUND',
  PROTOCOL_ESCALATION_REQUIRED: 'PROTOCOL_ESCALATION_REQUIRED',
  PROTOCOL_CATALOGUE_INVALID: 'PROTOCOL_CATALOGUE_INVALID',
  CLARIFICATION_LIMIT_REACHED: 'CLARIFICATION_LIMIT_REACHED',

  // ambulance / module 6
  AMBULANCE_NOT_FOUND: 'AMBULANCE_NOT_FOUND',
  AMBULANCE_NOT_AVAILABLE: 'AMBULANCE_NOT_AVAILABLE',
  AMBULANCE_INVALID_STATUS_TRANSITION: 'AMBULANCE_INVALID_STATUS_TRANSITION',
  AMBULANCE_ALREADY_ASSIGNED: 'AMBULANCE_ALREADY_ASSIGNED',
  AMBULANCE_NO_CANDIDATE: 'AMBULANCE_NO_CANDIDATE',
  AMBULANCE_CREW_UNAVAILABLE: 'AMBULANCE_CREW_UNAVAILABLE',

  // database / module 11
  DATABASE_FAILURE: 'DATABASE_FAILURE',
  TRANSACTION_FAILED: 'TRANSACTION_FAILED',
  IMMUTABLE_RECORD: 'IMMUTABLE_RECORD',
  SIMULATION_DATA_MIXED: 'SIMULATION_DATA_MIXED',

  // analytics / module 12
  ANALYTICS_INSUFFICIENT_DATA: 'ANALYTICS_INSUFFICIENT_DATA',
  INVALID_TIME_WINDOW: 'INVALID_TIME_WINDOW',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface SerializedError {
  error: true;
  code: ErrorCodeValue | string;
  message: string;
  details?: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCodeValue;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(code: ErrorCodeValue, message: string, statusCode = 400, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }

  toJSON(): SerializedError {
    return {
      error: true,
      code: this.code,
      message: this.message,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }

  static notFound(what: string, id?: string): AppError {
    return new AppError(
      ErrorCode.NOT_FOUND,
      id ? `${what} '${id}' was not found.` : `${what} was not found.`,
      404,
    );
  }

  static validation(message: string, details?: unknown): AppError {
    return new AppError(ErrorCode.VALIDATION_ERROR, message, 422, details);
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}
