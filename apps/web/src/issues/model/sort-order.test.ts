import { describe, expect, it } from 'vitest';
import { sortOrderBetween } from './sort-order.ts';

describe('sortOrderBetween', () => {
  it('takes the midpoint of two neighbours', () => {
    expect(sortOrderBetween(1, 2)).toBe(1.5);
    expect(sortOrderBetween(-4, 6)).toBe(1);
  });

  it('goes one before the first and one after the last', () => {
    expect(sortOrderBetween(null, 5)).toBe(4);
    expect(sortOrderBetween(5, null)).toBe(6);
  });

  it('starts an empty group at zero', () => {
    expect(sortOrderBetween(null, null)).toBe(0);
  });

  it('keeps halving without leaving the gap (about forty drops at one spot stay distinct)', () => {
    let after = 1;
    for (let i = 0; i < 40; i += 1) {
      const next = sortOrderBetween(0, after);
      expect(next).toBeGreaterThan(0);
      expect(next).toBeLessThan(after);
      after = next;
    }
  });
});
