import type { BrowserContext, Page, Request } from '@playwright/test';

/** The snapshot shapes: tables read once and then closed (labels, states, links, an issue's detail). */
const SNAPSHOT_SHAPE =
  /\/(workflow-states|labels|issue-labels|issue-relations|issue-links|issue-subscribers|workspace-labels)$|\/issues\/[^/]+\/(detail|activity)$/;

/** Does a sync path name a snapshot shape (one short request, no connection kept open)? */
export const isSnapshotShape = (pathname: string): boolean => SNAPSHOT_SHAPE.test(pathname);

/**
 * Counts the LIVE shape requests a page makes from now on: a follower tab opens none (it reads what the leader
 * mirrors); snapshot shapes are short reads every tab makes for itself.
 */
export function countLiveShapeRequests(page: Page): { count: () => number } {
  let n = 0;
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith('/api/sync/') && !isSnapshotShape(pathname)) n += 1;
  });
  return { count: () => n };
}

/**
 * Counts the LIVE sync shapes a page (or every tab of a browser context) keeps in flight. A shape is one connection: the
 * next poll of a shape can start a moment before the event that ends the last one arrives, so shapes are counted by path,
 * not by request. A page that has no device copy yet (a new browser context) also copies each shape to the device, one at a
 * time, a moment after it loaded (`copyToDevice`): those reads come as extra requests of shapes the page no longer keeps
 * open, so a measurement of what the page KEEPS open waits for them first (`settle`). Snapshot shapes answer once and end: they hold a connection only for the moment of their request, so
 * they are counted apart (`snapshots`) and never against the live budget.
 */
export function shapesInFlight(target: Page | BrowserContext) {
  const inFlight = new Map<Request, string>();
  const snapshotsInFlight = new Set<Request>();
  let peak = 0;
  let snapshotPeak = 0;
  let snapshotRequests = 0;
  let lastRequestAt = Date.now();
  const distinct = () => new Set(inFlight.values());
  target.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (!pathname.startsWith('/api/sync/')) return;
    lastRequestAt = Date.now();
    if (isSnapshotShape(pathname)) {
      snapshotRequests += 1;
      snapshotsInFlight.add(request);
      snapshotPeak = Math.max(snapshotPeak, snapshotsInFlight.size);
      return;
    }
    inFlight.set(request, pathname);
    peak = Math.max(peak, distinct().size);
  });
  const done = (request: Request) => {
    inFlight.delete(request);
    snapshotsInFlight.delete(request);
  };
  target.on('requestfinished', done);
  target.on('requestfailed', done);
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  return {
    /**
     * Resolves once no sync request has started for `quietMs`: the first copies to the device (one shape at a time, about a
     * quarter of a second apart) are done and what is in flight is what the page keeps open. Throws when it never gets quiet.
     */
    async settle(quietMs = 1500, maxMs = 30_000): Promise<void> {
      const deadline = Date.now() + maxMs;
      while (Date.now() - lastRequestAt < quietMs || snapshotsInFlight.size > 0) {
        if (Date.now() > deadline) {
          throw new Error(
            `sync requests never went quiet; in flight: ${[...distinct()].join(', ')}`,
          );
        }
        await wait(100);
      }
    },
    /** Forgets the peak so far: the next `peak()` is of what happens from now on. */
    resetPeak(): void {
      peak = distinct().size;
    },
    /** The most shapes in flight at once during the next `ms`. */
    async watch(ms: number): Promise<number> {
      peak = distinct().size;
      await wait(ms);
      return peak;
    },
    /** How many shapes are in flight now. */
    now: () => distinct().size,
    /** The most shapes in flight at once since counting began. */
    peak: () => peak,
    /** The paths of the shapes in flight now, sorted. */
    paths: () => [...distinct()].sort(),
    /** The snapshot requests that are running now. */
    snapshotsNow: () => snapshotsInFlight.size,
    /** The most snapshot requests running at once since counting began. */
    snapshotPeak: () => snapshotPeak,
    /** How many snapshot requests were made since counting began. */
    snapshotRequests: () => snapshotRequests,
  };
}
