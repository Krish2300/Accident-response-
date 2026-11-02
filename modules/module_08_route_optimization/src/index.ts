/**
 * Module 8 - Route Optimization
 */
export { Module8, type Module8Deps } from './module.js';
export { loadModule8Config, type Module8Config, type RoutingProviderKind } from './config.js';
export {
  MockRoutingProvider,
  MOCK_ROUTING_PROVIDER_NAME,
  OsrmRoutingProvider,
  OSRM_ROUTING_PROVIDER_NAME,
  RoutingProviderError,
  type OsrmRoutingProviderOptions,
  GoogleRoutesProvider,
  GOOGLE_ROUTES_PROVIDER_NAME,
  GOOGLE_ROUTES_COMPUTE_ROUTES_URL,
  type GoogleRoutesProviderOptions,
} from './providers/index.js';
export {
  RouteOptimizationService,
  LEG_LABELS,
  type RouteLeg,
  type RouteGenerationOutcome,
  type RouteGenerationResult,
  type RouteRecalculationOutcome,
  type RouteRecalculationResult,
  type RecalculationActorContext,
  type RouteOptimizationDeps,
  type RouteWriterPort,
  type RouteCreateInput,
  type EmergencyRoutePort,
  type AmbulanceRoutePort,
  type HospitalRoutePort,
  type PlannedRoute,
} from './routeOptimizationService.js';
export { AutoRouteService, AUTO_ROUTE_EVENT_TYPES, type AutoRouteDeps } from './autoRouteService.js';
export { createModule8Routes } from './api/routes.js';
