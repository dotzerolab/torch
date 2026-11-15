import { describe, expect, it } from 'vitest';
import { applyStateTimestamps } from './state-timestamps.ts';

const NOW = new Date('2026-11-15T12:00:00.000Z');
const EARLIER = new Date('2026-11-01T08:00:00.000Z');
const NONE = { startedAt: null, completedAt: null, canceledAt: null };

describe('applyStateTimestamps', () => {
  it('entering a started state sets started_at once', () => {
    expect(applyStateTimestamps('started', NONE, NOW)).toEqual({ ...NONE, startedAt: NOW });
    expect(applyStateTimestamps('started', { ...NONE, startedAt: EARLIER }, NOW).startedAt).toEqual(
      EARLIER,
    );
  });

  it('entering completed sets completed_at and keeps started_at', () => {
    expect(applyStateTimestamps('completed', { ...NONE, startedAt: EARLIER }, NOW)).toEqual({
      startedAt: EARLIER,
      completedAt: NOW,
      canceledAt: null,
    });
  });

  it('entering canceled sets canceled_at and clears completed_at', () => {
    expect(applyStateTimestamps('canceled', { ...NONE, completedAt: EARLIER }, NOW)).toEqual({
      startedAt: null,
      completedAt: null,
      canceledAt: NOW,
    });
  });

  it('leaving completed or canceled clears that column and nothing else', () => {
    const done = { startedAt: EARLIER, completedAt: EARLIER, canceledAt: null };
    expect(applyStateTimestamps('started', done, NOW)).toEqual({
      startedAt: EARLIER,
      completedAt: null,
      canceledAt: null,
    });
    const dropped = { startedAt: EARLIER, completedAt: null, canceledAt: EARLIER };
    expect(applyStateTimestamps('unstarted', dropped, NOW)).toEqual({
      startedAt: EARLIER,
      completedAt: null,
      canceledAt: null,
    });
  });

  it('staying in completed keeps the original completed_at', () => {
    const done = { startedAt: null, completedAt: EARLIER, canceledAt: null };
    expect(applyStateTimestamps('completed', done, NOW).completedAt).toEqual(EARLIER);
  });

  it.each(['triage', 'backlog', 'unstarted'] as const)('%s sets nothing', (type) => {
    expect(applyStateTimestamps(type, NONE, NOW)).toEqual(NONE);
  });
});
