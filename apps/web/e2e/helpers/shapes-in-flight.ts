import type { BrowserContext, Page, Request } from '@playwright/test';

/**
 * Counts the sync shapes a page (or every tab of a browser context) keeps in flight. A shape is one connection: the next
 * poll of a shape can start a moment before the event that ends the last one arrives, so shapes are counted by path, not by
 * request. Snapshot shapes answer once and end, so they show only while their request runs.
 */
export function shapesInFlight(target: Page | BrowserContext) {
  const inFlight = new Map<Request, string>();
  let peak = 0;
  const distinct = () => new Set(inFlight.values());
  target.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (!pathname.startsWith('/api/sync/')) return;
    inFlight.set(request, pathname);
    peak = Math.max(peak, distinct().size);
  });
  const done = (request: Request) => {
    inFlight.delete(request);
  };
  target.on('requestfinished', done);
  target.on('requestfailed', done);
  return {
    /** How many shapes are in flight now. */
    now: () => distinct().size,
    /** The most shapes in flight at once since counting began. */
    peak: () => peak,
    /** The paths of the shapes in flight now, sorted. */
    paths: () => [...distinct()].sort(),
  };
}
