// When a snapshot shape is read again. A snapshot (`SNAPSHOT_KINDS` in `registry.ts`) is read to its end and holds no
// connection, so something has to ask for a new read when its table may have changed: a screen opening, the page coming
// back online or into focus, this person's own write, a change of the live `issues` shape. Those moments can come in
// bursts (a list of rows each saving, a flurry of remote edits); the refresher turns a burst into one read now and at most
// one more after a short gap, per shape.
import { type ShapeKey, shapeId } from './registry.ts';

/** The least time between two refreshes of one shape, unless a caller says `now`. */
export const MIN_GAP_MS = 3000;

/** Past this many remembered shapes the refresher forgets the ones whose gap is over. */
const REMEMBER_LIMIT = 256;

type Slot = { last: number; cancel: (() => void) | null };

export type RefresherOptions = {
  /** Reads the shape again: `syncRegistry.refresh`. */
  refresh: (key: ShapeKey) => void;
  /** The clock, in ms. */
  now?: () => number;
  /** Runs `run` after `ms`; returns a function that cancels it. */
  setTimer?: (run: () => void, ms: number) => () => void;
};

const defaultSetTimer = (run: () => void, ms: number) => {
  const handle = setTimeout(run, ms);
  return () => clearTimeout(handle);
};

export function createRefresher({
  refresh,
  now = () => Date.now(),
  setTimer = defaultSetTimer,
}: RefresherOptions) {
  const slots = new Map<string, Slot>();

  function run(key: ShapeKey, slot: Slot) {
    slot.last = now();
    slot.cancel = null;
    try {
      refresh(key);
    } catch {
      // The shape could not be read again (it ended meanwhile): the next request asks again.
    }
  }

  function forgetOld() {
    if (slots.size <= REMEMBER_LIMIT) return;
    const time = now();
    for (const [id, slot] of slots) {
      if (!slot.cancel && time - slot.last >= MIN_GAP_MS) slots.delete(id);
    }
  }

  return {
    /**
     * Asks for the shape to be read again. The first request of a burst refreshes at once; the others share one more
     * refresh when `MIN_GAP_MS` has passed since that one. `now: true` refreshes at once whatever the gap (the person
     * just wrote, or opened the screen) and takes the place of a refresh that was waiting.
     */
    request(key: ShapeKey, options: { now?: boolean } = {}) {
      const id = shapeId(key);
      let slot = slots.get(id);
      if (!slot) {
        forgetOld();
        slot = { last: Number.NEGATIVE_INFINITY, cancel: null };
        slots.set(id, slot);
      }
      if (options.now) {
        slot.cancel?.();
        run(key, slot);
        return;
      }
      if (slot.cancel) return;
      const wait = slot.last + MIN_GAP_MS - now();
      if (wait <= 0) {
        run(key, slot);
        return;
      }
      const target = slot;
      slot.cancel = setTimer(() => run(key, target), wait);
    },
    /** Drops every refresh that is still waiting (the page is going away, or a test ends). */
    dispose() {
      for (const slot of slots.values()) slot.cancel?.();
      slots.clear();
    },
  };
}

export type Refresher = ReturnType<typeof createRefresher>;
