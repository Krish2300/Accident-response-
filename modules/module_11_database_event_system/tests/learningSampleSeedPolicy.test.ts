import { describe, expect, it } from 'vitest';
import { isLearningSampleSeedEnabled } from '../src/seed/learningSampleSeedPolicy.js';

describe('demo learning sample seed policy', () => {
  it('writes no learning samples unless the environment explicitly opts in', () => {
    expect(isLearningSampleSeedEnabled(undefined)).toBe(false);
    expect(isLearningSampleSeedEnabled('false')).toBe(false);
    expect(isLearningSampleSeedEnabled('yes')).toBe(false);
    expect(isLearningSampleSeedEnabled(' true ')).toBe(true);
  });
});
