import { describe, expect, it } from 'vitest';
import { mergeConfirmed, pruneConfirmed, shows } from './confirmed.ts';

type Row = { id: string; name: string; position: number; extra?: string };
const row = (id: string, name: string, position = 0, extra?: string): Row => ({
  id,
  name,
  position,
  ...(extra ? { extra } : {}),
});
const held = (...rows: Row[]) =>
  new Map<string, { row: Row; until: number }>(rows.map((r) => [r.id, { row: r, until: 1000 }]));

describe('shows', () => {
  it('is true when every column the write set is the same in the snapshot (extra columns are fine)', () => {
    expect(shows([row('a', 'Review', 1, 'x')], row('a', 'Review', 1))).toBe(true);
  });
  it('is false for a stale or missing row', () => {
    expect(shows([row('a', 'Old', 1)], row('a', 'Review', 1))).toBe(false);
    expect(shows([], row('a', 'Review', 1))).toBe(false);
  });
});

describe('mergeConfirmed', () => {
  it('lays a written row over the snapshot and adds a row the snapshot does not have yet', () => {
    const merged = mergeConfirmed(
      [row('a', 'Old', 1), row('b', 'Keep', 2)],
      held(row('a', 'New', 1), row('c', 'Added', 3)),
    );
    expect(merged.map((r) => r.name)).toEqual(['New', 'Keep', 'Added']);
  });
  it('returns the snapshot rows when nothing was written', () => {
    const rows = [row('a', 'A')];
    expect(mergeConfirmed(rows, new Map())).toEqual(rows);
  });
});

describe('pruneConfirmed', () => {
  it('drops a row the snapshot shows and a row that expired, keeps the rest', () => {
    const all = held(row('a', 'Shown'), row('b', 'Waiting'), row('c', 'Late'));
    all.set('c', { row: row('c', 'Late'), until: 10 });
    const kept = pruneConfirmed(all, [row('a', 'Shown')], 500);
    expect([...kept.keys()]).toEqual(['b']);
  });
  it('returns the same map when nothing changes', () => {
    const all = held(row('b', 'Waiting'));
    expect(pruneConfirmed(all, [], 500)).toBe(all);
  });
});
