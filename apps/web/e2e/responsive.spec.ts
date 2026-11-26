import { expect, type Page, test } from '@playwright/test';
import { issueCount } from './helpers/issues.ts';
import { openSessionAs } from './helpers/session.ts';

// A phone: the list, the filter bar, the sidebar, the peek and the board hold at 390 x 844 without the page itself
// scrolling sideways.
test.use({ viewport: { width: 390, height: 844 } });

async function phonePage(browser: import('@playwright/test').Browser, baseURL: string | undefined) {
  const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 } });
  await openSessionAs(context, baseURL, 'owner');
  return { context, page: await context.newPage() };
}

/** The page is not wider than the screen: a wide thing has its own scroller, the page does not move sideways. */
async function expectNoSidewaysPage(page: Page) {
  const widths = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    inner: window.innerWidth,
  }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.inner);
}

test('the list renders, the filter bar wraps, and the sidebar is a drawer', async ({
  browser,
  baseURL,
}) => {
  const { context, page } = await phonePage(browser, baseURL);
  await page.goto('/teams/ENG');
  await expect(page.getByTestId('issue-title-3')).toBeVisible();
  await expect.poll(() => issueCount(page)).toBe(50);
  await expectNoSidewaysPage(page);

  // The sidebar is not on the page until it is asked for; then it is a dialog over it, and Escape puts it away.
  const sidebar = page.getByRole('navigation', { name: 'Sidebar' });
  await expect(sidebar).toBeHidden();
  await page.getByRole('button', { name: 'Open sidebar' }).click();
  await expect(sidebar).toBeVisible();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sidebar).toBeHidden();

  // Filters pile up: the chips go onto further rows instead of out of the screen.
  for (const [field, value] of [
    ['Assignee', /\bMe\b/],
    ['Priority', /^Urgent/],
    ['State', /^Todo/],
  ] as const) {
    await page.getByRole('button', { name: 'Filter', exact: true }).click();
    await page.locator('.popover').getByRole('button', { name: field, exact: true }).click();
    await page.getByRole('option', { name: value }).click();
    await page.keyboard.press('Escape');
  }
  const chips = page.locator('.filter-bar .chip, .filter-bar [data-testid^="filter-chip"]');
  const boxes = await chips.evaluateAll((elements) =>
    elements.map((element) => {
      const { top, right, left } = element.getBoundingClientRect();
      return { top: Math.round(top), right: Math.round(right), left: Math.round(left) };
    }),
  );
  expect(boxes.length).toBeGreaterThanOrEqual(3);
  for (const box of boxes) {
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(390);
  }
  expect(new Set(boxes.map((box) => box.top)).size).toBeGreaterThan(1);
  await expectNoSidewaysPage(page);
  await context.close();
});

test('the peek is a sheet over the list, not a column beside it', async ({ browser, baseURL }) => {
  const { context, page } = await phonePage(browser, baseURL);
  await page.goto('/teams/ENG?peek=ENG-3');
  const peek = page.getByTestId('issue-peek');
  await expect(peek).toBeVisible();
  const box = await peek.boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(388);
  expect(box?.x).toBeLessThanOrEqual(2);
  await expectNoSidewaysPage(page);
  await page.keyboard.press('Escape');
  await expect(peek).toHaveCount(0);
  await context.close();
});

test('the board scrolls sideways inside itself, and the last column can be reached', async ({
  browser,
  baseURL,
}) => {
  const { context, page } = await phonePage(browser, baseURL);
  await page.goto('/teams/ENG?layout=board');
  const board = page.locator('.board');
  await expect(board).toBeVisible();
  const sizes = await board.evaluate((element) => ({
    scroll: element.scrollWidth,
    client: element.clientWidth,
  }));
  expect(sizes.scroll).toBeGreaterThan(sizes.client);
  await expectNoSidewaysPage(page);

  const last = page.locator('[data-testid^="column-"]').last();
  await board.evaluate((element) => element.scrollTo({ left: element.scrollWidth }));
  await expect(last).toBeInViewport({ ratio: 0.5 });
  await expectNoSidewaysPage(page);
  await context.close();
});
