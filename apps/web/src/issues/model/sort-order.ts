// Where an issue goes when it is dropped between two others (builder decision 7): the midpoint of its neighbours; above
// the first `first - 1`; below the last `last + 1` (the server puts a new issue at `min - 1`, so the top stays open).

/** The `sort_order` for a position between `before` (the neighbour above, null at the top) and `after` (below, null at the end). */
export function sortOrderBetween(before: number | null, after: number | null): number {
  if (before === null && after === null) return 0;
  if (before === null) return (after as number) - 1;
  if (after === null) return before + 1;
  return (before + after) / 2;
}
