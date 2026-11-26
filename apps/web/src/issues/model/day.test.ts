import { describe, expect, it } from 'vitest';
import { addDays, localDay } from './day.ts';

describe('days', () => {
  it('moves across month and year ends, and leap days', () => {
    expect(addDays('2026-12-30', 7)).toBe('2027-01-06');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-11-26', 0)).toBe('2026-11-26');
  });

  it('reads today from the local clock', () => {
    expect(localDay(new Date(2026, 10, 5, 23, 59))).toBe('2026-11-05');
    expect(localDay(new Date(2027, 0, 1, 0, 1))).toBe('2027-01-01');
  });
});
