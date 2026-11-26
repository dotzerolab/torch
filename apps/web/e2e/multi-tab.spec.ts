import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { persistedRowCount, storageNames } from './helpers/device-store.ts';
import { renameIssue } from './helpers/issues.ts';
import { openSessionAs } from './helpers/session.ts';
import { countLiveShapeRequests } from './helpers/shapes-in-flight.ts';

const workspaceId = () => process.env.E2E_DEMO_WORKSPACE_ID as string;
const SEEDED_ISSUES = 50;

/**
 * The owner of the demo workspace with two tabs of one browser profile. The first tab opens first, so it syncs; the
 * second joins it. Edits in these specs use issues 7 and 8 only (the other specs read the rest).
 */
async function openTwoTabs(
  browser: import('@playwright/test').Browser,
  baseURL: string | undefined,
) {
  const context = await browser.newContext({ baseURL });
  await openSessionAs(context, baseURL, 'owner');
  const a = await context.newPage();
  await a.goto('/');
  await expect(a.getByTestId('issue-title-3')).toHaveText('ENG issue 3');
  // Warm: the device holds every issue of the team before the second tab opens.
  await expect
    .poll(() => persistedRowCount(a, workspaceId(), 'issues-'), { timeout: 10_000 })
    .toBeGreaterThanOrEqual(SEEDED_ISSUES);
  const b = await context.newPage();
  const bRequests = countLiveShapeRequests(b);
  await b.goto('/');
  await expect(b.getByTestId('issue-title-3')).toHaveText('ENG issue 3');
  return { context, a, b, bRequests };
}

/** Types a title and waits until the server accepted it. */
async function setTitle(page: Page, issue: number, title: string) {
  const answered = page.waitForResponse(
    (response) => response.request().method() === 'PATCH' && response.url().includes('/issues/'),
  );
  await renameIssue(page, issue, title);
  await answered;
}

async function closeContext(context: BrowserContext) {
  await context.close();
}

test('one connection set for two tabs: the second tab opens no shape request', async ({
  browser,
  baseURL,
}) => {
  const { context, b, bRequests } = await openTwoTabs(browser, baseURL);
  // Give a would-be long poll time to start.
  await b.waitForTimeout(2500);
  expect(bRequests.count()).toBe(0);
  await expect(b.getByTestId('team-ENG')).toBeVisible();
  await closeContext(context);
});

test('an edit in one tab shows in the other in under a second', async ({ browser, baseURL }) => {
  const { context, a, b } = await openTwoTabs(browser, baseURL);
  try {
    const title = `Shared ${crypto.randomUUID().slice(0, 8)}`;
    await renameIssue(a, 8, title);
    await expect(b.getByTestId('issue-title-8')).toHaveText(title, { timeout: 1000 });

    // And the other way round: the follower writes, the first tab shows it.
    const back = `Back ${crypto.randomUUID().slice(0, 8)}`;
    await renameIssue(b, 8, back);
    await expect(a.getByTestId('issue-title-8')).toHaveText(back, { timeout: 1000 });
  } finally {
    // The other specs read this issue's seeded title.
    await setTitle(b, 8, 'ENG issue 8').catch(() => {});
    await closeContext(context);
  }
});

test('when the leader tab closes the other tab takes over within 3 s and stays live', async ({
  browser,
  baseURL,
}) => {
  const { context, a, b, bRequests } = await openTwoTabs(browser, baseURL);
  try {
    expect(bRequests.count()).toBe(0);
    const closedAt = Date.now();
    await a.close();
    // The second tab starts syncing by itself.
    await expect.poll(() => bRequests.count(), { timeout: 3000 }).toBeGreaterThan(0);
    expect(Date.now() - closedAt).toBeLessThan(3500);

    // Live: a third tab's edit arrives through the new leader's connection.
    const c = await context.newPage();
    await c.goto('/');
    await expect(c.getByTestId('issue-title-7')).toBeVisible();
    const title = `Takeover ${crypto.randomUUID().slice(0, 8)}`;
    await renameIssue(c, 7, title);
    await expect(b.getByTestId('issue-title-7')).toHaveText(title, { timeout: 3000 });
    await setTitle(c, 7, 'ENG issue 7');
    await expect(b.getByTestId('issue-title-7')).toHaveText('ENG issue 7', { timeout: 3000 });
  } finally {
    await closeContext(context);
  }
});

for (const signingOutTab of ['leader', 'follower'] as const) {
  test(`sign-out in the ${signingOutTab} tab wipes the device and sends the other tab to /login`, async ({
    browser,
    baseURL,
  }) => {
    const { context, a, b } = await openTwoTabs(browser, baseURL);
    const [out, other] = signingOutTab === 'leader' ? [a, b] : [b, a];
    await out.getByTestId('sign-out').click();
    await expect(out).toHaveURL(/\/login$/);
    await expect(other).toHaveURL(/\/login$/, { timeout: 5000 });
    const after = await storageNames(out);
    const mine = (name: string) => name.startsWith(`ws-${workspaceId()}-`);
    expect(after.opfs.filter(mine)).toEqual([]);
    expect(after.indexedDb.filter(mine)).toEqual([]);
    await closeContext(context);
  });
}
