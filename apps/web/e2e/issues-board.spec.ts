import { type Browser, expect, type Page, test } from '@playwright/test';
import { issueCount, issueRow, revealIssue, setState } from './helpers/issues.ts';
import { openSessionAs } from './helpers/session.ts';

async function ownerPage(browser: Browser, baseURL: string | undefined) {
  const context = await browser.newContext({ baseURL });
  await openSessionAs(context, baseURL, 'owner');
  const page = await context.newPage();
  await page.goto('/');
  return page;
}

async function chooseLayout(page: Page, layout: 'List' | 'Board') {
  await page.getByRole('button', { name: 'Display' }).click();
  await page.getByRole('radio', { name: layout }).click();
  await page.keyboard.press('Escape');
}

const column = (page: Page, name: string) =>
  page.locator('[data-testid^="column-"]', { has: page.getByRole('heading', { name }) });

test('the board shows a column per state, and a state change moves the card and shows in the list', async ({
  browser,
  baseURL,
}) => {
  const page = await ownerPage(browser, baseURL);
  await expect.poll(() => issueCount(page)).toBe(50);
  await chooseLayout(page, 'Board');
  await expect(page.locator('[data-testid^="column-"]')).toHaveCount(5);
  await expect(column(page, 'Done').getByTestId('issue-4')).toBeVisible();
  try {
    await issueRow(page, 4).focus();
    await page.keyboard.press('s');
    await page.getByRole('option', { name: /^In Progress/ }).click();
    await expect(column(page, 'In Progress').getByTestId('issue-4')).toBeVisible();
    await expect(column(page, 'Done').getByTestId('issue-4')).toHaveCount(0);

    await chooseLayout(page, 'List');
    await revealIssue(page, 4);
    await expect(
      issueRow(page, 4).getByRole('button', { name: 'State: In Progress' }),
    ).toBeVisible();
  } finally {
    await setState(page, 4, 'Done');
    await expect(issueRow(page, 4).getByRole('button', { name: 'State: Done' })).toBeVisible();
  }
});

test('arrows cross columns and the board keeps the filter', async ({ browser, baseURL }) => {
  const page = await ownerPage(browser, baseURL);
  await page.goto('/teams/ENG?layout=board&priority=1,2');
  await expect.poll(() => issueCount(page)).toBe(20);
  await expect(page.getByText('Priority: Urgent')).toBeVisible();
  await page.locator('[data-testid^="issue-"][data-active="true"]').first().focus();
  const before = await page.evaluate(() => document.activeElement?.getAttribute('data-issue-id'));
  await page.keyboard.press('ArrowRight');
  const after = await page.evaluate(() => document.activeElement?.getAttribute('data-issue-id'));
  expect(after).not.toBe(before);
  await chooseLayout(page, 'List');
  await expect(page.getByText('Priority: Urgent')).toBeVisible();
  await expect.poll(() => issueCount(page)).toBe(20);
});
