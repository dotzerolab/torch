import { type Browser, expect, test } from '@playwright/test';
import { issueCount, issueRow, issueTitle, renameIssue, setState } from './helpers/issues.ts';
import { openSessionAs } from './helpers/session.ts';

/** The owner's page on the demo workspace, from a session (the sign-in screens have their own specs). */
async function ownerPage(browser: Browser, baseURL: string | undefined) {
  const context = await browser.newContext({ baseURL });
  await openSessionAs(context, baseURL, 'owner');
  const page = await context.newPage();
  await page.goto('/');
  return page;
}

test('the seeded ENG team shows its 50 issues grouped by state in workflow order', async ({
  browser,
  baseURL,
}) => {
  const page = await ownerPage(browser, baseURL);
  await expect(issueTitle(page, 1)).toHaveText('ENG issue 1');
  await expect.poll(() => issueCount(page)).toBe(50);
  // Five of the six default states hold issues (Triage is empty and hidden), in the order of the workflow. Only the
  // headers in the window are on the page: the top of the list first, then the end after scrolling down.
  const titles = () => page.locator('.issue-section__title').allTextContents();
  await expect.poll(async () => (await titles()).slice(0, 2)).toEqual(['Backlog10', 'Todo10']);
  await page.locator('.issue-list').evaluate((list) => list.scrollTo({ top: list.scrollHeight }));
  await expect.poll(async () => (await titles()).slice(-2)).toEqual(['Done10', 'Canceled10']);
  await page.locator('.issue-list').evaluate((list) => list.scrollTo({ top: 0 }));
  // Rows are windowed: far fewer than 50 are on the page of a 720 px viewport.
  expect(await page.getByRole('listitem').count()).toBeLessThan(40);
});

test('a renamed issue keeps its new title after a reload', async ({ browser, baseURL }) => {
  const page = await ownerPage(browser, baseURL);
  const title = `Renamed ${crypto.randomUUID().slice(0, 8)}`;
  await expect(issueTitle(page, 3)).toHaveText('ENG issue 3');
  try {
    const saved = page.waitForResponse(
      (response) => response.request().method() === 'PATCH' && response.url().includes('/issues/'),
    );
    await renameIssue(page, 3, title);
    await expect(issueTitle(page, 3)).toHaveText(title);
    // The server has it before the page goes away.
    await saved;
    await page.reload();
    await expect(issueTitle(page, 3)).toHaveText(title);
  } finally {
    const restored = page.waitForResponse(
      (response) => response.request().method() === 'PATCH' && response.url().includes('/issues/'),
    );
    await renameIssue(page, 3, 'ENG issue 3');
    await expect(issueTitle(page, 3)).toHaveText('ENG issue 3');
    await restored;
  }
});

test('the state key moves an issue to its new group', async ({ browser, baseURL }) => {
  const page = await ownerPage(browser, baseURL);
  await expect.poll(() => issueCount(page)).toBe(50);
  const group = (name: string) => page.locator('.issue-section', { hasText: name });
  await expect(group('Backlog')).toContainText('10');
  try {
    await setState(page, 1, 'In Progress');
    // Focusing the row scrolled the list to it: the group headers are at the top.
    await page.locator('.issue-list').evaluate((list) => list.scrollTo({ top: 0 }));
    await expect(group('Backlog')).toContainText('9');
    await expect(group('In Progress')).toContainText('11');
    // Moved: issue 1 now sits among the issues that are in progress, ahead of issue 3 by number.
    await expect(issueRow(page, 1)).toBeVisible();
  } finally {
    await setState(page, 1, 'Backlog');
    // Focusing the row scrolled the list to it: the group headers are at the top.
    await page.locator('.issue-list').evaluate((list) => list.scrollTo({ top: 0 }));
    await expect(group('Backlog')).toContainText('10');
  }
});

test('keys move focus, x selects, Escape clears', async ({ browser, baseURL }) => {
  const page = await ownerPage(browser, baseURL);
  await expect(issueTitle(page, 1)).toBeVisible();
  await page.keyboard.press('j');
  await expect(issueRow(page, 1)).toBeFocused();
  await page.keyboard.press('j');
  await page.keyboard.press('x');
  await expect(page.locator('[data-selected="true"]')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-selected="true"]')).toHaveCount(0);
});
