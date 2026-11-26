import { type Browser, expect, type Page, test } from '@playwright/test';
import { issueCount, issueRow } from './helpers/issues.ts';
import { openSessionAs } from './helpers/session.ts';

async function ownerPage(browser: Browser, baseURL: string | undefined) {
  const context = await browser.newContext({ baseURL });
  await openSessionAs(context, baseURL, 'owner');
  const page = await context.newPage();
  await page.goto('/');
  return page;
}

/** "+ Filter", a field, then one value of it; the menu is closed again. */
async function addFilter(page: Page, field: string, value: RegExp) {
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  await page.locator('.popover').getByRole('button', { name: field, exact: true }).click();
  await page.getByRole('option', { name: value }).click();
  await page.keyboard.press('Escape');
}

test('a filter on assignee and priority keeps its issues, survives a reload and is cleared', async ({
  browser,
  baseURL,
}) => {
  const page = await ownerPage(browser, baseURL);
  await expect.poll(() => issueCount(page)).toBe(50);
  await addFilter(page, 'Assignee', /\bMe\b/);
  await addFilter(page, 'Priority', /^Urgent/);
  // Seeded ENG issues: the owner holds every third, urgent ones are every fifth: issues 7 and 22 are both.
  await expect.poll(() => issueCount(page)).toBe(2);
  await expect(page.getByTestId('issue-total')).toHaveText('2 of 50 issues');
  await expect(issueRow(page, 7)).toBeVisible();
  await expect(issueRow(page, 22)).toBeVisible();
  await expect(issueRow(page, 8)).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get('priority')).toBe('1');

  await page.reload();
  await expect(page.getByText('Assignee: Me')).toBeVisible();
  await expect(page.getByText('Priority: Urgent')).toBeVisible();
  await expect.poll(() => issueCount(page)).toBe(2);

  await page.getByRole('button', { name: 'Clear' }).click();
  await expect.poll(() => issueCount(page)).toBe(50);
  expect(new URL(page.url()).search).toBe('');
});

test('a link naming a label that does not exist opens with an unavailable chip, not a crash', async ({
  browser,
  baseURL,
}) => {
  const page = await ownerPage(browser, baseURL);
  await page.goto(`/teams/ENG?label=${crypto.randomUUID()}`);
  await expect(page.getByText('Unavailable label')).toBeVisible();
  await expect(page.getByText('No issues match this filter.')).toBeVisible();
  await page.getByRole('button', { name: /^Remove filter/ }).click();
  await expect.poll(() => issueCount(page)).toBe(50);
});

test('the display options of a team are remembered on this device', async ({
  browser,
  baseURL,
}) => {
  const page = await ownerPage(browser, baseURL);
  const titles = () => page.locator('.issue-section__title').allTextContents();
  await expect.poll(async () => (await titles())[0]).toContain('Backlog');
  await page.getByRole('button', { name: 'Display' }).click();
  await page.getByLabel('Grouping').selectOption('priority');
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await titles())[0]).toContain('Urgent');
  try {
    // A plain address: the device copy applies.
    await page.goto('/');
    await expect.poll(async () => (await titles())[0]).toContain('Urgent');
  } finally {
    await page.getByRole('button', { name: 'Display' }).click();
    await page.getByRole('button', { name: 'Reset' }).click();
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await titles())[0]).toContain('Backlog');
  }
});
