import { type Browser, expect, type Page, test } from '@playwright/test';
import { createDb } from '../../server/src/db.ts';
import { issueCount, issueRow } from './helpers/issues.ts';
import { openSessionAs } from './helpers/session.ts';

async function ownerPage(browser: Browser, baseURL: string | undefined) {
  const context = await browser.newContext({ baseURL });
  await openSessionAs(context, baseURL, 'owner');
  const page = await context.newPage();
  await page.goto('/');
  return page;
}

/** The seeded "Frontend" label of ENG, for a database that was seeded before labels were part of the seed. */
async function ensureFrontendLabel(): Promise<void> {
  const db = createDb(process.env.DATABASE_URL as string);
  try {
    await db.pool.query(
      `insert into label (workspace_id, team_id, name, color)
       select w.id, t.id, 'Frontend', '#3b82f6'
         from team t join workspace w on w.id = t.workspace_id
        where w.slug = 'demo' and t.key = 'ENG'
          and not exists (select 1 from label l where l.team_id = t.id and l.name = 'Frontend')`,
    );
  } finally {
    await db.close();
  }
}

const patched = (page: Page) =>
  page.waitForResponse(
    (response) => response.request().method() === 'PATCH' && response.url().includes('/issues/'),
  );

/** The panel on the page (a peek or the detail page). */
const panel = (page: Page) => page.getByRole('article');
const property = (page: Page, name: string) =>
  panel(page).getByRole('button', { name, exact: true });

async function choose(page: Page, name: string, option: RegExp) {
  await property(page, name).click();
  const answered = patched(page);
  await page.getByRole('option', { name: option }).click();
  await answered;
}

test('a change made in the peek is kept after a reload and shows on the issue page too', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(90_000);
  await ensureFrontendLabel();
  const page = await ownerPage(browser, baseURL);
  await expect.poll(() => issueCount(page)).toBe(50);
  const title = `Edited ${crypto.randomUUID().slice(0, 8)}`;
  await issueRow(page, 3).click();
  await expect(page.getByTestId('issue-peek')).toBeVisible();
  expect(new URL(page.url()).searchParams.get('peek')).toBe('ENG-3');
  const titleField = panel(page).getByRole('textbox', { name: /Title of ENG-3/ });
  await expect(titleField).toHaveValue('ENG issue 3');
  try {
    let answered = patched(page);
    await titleField.fill(title);
    await titleField.press('Enter');
    await answered;
    await choose(page, 'Priority', /^Urgent/);
    await choose(page, 'Assignee', /Admin Example/);
    // Labels: a multi-select that stays open; the label write is a PATCH too.
    await property(page, 'Labels').click();
    answered = patched(page);
    await page.getByRole('option', { name: /Frontend/ }).click();
    await answered;
    await page.keyboard.press('Escape');

    await page.reload();
    await expect(panel(page).getByRole('textbox', { name: /Title of ENG-3/ })).toHaveValue(title);
    await expect(property(page, 'Priority')).toContainText('Urgent');
    await expect(property(page, 'Assignee')).toContainText('Admin Example');
    await expect(property(page, 'Labels')).toContainText('Frontend');

    await page.goto('/issues/ENG-3');
    await expect(panel(page).getByRole('textbox', { name: /Title of ENG-3/ })).toHaveValue(title);
    await expect(property(page, 'Priority')).toContainText('Urgent');
    await expect(property(page, 'Assignee')).toContainText('Admin Example');
    await expect(property(page, 'Labels')).toContainText('Frontend');
    await expect(panel(page).getByRole('link', { name: 'Engineering' })).toBeVisible();
  } finally {
    await page.goto('/teams/ENG?peek=ENG-3');
    const field = panel(page).getByRole('textbox', { name: /Title of ENG-3/ });
    await expect(field).toBeVisible();
    let answered = patched(page);
    await field.fill('ENG issue 3');
    await field.press('Enter');
    await answered;
    await choose(page, 'Priority', /^High/);
    await choose(page, 'Assignee', /Member Example/);
    if (await property(page, 'Labels').getByText('Frontend').count()) {
      await property(page, 'Labels').click();
      answered = patched(page);
      await page.getByRole('option', { name: /Frontend/ }).click();
      await answered;
      await page.keyboard.press('Escape');
    }
    await expect(field).toHaveValue('ENG issue 3');
  }
});

test('Escape closes the peek, the page for an unknown issue says so, and the description is saved', async ({
  browser,
  baseURL,
}) => {
  const page = await ownerPage(browser, baseURL);
  await page.goto('/issues/ENG-99999');
  await expect(page.getByTestId('issue-not-found')).toBeVisible();
  await page.goto('/issues/ZZZ-1');
  await expect(page.getByTestId('issue-not-found')).toBeVisible();

  await page.goto('/teams/ENG?peek=ENG-5');
  await expect(page.getByTestId('issue-peek')).toBeVisible();
  await expect(panel(page).getByRole('textbox', { name: /Title of ENG-5/ })).toBeVisible();
  const text = `Notes ${crypto.randomUUID().slice(0, 8)}\nsecond line`;
  const field = async () => {
    const existing = page.getByTestId('issue-description');
    if (await existing.count()) await existing.click();
    else await page.getByRole('button', { name: 'Add a description…' }).click();
    return page.getByRole('textbox', { name: 'Description' });
  };
  const original = await page.evaluate(
    () => document.querySelector('[data-testid="issue-description"]')?.textContent ?? '',
  );
  try {
    const box = await field();
    await box.fill(text);
    const saved = page.waitForResponse(
      (response) => response.request().method() === 'PATCH' && response.url().includes('/issues/'),
    );
    await page.getByRole('button', { name: 'Save' }).click();
    await saved;
    await expect(page.getByTestId('issue-description')).toContainText('second line');
    await page.reload();
    await expect(page.getByTestId('issue-description')).toContainText(
      text.split('\n')[0] as string,
    );
  } finally {
    const box = await field();
    const restored = page.waitForResponse(
      (response) => response.request().method() === 'PATCH' && response.url().includes('/issues/'),
    );
    await box.fill(original);
    await page.getByRole('button', { name: 'Save' }).click();
    await restored;
  }
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('issue-peek')).toHaveCount(0);
  expect(new URL(page.url()).searchParams.has('peek')).toBe(false);
});
