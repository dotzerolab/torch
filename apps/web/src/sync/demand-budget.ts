import { isBudgetedKey, isShapeId, parseShapeId, type ShapeKey } from './registry.ts';

/** What the budget needs of the page's registry. */
export type DemandRegistry = {
  isOpen(key: ShapeKey): boolean;
  liveCount(): number;
  /** How many readers (screens and demands) hold the shape. */
  holdCount(key: ShapeKey): number;
  /** Starts the shape if it is not running (and keeps it running as the instance is replaced). */
  open(key: ShapeKey): void;
  hold(key: ShapeKey): () => void;
  /** Ends the shape now, unless something holds it. */
  pauseNow(key: ShapeKey): void;
  subscribe(listener: () => void): () => void;
};

type Demand = {
  key: ShapeKey;
  /** What ends the open shape's hold and its watch over replaced instances; null while the shape waits. */
  close: (() => void) | null;
  timer: ReturnType<typeof setTimeout> | undefined;
  since: number;
  ended: boolean;
};

/**
 * The shapes a leader tab opens because a follower tab reads them. They are inside the same budget as the shapes of the
 * leader's own screens: a long-poll holds a connection (about six per origin on HTTP/1.1) and a write must always find
 * one free, however many tabs read however many teams.
 *
 * - A demanded team shape, or My Issues, starts only while the page has room; else it waits and starts as soon as a slot frees.
 * - The always-live shapes of the workspace (teams, members, own memberships) always start: the leader runs them for its own screens.
 * - When a screen of this tab needs a slot (`makeRoom`), the least recent shape that is open only for a follower closes
 *   and goes back to waiting. The follower keeps showing what it has.
 */
export function createDemandBudget(
  registry: DemandRegistry,
  options: { max: number; retryMs: number },
) {
  const demands = new Set<Demand>();

  function start(demand: Demand) {
    registry.open(demand.key);
    const release = registry.hold(demand.key);
    // The instance may be replaced (a restart): the new one must run too.
    const stop = registry.subscribe(() => {
      if (!demand.ended && demand.close) registry.open(demand.key);
    });
    demand.close = () => {
      stop();
      release();
      demand.close = null;
    };
    demand.since = Date.now();
  }

  function admit(demand: Demand) {
    if (demand.ended) return;
    if (
      !isBudgetedKey(demand.key) ||
      registry.isOpen(demand.key) ||
      registry.liveCount() < options.max
    ) {
      start(demand);
      return;
    }
    demand.timer = setTimeout(() => admit(demand), options.retryMs);
  }

  function hold(shape: string): () => void {
    if (!isShapeId(shape)) return () => {};
    const demand: Demand = {
      key: parseShapeId(shape),
      close: null,
      timer: undefined,
      since: Date.now(),
      ended: false,
    };
    demands.add(demand);
    admit(demand);
    return () => {
      demand.ended = true;
      clearTimeout(demand.timer);
      demands.delete(demand);
      demand.close?.();
    };
  }

  /** The page is over its budget because a screen of this tab opened a shape: close demand-only shapes until it is not. */
  function makeRoom() {
    const open = [...demands]
      .filter(
        (demand) =>
          demand.close && isBudgetedKey(demand.key) && registry.holdCount(demand.key) === 1,
      )
      .sort((a, b) => a.since - b.since);
    for (const demand of open) {
      if (registry.liveCount() <= options.max) return;
      demand.close?.();
      registry.pauseNow(demand.key);
      demand.timer = setTimeout(() => admit(demand), options.retryMs);
    }
  }

  return { hold, makeRoom };
}
