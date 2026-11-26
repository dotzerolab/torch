import { expect, type Request, test } from '@playwright/test';
import { persistedRowCount } from './helpers/device-store.ts';
import { renameIssue } from './helpers/issues.ts';
import { openSessionAs } from './helpers/session.ts';

const workspaceId = () => process.env.E2E_DEMO_WORKSPACE_ID as string;
const ISSUE_WRITE = '**/api/w/*/issues/*';
const SEEDED_ISSUES = 50;

/** Opens the demo workspace as its owner, waits until the device holds the issues, and lists every issue write sent. */
async function openOwner(browser: import('@playwright/test').Browser, baseURL: string | undefined) {
  const context = await browser.newContext({ baseURL });
  await openSessionAs(context, baseURL, 'owner');
  const page = await context.newPage();
  const keys: string[] = [];
  page.on('request', (request: Request) => {
    if (request.method() === 'PATCH' && /\/issues\//.test(request.url())) {
      keys.push(request.headers()['idempotency-key'] ?? '');
    }
  });
  await page.goto('/');
  await expect(page.getByTestId('issue-title-1')).toBeVisible();
  await expect
    .poll(() => persistedRowCount(page, workspaceId(), 'issues-'), { timeout: 10_000 })
    .toBeGreaterThanOrEqual(SEEDED_ISSUES);
  return { context, page, keys };
}

test('an offline edit survives a reload and replays on reconnect with the same Idempotency-Key', async ({
  browser,
  baseURL,
}) => {
  const { context, page, keys } = await openOwner(browser, baseURL);
  await context.route(ISSUE_WRITE, (route) => route.abort('connectionfailed'));

  const title = `Offline ${crypto.randomUUID().slice(0, 8)}`;
  await renameIssue(page, 7, title);
  await expect(page.getByTestId('offline-banner')).toContainText('1');
  await expect.poll(() => keys.length).toBeGreaterThan(0);
  const firstKey = keys[0];
  expect(firstKey).toBeTruthy();

  // The queue is in IndexedDB: a reload keeps it, and the new page keeps trying with the same key.
  await page.reload();
  await expect(page.getByTestId('offline-banner')).toContainText('1');
  await expect.poll(() => keys.length, { timeout: 10_000 }).toBeGreaterThan(1);
  expect(new Set(keys).size).toBe(1);

  await context.unroute(ISSUE_WRITE);
  await expect(page.getByTestId('offline-banner')).toHaveCount(0, { timeout: 15_000 });
  expect(keys.at(-1)).toBe(firstKey);
  await expect(page.getByTestId('issue-title-7')).toHaveText(title);

  // The server has it: a fresh device sees it too.
  const other = await browser.newContext({ baseURL });
  await openSessionAs(other, baseURL, 'owner');
  const fresh = await other.newPage();
  await fresh.goto('/');
  await expect(fresh.getByTestId('issue-title-7')).toHaveText(title);
  await other.close();
  await context.close();
});

test('a queued write the server refuses after a reload is dropped with a message', async ({
  browser,
  baseURL,
}) => {
  const { context, page } = await openOwner(browser, baseURL);
  await context.route(ISSUE_WRITE, (route) => route.abort('connectionfailed'));
  await renameIssue(page, 8, 'Will be refused');
  await expect(page.getByTestId('offline-banner')).toContainText('1');

  // The page that queued it is gone, so nobody waits on the write when it is finally answered.
  await page.reload();
  await expect(page.getByTestId('offline-banner')).toContainText('1');

  // Back online the server answers 403 (the person lost the team meanwhile): nothing is retried, the person is told.
  await context.unroute(ISSUE_WRITE);
  await context.route(ISSUE_WRITE, (route) =>
    route.fulfill({ status: 403, json: { error: 'forbidden', message: 'dev text' } }),
  );
  await expect(page.getByText(/A change was not saved/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('offline-banner')).toHaveCount(0);
  await expect(page.getByTestId('issue-title-8')).toHaveText('ENG issue 8');
  await context.close();
});

test('two tabs edit offline, both reload, and every queued write reaches the server', async ({
  browser,
  baseURL,
}) => {
  const { context, page: a } = await openOwner(browser, baseURL);
  // The second tab of the same browser follows the first one; both queue their writes in the same IndexedDB.
  const b = await context.newPage();
  await b.goto('/');
  await expect(b.getByTestId('issue-title-1')).toBeVisible();
  await context.route(ISSUE_WRITE, (route) => route.abort('connectionfailed'));

  const titleA = `Tab A ${crypto.randomUUID().slice(0, 8)}`;
  const titleB = `Tab B ${crypto.randomUUID().slice(0, 8)}`;
  try {
    await renameIssue(a, 7, titleA);
    await expect(a.getByTestId('offline-banner')).toBeVisible();
    await renameIssue(b, 8, titleB);
    await expect(b.getByTestId('offline-banner')).toBeVisible();

    // Both pages go away and come back: what each tab queued must have survived the other tab's saves.
    await Promise.all([a.reload(), b.reload()]);
    await expect(a.getByTestId('offline-banner')).toBeVisible();
    await expect(b.getByTestId('offline-banner')).toBeVisible();

    await context.unroute(ISSUE_WRITE);
    await expect(a.getByTestId('offline-banner')).toHaveCount(0, { timeout: 15_000 });
    await expect(b.getByTestId('offline-banner')).toHaveCount(0, { timeout: 15_000 });

    // The server has both writes: a fresh device sees them.
    const other = await browser.newContext({ baseURL });
    await openSessionAs(other, baseURL, 'owner');
    const fresh = await other.newPage();
    await fresh.goto('/');
    await expect(fresh.getByTestId('issue-title-7')).toHaveText(titleA);
    await expect(fresh.getByTestId('issue-title-8')).toHaveText(titleB);
    await other.close();
  } finally {
    // The other specs read the seeded titles of these issues.
    await context.unroute(ISSUE_WRITE).catch(() => {});
    for (const [issue, title] of [
      [7, 'ENG issue 7'],
      [8, 'ENG issue 8'],
    ] as const) {
      const answered = a.waitForResponse(
        (response) =>
          response.request().method() === 'PATCH' && response.url().includes('/issues/'),
      );
      await renameIssue(a, issue, title);
      await answered.catch(() => {});
    }
    await context.close();
  }
});
