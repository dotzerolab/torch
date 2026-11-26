import { type Browser, expect, type Page, test } from '@playwright/test';
import { createDb } from '../../server/src/db.ts';
import { issueRow, revealIssue, setState } from './helpers/issues.ts';
import { openSessionAs } from './helpers/session.ts';
import type { DemoRole } from './helpers/sign-in.ts';

// The specs add a state and a label to the demo team and take them out again, one after the other.
test.describe.configure({ mode: 'serial' });

const SYNC_MS = 10_000;

// What the specs leave behind (an archived state and label of ENG) goes, so a second run starts clean.
test.afterAll(async () => {
  const db = createDb(process.env.DATABASE_URL as string);
  try {
    await db.pool.query(
      `delete from workflow_state s using team t
        where s.team_id = t.id and t.workspace_id = $1 and t.key = 'ENG' and s.name = 'Review'
          and s.archived_at is not null
          and not exists (select 1 from issue i where i.state_id = s.id)`,
      [process.env.E2E_DEMO_WORKSPACE_ID],
    );
    await db.pool.query(
      `delete from label l
        where l.workspace_id = $1 and l.name = 'Release blocker' and l.archived_at is not null
          and not exists (select 1 from issue_label il where il.label_id = l.id)`,
      [process.env.E2E_DEMO_WORKSPACE_ID],
    );
  } finally {
    await db.close();
  }
});

async function pageOf(browser: Browser, baseURL: string | undefined, role: DemoRole, path: string) {
  const context = await browser.newContext({ baseURL });
  await openSessionAs(context, baseURL, role);
  const page = await context.newPage();
  await page.goto(path);
  return page;
}

async function chooseLayout(page: Page, layout: 'List' | 'Board') {
  await page.getByRole('button', { name: 'Display' }).click();
  await page.getByRole('radio', { name: layout }).click();
  await page.keyboard.press('Escape');
}

test('a member sees Labels but not Workflow, and the Workflow address leads back to the profile', async ({
  browser,
  baseURL,
}) => {
  const member = await pageOf(browser, baseURL, 'member', '/settings/profile');
  await expect(member.getByTestId('settings-tab-labels')).toBeVisible();
  await expect(member.getByTestId('settings-tab-workflow')).toHaveCount(0);

  await member.goto('/settings/workflow');
  await expect(member).toHaveURL(/\/settings\/profile$/);

  // The workspace labels are read-only for a member; the labels of a team they can see are theirs to edit.
  await member.goto('/settings/labels');
  await expect(member.getByTestId('label-add-open')).toHaveCount(0);
  await member.getByRole('combobox', { name: 'Labels of' }).click();
  await member.getByRole('option', { name: /ENG/ }).click();
  await expect(member.getByTestId('label-add-open')).toBeVisible();
  await member.context().close();

  const guest = await pageOf(browser, baseURL, 'guest', '/settings/labels');
  await expect(guest).toHaveURL(/\/settings\/profile$/);
  await expect(guest.getByTestId('settings-tab-labels')).toHaveCount(0);
  await guest.context().close();
});

test('an owner adds the state Review, uses it in the list and on the board, and archives it with its issues moved to Todo', async ({
  browser,
  baseURL,
}) => {
  const page = await pageOf(browser, baseURL, 'owner', '/settings/workflow');
  await expect(page.getByTestId('state-row-Todo')).toBeVisible();

  await page.getByTestId('state-add-open').click();
  await page.getByLabel('Name').fill('Review');
  await page.getByTestId('state-submit').click();
  await expect(page.getByTestId('state-row-Review')).toBeVisible({ timeout: SYNC_MS });

  // The new state is in the state picker of the list and is a column of the board.
  await page.goto('/');
  try {
    await setState(page, 4, 'Review');
    await revealIssue(page, 4);
    await expect(issueRow(page, 4).getByRole('button', { name: 'State: Review' })).toBeVisible();
    await chooseLayout(page, 'Board');
    await expect(
      page
        .locator('[data-testid^="column-"]', { has: page.getByRole('heading', { name: 'Review' }) })
        .getByTestId('issue-4'),
    ).toBeVisible();
    await chooseLayout(page, 'List');

    // Archive: the state has an issue, so the dialog asks where it moves.
    await page.goto('/settings/workflow');
    await page.getByRole('button', { name: 'Archive Review' }).click();
    await expect(page.getByTestId('move-issues-dialog')).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Move issues to' })).toHaveText('Todo');
    await page.getByTestId('move-confirm').click();
    await expect(page.getByTestId('state-row-Review')).toHaveCount(0, { timeout: SYNC_MS });

    await page.goto('/');
    await revealIssue(page, 4);
    await expect(issueRow(page, 4).getByRole('button', { name: 'State: Todo' })).toBeVisible({
      timeout: SYNC_MS,
    });
  } finally {
    await setState(page, 4, 'Done');
    await revealIssue(page, 4);
    await expect(issueRow(page, 4).getByRole('button', { name: 'State: Done' })).toBeVisible();
  }

  // The last completed state cannot be archived: the button is off and says why.
  await page.goto('/settings/workflow');
  await expect(page.getByRole('button', { name: 'Archive Done' })).toBeDisabled();
  await expect(
    page.getByTestId('state-row-Done').getByText('Keep at least one completed state.'),
  ).toBeVisible();
  await page.context().close();
});

test('an owner creates a label of the team, then archives it', async ({ browser, baseURL }) => {
  const page = await pageOf(browser, baseURL, 'owner', '/settings/labels');
  await page.getByRole('combobox', { name: 'Labels of' }).click();
  await page.getByRole('option', { name: /ENG/ }).click();

  await page.getByTestId('label-add-open').click();
  await page.getByLabel('Name').fill('Release blocker');
  await page.getByTestId('label-submit').click();
  await expect(page.getByTestId('label-row-Release blocker')).toBeVisible({ timeout: SYNC_MS });

  await page.getByRole('button', { name: 'Archive Release blocker' }).click();
  await expect(page.getByTestId('label-row-Release blocker')).toHaveCount(0, {
    timeout: SYNC_MS,
  });
  await page.context().close();
});
