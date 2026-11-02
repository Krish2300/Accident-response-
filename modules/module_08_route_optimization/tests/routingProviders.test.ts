import { describe, expect, it } from 'vitest';
import { MockRoutingProvider, MOCK_ROUTING_PROVIDER_NAME } from '../src/providers/mockRoutingProvider.js';

describe('mock provider', () => {
  it('returns deterministic name and geometry', () => {
    const p = new MockRoutingProvider(60);
    expect(p.providerName).toBe(MOCK_ROUTING_PROVIDER_NAME);
    expect(p.isLive).toBe(false);
    expect(p.isLiveTraffic).toBe(false);
  });
});

