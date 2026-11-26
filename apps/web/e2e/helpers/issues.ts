// What the issue screens look like to a test: rows are windowed, a title is text until it is renamed, and the keyboard
// opens the property pickers. One place for the test ids, so a change of markup is one change here.
import { expect, type Locator, type Page } from '@playwright/test';

/** The row of issue number `n` (only rows in the window are on the page). */
export const issueRow = (page: Page, n: number | string): Locator => page.getByTestId(`issue-${n}`);

/** The title of issue number `n`, as text. */
export const issueTitle = (page: Page, n: number | string): Locator =>
  page.getByTestId(`issue-title-${n}`);

/** The field that edits the title of issue `n` while it is being renamed. */
export const issueTitleInput = (page: Page, n: number | string): Locator =>
  page.getByTestId(`issue-title-input-${n}`);

/**
 * Scrolls the list until the row of issue `n` is on the page (rows are windowed: only those near the viewport exist).
 * Steps down from the top, a page at a time.
 */
export async function revealIssue(page: Page, n: number | string): Promise<void> {
  const title = issueTitle(page, n);
  if ((await title.count()) > 0) return;
  const list = page.locator('.issue-list');
  await list.evaluate((element) => element.scrollTo({ top: 0 }));
  for (let step = 0; step < 60; step += 1) {
    if ((await title.count()) > 0) return;
    await list.evaluate((element) => element.scrollBy({ top: element.clientHeight * 0.7 }));
    await page.waitForTimeout(30);
  }
  await expect(title).toBeVisible();
}

/** Opens the rename field of an issue (double-click on its title) and types a title in it, without saving. */
export async function startRename(page: Page, n: number | string, title: string): Promise<Locator> {
  await revealIssue(page, n);
  await issueTitle(page, n).dblclick();
  const input = issueTitleInput(page, n);
  await input.fill(title);
  return input;
}

/** Renames an issue the way a person does: double-click, type, Enter. */
export async function renameIssue(page: Page, n: number | string, title: string): Promise<void> {
  const input = await startRename(page, n, title);
  await input.press('Enter');
}

/** Focuses the row of an issue and presses the key that opens a picker, then chooses an option by its name. */
export async function choose(
  page: Page,
  n: number | string,
  key: 's' | 'p' | 'a' | 'l' | 'd',
  option: string | RegExp,
): Promise<void> {
  await revealIssue(page, n);
  await issueRow(page, n).focus();
  await page.keyboard.press(key);
  await page.getByRole('option', { name: option }).first().click();
}

/** Sets the state of an issue from the keyboard: focus its row, `s`, the state's name. */
export async function setState(page: Page, n: number | string, name: string): Promise<void> {
  await choose(page, n, 's', new RegExp(`^${name}`));
}

/** The titles of the rows that are on the page, top to bottom. */
export async function visibleTitles(page: Page): Promise<string[]> {
  return page.locator('[data-testid^="issue-title-"]:not(input)').allTextContents();
}

/** The titles in the order given are the first rows on the page, top to bottom. */
export async function expectOrder(page: Page, titles: string[]): Promise<void> {
  await expect
    .poll(async () => (await visibleTitles(page)).slice(0, titles.length))
    .toEqual(titles);
}

/** How many issues the list holds (rows are windowed, so counting the rows on the page is not it). */
export async function issueCount(page: Page): Promise<number> {
  const count = await page.locator('[data-issue-count]').first().getAttribute('data-issue-count');
  return Number(count ?? 0);
}
