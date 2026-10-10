/**
 * Module 6 - Ambulance Management
 */
export { Module6, type Module6Deps } from './module.js';
export { loadModule6Config, type Module6Config } from './config.js';
export { FleetService, type FleetServiceDeps, type Candidate, type AssignmentRequest } from './fleetService.js';
export { AssignmentService, type AssignmentServiceDeps, type AssignmentCriteria, type AssignmentResult } from './assignment/assignmentService.js';
export { TrackingService, type TrackingServiceDeps } from './tracking/trackingService.js';
