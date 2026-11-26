// A refreshed snapshot is a new collection, empty until it has answered: a screen would flash "no comments" for the
// moment between. This keeps the rows of the last answer on screen until the next one arrives.
import { useRef } from 'react';

/**
 * `rows` while `ready`; the rows of the last ready answer for the same `scope` (an issue, a document) while the shape is
 * being read again. A scope that never answered has no rows to keep and reports not ready.
 */
export function useKeptRows<T>(rows: readonly T[], ready: boolean, scope: string) {
  const kept = useRef<{ scope: string; rows: readonly T[]; answered: boolean }>({
    scope,
    rows: [],
    answered: false,
  });
  if (kept.current.scope !== scope) kept.current = { scope, rows: [], answered: false };
  if (ready) kept.current = { scope, rows, answered: true };
  return {
    rows: ready ? rows : kept.current.rows,
    ready: ready || kept.current.answered,
  };
}
