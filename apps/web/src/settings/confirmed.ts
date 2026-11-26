// What a settings screen shows right after this person's own write. A snapshot (`useSnapshot`) is read again after the
// write, but the read can reach Electric before the change did, so the answer of the write itself (the server's row) is
// kept on screen until the snapshot shows the same row, or for `HOLD_MS`, and the snapshot is asked for again meanwhile.
import { useCallback, useEffect, useMemo, useState } from 'react';

/** How long a written row outranks the snapshot. */
export const HOLD_MS = 8000;
/** How long a written row waits for the snapshot before the snapshot is asked for again. */
export const RETRY_MS = 1500;

type Row = { id: string };
export type Confirmed<T extends Row> = ReadonlyMap<string, { row: T; until: number }>;

/** The snapshot shows the written row when every column the write set is the same there. */
export function shows<T extends Row>(rows: readonly T[], written: T): boolean {
  const seen = rows.find((row) => row.id === written.id);
  if (!seen) return false;
  const target = seen as Record<string, unknown>;
  return Object.entries(written).every(([column, value]) => target[column] === value);
}

/** The snapshot's rows with the written ones in place (a new row is added at the end; the caller orders). */
export function mergeConfirmed<T extends Row>(rows: readonly T[], confirmed: Confirmed<T>): T[] {
  if (confirmed.size === 0) return [...rows];
  const merged = rows.map((row) => confirmed.get(row.id)?.row ?? row);
  const known = new Set(rows.map((row) => row.id));
  for (const [id, entry] of confirmed) if (!known.has(id)) merged.push(entry.row);
  return merged;
}

/** The entries still worth keeping: not shown by the snapshot yet and not expired. */
export function pruneConfirmed<T extends Row>(
  confirmed: Confirmed<T>,
  rows: readonly T[],
  now: number,
): Confirmed<T> {
  const kept = new Map([...confirmed].filter(([, e]) => e.until > now && !shows(rows, e.row)));
  return kept.size === confirmed.size ? confirmed : kept;
}

/**
 * `rows` of a snapshot with this person's own writes laid over them. `remember(row)` after a write; `refresh` reads the
 * snapshot again and is called once more every `RETRY_MS` while a written row is not in it.
 */
export function useConfirmedRows<T extends Row>(
  rows: readonly T[],
  refresh: () => void,
): { rows: T[]; remember: (row: T) => void } {
  const [confirmed, setConfirmed] = useState<Confirmed<T>>(new Map());
  const remember = useCallback((row: T) => {
    setConfirmed((previous) => new Map(previous).set(row.id, { row, until: Date.now() + HOLD_MS }));
  }, []);

  useEffect(() => {
    setConfirmed((previous) => pruneConfirmed(previous, rows, Date.now()));
  }, [rows]);
  useEffect(() => {
    if (confirmed.size === 0) return;
    const timer = setTimeout(() => {
      setConfirmed((previous) => pruneConfirmed(previous, rows, Date.now()));
      refresh();
    }, RETRY_MS);
    return () => clearTimeout(timer);
  }, [confirmed, rows, refresh]);

  const merged = useMemo(() => mergeConfirmed(rows, confirmed), [rows, confirmed]);
  return { rows: merged, remember };
}
