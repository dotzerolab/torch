import { type Browser, expect, type Page, test } from '@playwright/test';
import { createDb } from '../../server/src/db.ts';
import { restoreDemoLayoutNow } from './helpers/demo-layout.ts';
import { openSessionAs } from './helpers/session.ts';
import { demoEmail } from './helpers/sign-in.ts';

// The test moves a person out of a team; later specs expect the seeded layout.
test.describe.configure({ mode: 'serial' });
test.afterAll(restoreDemoLayoutNow);

const workspaceId = () => process.env.E2E_DEMO_WORKSPACE_ID as string;
const opsTeamId = () => process.env.E2E_DEMO_OPS_TEAM_ID as string;
const REMOVAL_MS = 2000;

async function memberId(role: 'member'): Promise<string> {
  const db = createDb(process.env.DATABASE_URL as string);
  try {
    const found = await db.pool.query<{ id: string }>(
      'select id from member where workspace_id = $1 and email = $2',
      [workspaceId(), demoEmail(role)],
    );
    return (found.rows[0] as { id: string }).id;
  } finally {
    await db.close();
  }
}

async function open(browser: Browser, baseURL: string | undefined, role: 'owner' | 'member') {
  const context = await browser.newContext({ baseURL });
  await openSessionAs(context, baseURL, role);
  return { context, page: await context.newPage() };
}

const sections = (page: Page) => page.locator('.issue-section__title');

test('a member sees the issues assigned to them in both teams, grouped by team', async ({
  browser,
  baseURL,
}) => {
  const { context, page } = await open(browser, baseURL, 'member');
  await page.goto('/');
  await page.getByTestId('nav-my-issues').click();
  await expect(page).toHaveURL(/\/my-issues$/);
  await expect(page.getByRole('tab', { name: 'Assigned' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  // The default is by state type; the display menu offers the team.
  await expect(sections(page).first()).toContainText(
    /Backlog|Unstarted|Started|Completed|Canceled/,
  );
  await page.goto('/my-issues?group=team');
  await expect(sections(page).filter({ hasText: 'Engineering' })).toBeVisible();
  await expect(sections(page).filter({ hasText: 'Operations' })).toBeVisible();
  // A row carries the number of its own team.
  await expect(page.getByText(/^ENG-\d+$/).first()).toBeVisible();
  await expect(page.getByText(/^OPS-\d+$/).first()).toBeVisible();
  await context.close();
});

test('the Created tab holds what the person made, and the tab is in the address', async ({
  browser,
  baseURL,
}) => {
  const { context, page } = await open(browser, baseURL, 'owner');
  await page.goto('/my-issues');
  await page.getByRole('tab', { name: 'Created' }).click();
  await expect(page).toHaveURL(/\/my-issues\?tab=created$/);
  // The seeded issues are all made by the owner, in both teams.
  await page.goto('/my-issues?tab=created&group=team');
  await expect(sections(page).filter({ hasText: 'Engineering' })).toBeVisible();
  // Rows are windowed: the second team's rows are on the page once the list is scrolled to its end.
  await page.locator('.issue-list').evaluate((list) => list.scrollTo({ top: list.scrollHeight }));
  await expect(page.getByText(/^OPS-\d+$/).first()).toBeVisible();
  await context.close();
});

test('a click on a row opens the issue page', async ({ browser, baseURL }) => {
  const { context, page } = await open(browser, baseURL, 'owner');
  await page.goto('/my-issues?tab=created&group=team');
  await page
    .getByText(/^ENG-\d+$/)
    .first()
    .click();
  await expect(page).toHaveURL(/\/issues\/ENG-\d+$/);
  await context.close();
});

test('removed from OPS, its rows leave My Issues within 2 s and the ENG rows stay', async ({
  browser,
  baseURL,
}) => {
  const owner = await open(browser, baseURL, 'owner');
  await owner.page.goto('/');
  const member = await open(browser, baseURL, 'member');
  await member.page.goto('/my-issues?group=team');
  await expect(sections(member.page).filter({ hasText: 'Operations' })).toBeVisible();
  await expect(sections(member.page).filter({ hasText: 'Engineering' })).toBeVisible();

  const removedAt = Date.now();
  const status = await owner.page.evaluate(
    async ({ workspaceId, teamId, member }) => {
      const response = await fetch(`/api/w/${workspaceId}/teams/${teamId}/members/${member}`, {
        method: 'DELETE',
      });
      return response.status;
    },
    { workspaceId: workspaceId(), teamId: opsTeamId(), member: await memberId('member') },
  );
  expect(status).toBeLessThan(300);
  await expect(sections(member.page).filter({ hasText: 'Operations' })).toHaveCount(0, {
    timeout: REMOVAL_MS,
  });
  await expect(sections(member.page).filter({ hasText: 'Engineering' })).toBeVisible();
  await expect(member.page.getByText(/^OPS-\d+$/)).toHaveCount(0);
  expect(Date.now() - removedAt).toBeLessThan(REMOVAL_MS + 1000);
  await member.context.close();
  await owner.context.close();
});
