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
  await page.locator('.popover').getByRole('option', { name: option }).click();
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
    await page
      .locator('.popover')
      .getByRole('option', { name: /Frontend/ })
      .click();
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
      await page
        .locator('.popover')
        .getByRole('option', { name: /Frontend/ })
        .click();
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

test('a relation shows on both issues', async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
  const page = await ownerPage(browser, baseURL);
  await page.goto('/teams/ENG?peek=ENG-2');
  await expect(panel(page).getByRole('textbox', { name: /Title of ENG-2/ })).toBeVisible();
  const relations = panel(page).getByRole('region', { name: 'Relations' });
  await relations.getByRole('searchbox', { name: 'Find an issue' }).fill('ENG-3');
  const added = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().endsWith('/relations'),
  );
  await relations.getByRole('button', { name: 'ENG-3 ENG issue 3' }).click();
  await added;
  try {
    await expect(relations.getByTestId('relation-blocks')).toContainText('ENG-3');
    await page.goto('/issues/ENG-3');
    await expect(
      panel(page).getByRole('region', { name: 'Relations' }).getByTestId('relation-blocked_by'),
    ).toContainText('ENG-2');
  } finally {
    await page.goto('/teams/ENG?peek=ENG-2');
    const again = panel(page).getByRole('region', { name: 'Relations' });
    const removed = page.waitForResponse(
      (response) =>
        response.request().method() === 'DELETE' && response.url().includes('/relations/'),
    );
    await again
      .getByRole('button', { name: /Remove relation/ })
      .first()
      .click();
    await removed;
    await expect(again.getByTestId('relation-blocks')).toHaveCount(0);
  }
});

test('a relation to an issue of a team the guest cannot see names no issue', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(90_000);
  const db = createDb(process.env.DATABASE_URL as string);
  const ids = `select e.workspace_id, e.team_id, e.id as eng, o.id as ops, o.team_id as ops_team
       from issue e join team te on te.id = e.team_id and te.key = 'ENG' and e.number = 3
       join workspace w on w.id = e.workspace_id and w.slug = 'demo'
       join issue o on o.workspace_id = e.workspace_id and o.number = 1
       join team tp on tp.id = o.team_id and tp.key = 'OPS'`;
  try {
    await db.pool.query(
      `insert into issue_relation (workspace_id, team_id, issue_id, related_team_id, related_issue_id, type, created_by)
       select i.workspace_id, i.team_id, i.eng, i.ops_team, i.ops, 'blocks',
              (select id from member where workspace_id = i.workspace_id and email = 'owner@example.test')
         from (${ids}) i`,
    );
    const context = await browser.newContext({ baseURL });
    await openSessionAs(context, baseURL, 'guest');
    const page = await context.newPage();
    await page.goto('/issues/ENG-3');
    const region = panel(page).getByRole('region', { name: 'Relations' });
    await expect(region.getByTestId('relation-hidden')).toHaveText('Issue you cannot see');
    await expect(panel(page)).not.toContainText('OPS');
  } finally {
    await db.pool.query(
      `delete from issue_relation r using (${ids}) i
        where r.issue_id = i.eng and r.related_issue_id = i.ops`,
    );
    await db.close();
  }
});
