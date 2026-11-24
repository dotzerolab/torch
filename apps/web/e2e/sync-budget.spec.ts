import { expect, type Request, test } from '@playwright/test';
import { openSessionAs } from './helpers/session.ts';

// Vite's dev proxy speaks HTTP/1.1, where a browser allows about six connections per origin and every live shape holds
// one for its long-poll. A page that keeps more shapes open than the budget leaves no connection for a write.
const MAX_IN_FLIGHT_SYNC = 4;
// While the page switches team the new shape starts a few milliseconds before the old one is aborted, so one more
// may be seen for a moment; the sixth connection stays free.
const MAX_IN_FLIGHT_WHILE_SWITCHING = MAX_IN_FLIGHT_SYNC + 1;
const WRITE_MS = 500;

test('write not starved: at most four shapes stay in flight, also after the team changes, and a write is quick', async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({ baseURL });
  await openSessionAs(context, baseURL, 'owner');
  const page = await context.newPage();

  // A shape is one connection: the next poll of a shape can start a moment before the event that ends the last one
  // arrives, so the shapes in flight are counted by path, not by request.
  const inFlight = new Map<Request, string>();
  let peak = 0;
  const isSync = (url: string) => new URL(url).pathname.startsWith('/api/sync/');
  page.on('request', (request) => {
    if (!isSync(request.url())) return;
    inFlight.set(request, new URL(request.url()).pathname);
    peak = Math.max(peak, new Set(inFlight.values()).size);
  });
  const done = (request: Request) => inFlight.delete(request);
  const shapesNow = () => new Set(inFlight.values()).size;
  page.on('requestfinished', done);
  page.on('requestfailed', done);

  await page.goto('/');
  await expect(page.getByTestId('issue-title-3')).toBeVisible();
  // Let the first sync settle, then switch team and back: the shapes of the team that left view must not pile up.
  await page.getByTestId('team-OPS').click();
  await expect(page).toHaveURL(/\/teams\/OPS/);
  await page.waitForTimeout(1500);
  expect(shapesNow()).toBeLessThanOrEqual(MAX_IN_FLIGHT_SYNC);
  await page.getByTestId('team-ENG').click();
  await expect(page.getByTestId('issue-title-3')).toBeVisible();
  await page.waitForTimeout(1500);
  expect(shapesNow()).toBeLessThanOrEqual(MAX_IN_FLIGHT_SYNC);
  expect(peak).toBeLessThanOrEqual(MAX_IN_FLIGHT_WHILE_SWITCHING);

  const title = `Budget ${crypto.randomUUID().slice(0, 8)}`;
  const field = page.getByTestId('issue-title-5');
  await field.fill(title);
  const write = page.waitForResponse(
    (response) => response.request().method() === 'PATCH' && response.url().includes('/issues/'),
  );
  const started = Date.now();
  await field.press('Enter');
  const response = await write;
  const took = Date.now() - started;
  expect(response.status()).toBe(200);
  expect(took).toBeLessThan(WRITE_MS);
  expect(shapesNow()).toBeLessThanOrEqual(MAX_IN_FLIGHT_SYNC);
  await context.close();
});

test('write not starved with two tabs: a follower on another team than the leader opens no fifth shape, and takes its team once a slot frees', async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({ baseURL });
  await openSessionAs(context, baseURL, 'owner');

  // The tabs of one browser share its connections per origin: the shapes in flight are counted over both.
  const inFlight = new Map<Request, string>();
  let peak = 0;
  const isSync = (url: string) => new URL(url).pathname.startsWith('/api/sync/');
  context.on('request', (request) => {
    if (!isSync(request.url())) return;
    inFlight.set(request, new URL(request.url()).pathname);
    peak = Math.max(peak, new Set(inFlight.values()).size);
  });
  const done = (request: Request) => inFlight.delete(request);
  const shapesNow = () => new Set(inFlight.values()).size;
  context.on('requestfinished', done);
  context.on('requestfailed', done);

  // The first tab opens first, so it leads: it syncs the team ENG.
  const leader = await context.newPage();
  await leader.goto('/');
  await expect(leader.getByTestId('issue-title-3')).toHaveValue('ENG issue 3');
  // The second tab follows it, on the team OPS: ENG and OPS together would be one shape too many.
  const follower = await context.newPage();
  await follower.goto('/');
  await expect(follower.getByTestId('issue-title-3')).toHaveValue('ENG issue 3');
  await follower.getByTestId('team-OPS').click();
  await expect(follower).toHaveURL(/\/teams\/OPS/);
  await leader.waitForTimeout(2500);
  expect(shapesNow()).toBeLessThanOrEqual(MAX_IN_FLIGHT_SYNC);

  // Writes of both tabs still go through at once (the follower's own team is ENG again for this: it has rows to edit).
  const title = `Budget ${crypto.randomUUID().slice(0, 8)}`;
  const field = leader.getByTestId('issue-title-5');
  await field.fill(title);
  const write = leader.waitForResponse(
    (response) => response.request().method() === 'PATCH' && response.url().includes('/issues/'),
  );
  const started = Date.now();
  await field.press('Enter');
  const response = await write;
  const took = Date.now() - started;
  expect(response.status()).toBe(200);
  expect(took).toBeLessThan(WRITE_MS);
  expect(shapesNow()).toBeLessThanOrEqual(MAX_IN_FLIGHT_SYNC);

  // The leader moves on to OPS: its ENG shape closes, and the follower's team shows what the follower asked for.
  await leader.getByTestId('team-OPS').click();
  await expect(follower.getByTestId('issue-title-3')).toHaveValue('OPS issue 3', { timeout: 5000 });
  await leader.waitForTimeout(1500);
  expect(shapesNow()).toBeLessThanOrEqual(MAX_IN_FLIGHT_SYNC);
  expect(peak).toBeLessThanOrEqual(MAX_IN_FLIGHT_WHILE_SWITCHING);
  await context.close();
});
