/**
 * Module 7 - Hospital Intelligence
 */
export { Module7, type Module7Deps } from './module.js';
export { createModule7Routes } from './api/routes.js';
export { loadModule7Config, type Module7Config } from './config.js';
export {
  requirementFor,
  scoreHospital,
  type IncidentRequirement,
  type ScoredHospital,
} from './suitability.js';
export {
  HospitalSelectionService,
  type HospitalSelectionDeps,
  type HospitalSelectionOutcome,
  type HospitalSelectionResult,
  type HospitalCandidatePort,
  type EmergencySelectionPort,
  type RankingResult,
} from './hospitalSelectionService.js';
export type { HospitalResourceWriterPort } from './hospitalResourceService.js';
export { AutoSelectService, AUTO_SELECT_EVENT_TYPES, type AutoSelectDeps } from './autoSelectService.js';
