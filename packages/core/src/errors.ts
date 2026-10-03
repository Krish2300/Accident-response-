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

  // provider / transport / infrastructure (modules 1, 2, 8, 9)
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  PROVIDER_TIMEOUT: 'PROVIDER_TIMEOUT',
  PROVIDER_MALFORMED_RESPONSE: 'PROVIDER_MALFORMED_RESPONSE',
  PROVIDER_NOT_CONFIGURED: 'PROVIDER_NOT_CONFIGURED',
  CALL_NOT_FOUND: 'CALL_NOT_FOUND',
  CALL_ALREADY_ACTIVE: 'CALL_ALREADY_ACTIVE',
  SPEECH_TRANSCRIPTION_FAILED: 'SPEECH_TRANSCRIPTION_FAILED',
  SPEECH_SYNTHESIS_FAILED: 'SPEECH_SYNTHESIS_FAILED',
  SPEECH_LANGUAGE_UNSUPPORTED: 'SPEECH_LANGUAGE_UNSUPPORTED',
  ROUTING_FAILED: 'ROUTING_FAILED',
  NO_ROUTE_AVAILABLE: 'NO_ROUTE_AVAILABLE',
  POSITION_UNAVAILABLE: 'POSITION_UNAVAILABLE',
  NOTIFICATION_FAILED: 'NOTIFICATION_FAILED',

  // hospital / module 7
  HOSPITAL_NOT_FOUND: 'HOSPITAL_NOT_FOUND',
  HOSPITAL_NO_SUITABLE_CANDIDATE: 'HOSPITAL_NO_SUITABLE_CANDIDATE',
  HOSPITAL_RESOURCE_UNAVAILABLE: 'HOSPITAL_RESOURCE_UNAVAILABLE',

  // corridor / module 9
  CORRIDOR_NOT_FOUND: 'CORRIDOR_NOT_FOUND',
  CORRIDOR_ALREADY_ACTIVE: 'CORRIDOR_ALREADY_ACTIVE',
  CORRIDOR_INVALID_TRANSITION: 'CORRIDOR_INVALID_TRANSITION',

  // conversation / module 4
  CONVERSATION_NOT_FOUND: 'CONVERSATION_NOT_FOUND',
  CONVERSATION_CLOSED: 'CONVERSATION_CLOSED',
  NO_QUESTION_PENDING: 'NO_QUESTION_PENDING',

  // decision engine / module 10
  EMERGENCY_NOT_FOUND: 'EMERGENCY_NOT_FOUND',
  INVALID_STATE_TRANSITION: 'INVALID_STATE_TRANSITION',
  ORCHESTRATION_CONFLICT: 'ORCHESTRATION_CONFLICT',
  ORCHESTRATION_STEP_FAILED: 'ORCHESTRATION_STEP_FAILED',

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
