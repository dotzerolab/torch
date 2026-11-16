import { type Browser, expect, type Page, test } from '@playwright/test';
import { createDb } from '../../server/src/db.ts';
import { restoreDemoLayoutNow } from './helpers/demo-layout.ts';
import { persistedCollections, persistedRowCount } from './helpers/device-store.ts';
import { openSessionAs } from './helpers/session.ts';
import { demoEmail } from './helpers/sign-in.ts';

// The tests move people in and out of teams, one after the other; later specs expect the seeded layout.
test.describe.configure({ mode: 'serial' });
test.afterAll(restoreDemoLayoutNow);

const workspaceId = () => process.env.E2E_DEMO_WORKSPACE_ID as string;
const opsTeamId = () => process.env.E2E_DEMO_OPS_TEAM_ID as string;
const opsPrefix = () => `issues-${workspaceId()}-${opsTeamId()}`;
const SEEDED_ISSUES = 50;
const REVOCATION_MS = 2000;

async function memberId(role: 'member' | 'guest'): Promise<string> {
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

async function open(
  browser: Browser,
  baseURL: string | undefined,
  role: 'owner' | 'member' | 'guest',
) {
  const context = await browser.newContext({ baseURL });
  await openSessionAs(context, baseURL, role);
  return { context, page: await context.newPage() };
}

/** The owner changes a team's membership through the page's own origin, as the settings screen does. */
async function changeTeam(
  owner: Page,
  action: 'add' | 'remove',
  teamId: string,
  member: string,
): Promise<void> {
  const status = await owner.evaluate(
    async ({ action, workspaceId, teamId, member }) => {
      const base = `/api/w/${workspaceId}/teams/${teamId}/members`;
      const response =
        action === 'add'
          ? await fetch(base, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ memberId: member }),
            })
          : await fetch(`${base}/${member}`, { method: 'DELETE' });
      return response.status;
    },
    { action, workspaceId: workspaceId(), teamId, member },
  );
  expect(status).toBeLessThan(300);
}

async function warm(page: Page, prefix: string, rows: number) {
  await expect
    .poll(() => persistedRowCount(page, workspaceId(), prefix), { timeout: 15_000 })
    .toBeGreaterThanOrEqual(rows);
}

test('revoked rows leave < 2 s: gone from the page and from the store', async ({
  browser,
  baseURL,
}) => {
  const owner = await open(browser, baseURL, 'owner');
  await owner.page.goto('/');
  const member = await open(browser, baseURL, 'member');
  await member.page.goto('/');
  await member.page.getByTestId('team-OPS').click();
  await expect(member.page.getByTestId('issue-title-3')).toHaveValue('OPS issue 3');
  await warm(member.page, opsPrefix(), SEEDED_ISSUES);

  const startedAt = Date.now();
  await changeTeam(owner.page, 'remove', opsTeamId(), await memberId('member'));
  await expect(member.page.getByTestId('team-OPS')).toHaveCount(0, { timeout: REVOCATION_MS });
  await expect(member.page.getByTestId('issue-title-3')).toHaveValue('ENG issue 3', {
    timeout: REVOCATION_MS,
  });
  await expect
    .poll(() => persistedRowCount(member.page, workspaceId(), opsPrefix()), {
      timeout: REVOCATION_MS,
    })
    .toBe(0);
  expect(await persistedCollections(member.page, workspaceId())).not.toContainEqual(
    expect.stringContaining(opsTeamId()),
  );
  expect(Date.now() - startedAt).toBeLessThan(REVOCATION_MS + 1000);
  await member.context.close();
  await owner.context.close();
});

test('join reaches open page < 2 s', async ({ browser, baseURL }) => {
  const owner = await open(browser, baseURL, 'owner');
  await owner.page.goto('/');
  const member = await open(browser, baseURL, 'member');
  await member.page.goto('/');
  await expect(member.page.getByTestId('team-ENG')).toBeVisible();
  await expect(member.page.getByTestId('team-OPS')).toHaveCount(0);

  await changeTeam(owner.page, 'add', opsTeamId(), await memberId('member'));
  await expect(member.page.getByTestId('team-OPS')).toBeVisible({ timeout: REVOCATION_MS });
  await member.page.getByTestId('team-OPS').click();
  await expect(member.page.getByTestId('issue-title-3')).toHaveValue('OPS issue 3', {
    timeout: REVOCATION_MS,
  });
  await member.context.close();
  await owner.context.close();
});

test('a team lost while the app was closed: its rows never show once the network answers and leave the store', async ({
  browser,
  baseURL,
}) => {
  await restoreDemoLayoutNow();
  const owner = await open(browser, baseURL, 'owner');
  await owner.page.goto('/');
  const member = await open(browser, baseURL, 'member');
  await member.page.goto('/');
  await member.page.getByTestId('team-OPS').click();
  await expect(member.page.getByTestId('issue-title-3')).toHaveValue('OPS issue 3');
  await warm(member.page, opsPrefix(), SEEDED_ISSUES);
  await member.page.close();

  // Access ends while no page of the member is open.
  await changeTeam(owner.page, 'remove', opsTeamId(), await memberId('member'));

  const reopened = await member.context.newPage();
  const answered = reopened.waitForResponse((response) =>
    new URL(response.url()).pathname.startsWith('/api/sync/'),
  );
  await reopened.goto(`/teams/OPS`);
  await answered;
  // Once the network has answered, the old rows are gone from the page and, shortly after, from the store.
  await expect(reopened.getByTestId('team-OPS')).toHaveCount(0, { timeout: REVOCATION_MS });
  await expect(reopened.locator('input[value^="OPS issue"]')).toHaveCount(0);
  await expect
    .poll(() => persistedRowCount(reopened, workspaceId(), opsPrefix()), { timeout: REVOCATION_MS })
    .toBe(0);
  await member.context.close();
  await owner.context.close();
});
