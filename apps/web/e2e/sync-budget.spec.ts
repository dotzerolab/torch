import { expect, type Locator, type Page, test } from '@playwright/test';
import { createDb } from '../../server/src/db.ts';
import { startRename } from './helpers/issues.ts';
import { openSessionAs } from './helpers/session.ts';
import { shapesInFlight } from './helpers/shapes-in-flight.ts';

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

  const shapes = shapesInFlight(page);
  const open = () => shapes.paths().join('\n');

  await page.goto('/');
  await expect(page.getByTestId('issue-title-3')).toBeVisible();
  // A page without a device copy writes each shape to the device a moment after it loaded, one at a time (`settle` waits
  // for those): what the page keeps open is measured after them, so the check does not depend on where in that
  // sequence it happens to land.
  await shapes.settle();
  await page.getByTestId('team-OPS').click();
  await expect(page).toHaveURL(/\/teams\/OPS/);
  await shapes.settle();
  // The shapes of the team that left view must not pile up.
  expect(shapes.now(), open()).toBeLessThanOrEqual(MAX_IN_FLIGHT_SYNC);
  await page.getByTestId('team-ENG').click();
  await expect(page.getByTestId('issue-title-3')).toBeVisible();
  await shapes.settle();
  expect(shapes.now(), open()).toBeLessThanOrEqual(MAX_IN_FLIGHT_SYNC);

  // Both teams are on the device now: switching again opens the new shape a few milliseconds before the old one is
  // aborted, which is the most the budget allows.
  shapes.resetPeak();
  await page.getByTestId('team-OPS').click();
  await expect(page).toHaveURL(/\/teams\/OPS/);
  await page.getByTestId('team-ENG').click();
  await expect(page.getByTestId('issue-title-3')).toBeVisible();
  await shapes.settle();
  expect(shapes.peak(), open()).toBeLessThanOrEqual(MAX_IN_FLIGHT_WHILE_SWITCHING);

  const title = `Budget ${crypto.randomUUID().slice(0, 8)}`;
  const field = await startRename(page, 5, title);
  const write = page.waitForResponse(
    (response) => response.request().method() === 'PATCH' && response.url().includes('/issues/'),
  );
  const started = Date.now();
  await field.press('Enter');
  const response = await write;
  const took = Date.now() - started;
  expect(response.status()).toBe(200);
  expect(took).toBeLessThan(WRITE_MS);
  expect(shapes.now(), open()).toBeLessThanOrEqual(MAX_IN_FLIGHT_SYNC);
  await context.close();
});

test('write not starved with two tabs: a follower on another team than the leader opens no fifth shape, and takes its team once a slot frees', async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({ baseURL });
  await openSessionAs(context, baseURL, 'owner');

  // The tabs of one browser share its connections per origin: the shapes in flight are counted over both.
  const shapes = shapesInFlight(context);

  // The first tab opens first, so it leads: it syncs the team ENG.
  const leader = await context.newPage();
  await leader.goto('/');
  await expect(leader.getByTestId('issue-title-3')).toHaveText('ENG issue 3');
  // The second tab follows it, on the team OPS: ENG and OPS together would be one shape too many.
  const follower = await context.newPage();
  await follower.goto('/');
  await expect(follower.getByTestId('issue-title-3')).toHaveText('ENG issue 3');
  await follower.getByTestId('team-OPS').click();
  await expect(follower).toHaveURL(/\/teams\/OPS/);
  await leader.waitForTimeout(2500);
  expect(shapes.now(), shapes.paths().join('\n')).toBeLessThanOrEqual(MAX_IN_FLIGHT_SYNC);

  // Writes of both tabs still go through at once (the follower's own team is ENG again for this: it has rows to edit).
  const title = `Budget ${crypto.randomUUID().slice(0, 8)}`;
  const field = await startRename(leader, 5, title);
  const write = leader.waitForResponse(
    (response) => response.request().method() === 'PATCH' && response.url().includes('/issues/'),
  );
  const started = Date.now();
  await field.press('Enter');
  const response = await write;
  const took = Date.now() - started;
  expect(response.status()).toBe(200);
  expect(took).toBeLessThan(WRITE_MS);
  expect(shapes.now(), shapes.paths().join('\n')).toBeLessThanOrEqual(MAX_IN_FLIGHT_SYNC);

  // The leader moves on to OPS: its ENG shape closes, and the follower's team shows what the follower asked for.
  await leader.getByTestId('team-OPS').click();
  await expect(follower.getByTestId('issue-title-3')).toHaveText('OPS issue 3', { timeout: 5000 });
  await leader.waitForTimeout(1500);
  expect(shapes.now(), shapes.paths().join('\n')).toBeLessThanOrEqual(MAX_IN_FLIGHT_SYNC);
  expect(shapes.peak(), shapes.paths().join('\n')).toBeLessThanOrEqual(
    MAX_IN_FLIGHT_WHILE_SWITCHING,
  );
  await context.close();
});

// ---- every view: what it keeps open, and a write while it is open ----

const WATCH_MS = 3000;

async function engIssueId(number: number): Promise<string> {
  const db = createDb(process.env.DATABASE_URL as string);
  try {
    const found = await db.pool.query<{ id: string }>(
      `select i.id from issue i join team t on t.id = i.team_id
        where i.workspace_id = $1 and t.key = 'ENG' and i.number = $2`,
      [process.env.E2E_DEMO_WORKSPACE_ID, number],
    );
    return (found.rows[0] as { id: string }).id;
  } finally {
    await db.close();
  }
}

const VIEWS: { name: string; path: string; ready: (page: Page) => Locator }[] = [
  { name: 'the list', path: '/teams/ENG', ready: (page) => page.getByTestId('issue-title-3') },
  {
    name: 'the board',
    path: '/teams/ENG?layout=board',
    ready: (page) => page.locator('.board [data-testid="issue-3"]'),
  },
  {
    name: 'the peek',
    path: '/teams/ENG?peek=ENG-3',
    ready: (page) => page.getByTestId('issue-peek'),
  },
  {
    name: 'the issue page',
    path: '/issues/ENG-3',
    ready: (page) => page.getByRole('main').getByText('ENG issue 3').first(),
  },
  {
    name: 'My Issues',
    path: '/my-issues',
    ready: (page) => page.getByTestId('my-issues-tab-assigned'),
  },
  {
    name: 'settings: Workflow',
    path: '/settings/workflow',
    ready: (page) => page.getByTestId('state-list'),
  },
  {
    name: 'settings: Labels',
    path: '/settings/labels',
    ready: (page) => page.getByTestId('labels-page'),
  },
];

for (const view of VIEWS) {
  test(`${view.name} keeps at most four shapes open for three seconds, and a title write is quick`, async ({
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({ baseURL });
    await openSessionAs(context, baseURL, 'owner');
    const page = await context.newPage();
    const shapes = shapesInFlight(page);

    await page.goto(view.path);
    await expect(view.ready(page)).toBeVisible();
    // The first copies of a new device are not what the view keeps open: they are done when the requests go quiet.
    await shapes.settle();
    const peak = await shapes.watch(WATCH_MS);
    expect(peak, shapes.paths().join('\n')).toBeLessThanOrEqual(MAX_IN_FLIGHT_SYNC);

    // A write goes through while the view is open: in the page, so it competes for the same connections.
    const id = await engIssueId(5);
    const workspaceId = process.env.E2E_DEMO_WORKSPACE_ID as string;
    const result = await page.evaluate(
      async ({ workspaceId, id, title }) => {
        const started = performance.now();
        const res = await fetch(`/api/w/${workspaceId}/issues/${id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title }),
        });
        return { status: res.status, took: performance.now() - started };
      },
      { workspaceId, id, title: `Budget ${crypto.randomUUID().slice(0, 8)}` },
    );
    expect(result.status).toBe(200);
    expect(result.took).toBeLessThan(WRITE_MS);
    await context.close();
  });
}
