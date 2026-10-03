export const SYSTEM_NAME = 'Real-Time Sequential Decision System for Pre-Hospital Emergency Survival';
export const SYSTEM_VERSION = '0.1.0';

/**
 * Prototype safety notice. Returned by the health endpoints and rendered in the
 * dashboard footer so no operator can mistake this build for a clinically
 * validated system.
 */
export const PROTOTYPE_DISCLAIMER =
  'RESEARCH / ENGINEERING PROTOTYPE. NOT CLINICALLY VALIDATED. Do not use for real patient care. ' +
  'Protocol content is transcribed from published public emergency-care guidance and requires review by a ' +
  'qualified clinical lead before any operational use. The Protocol Engine is authoritative; the LLM never ' +
  'originates medical instructions.';
