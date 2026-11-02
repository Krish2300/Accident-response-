/**
 * Raised when a routing provider cannot produce a route.
 *
 * Kept distinct from a persistence or validation error so the service can tell a
 * routing outage (fall back to the deterministic provider) from a programming
 * mistake (surface it).
 */
export class RoutingProviderError extends Error {
  constructor(
    message: string,
    readonly providerName: string,
  ) {
    super(message);
    this.name = 'RoutingProviderError';
  }
}
