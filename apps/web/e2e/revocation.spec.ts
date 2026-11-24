import { type Browser, expect, type Page, test } from '@playwright/test';
import { createDb } from '../../server/src/db.ts';
import { restoreDemoLayoutNow } from './helpers/demo-layout.ts';
import {
  liveRowCount,
  liveTeamRowCount,
  openTeamShapeInPage,
  persistedCollections,
  persistedRowCount,
} from './helpers/device-store.ts';
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

async function memberId(role: 'admin' | 'member' | 'guest'): Promise<string> {
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

test('revoked rows leave the follower tab too: < 2 s, from its memory', async ({
  browser,
  baseURL,
}) => {
  const owner = await open(browser, baseURL, 'owner');
  await owner.page.goto('/');
  // Two tabs of the member's browser: the first leads and syncs, the second reads through it.
  const member = await open(browser, baseURL, 'member');
  await member.page.goto('/');
  await member.page.getByTestId('team-OPS').click();
  await expect(member.page.getByTestId('issue-title-3')).toHaveValue('OPS issue 3');
  const follower = await member.context.newPage();
  await follower.goto('/');
  await follower.getByTestId('team-OPS').click();
  await expect(follower.getByTestId('issue-title-3')).toHaveValue('OPS issue 3');
  await expect
    .poll(() => liveTeamRowCount(follower, workspaceId(), opsTeamId()), { timeout: 5000 })
    .toBeGreaterThanOrEqual(SEEDED_ISSUES);

  await changeTeam(owner.page, 'remove', opsTeamId(), await memberId('member'));
  await expect(follower.getByTestId('team-OPS')).toHaveCount(0, { timeout: REVOCATION_MS });
  await expect(follower.getByTestId('issue-title-3')).toHaveValue('ENG issue 3', {
    timeout: REVOCATION_MS,
  });
  await expect
    .poll(() => liveTeamRowCount(follower, workspaceId(), opsTeamId()), { timeout: REVOCATION_MS })
    .toBe(0);
  await expect(member.page.getByTestId('team-OPS')).toHaveCount(0, { timeout: REVOCATION_MS });
  // The later specs expect the member back in OPS.
  await changeTeam(owner.page, 'add', opsTeamId(), await memberId('member'));
  await member.context.close();
  await owner.context.close();
});

test('revoked workflow states and team members leave the store too, not only the issues', async ({
  browser,
  baseURL,
}) => {
  const statesPrefix = `workflowStates-${workspaceId()}-${opsTeamId()}`;
  const membersPrefix = `teamMembers-${workspaceId()}-${opsTeamId()}`;
  const owner = await open(browser, baseURL, 'owner');
  await owner.page.goto('/');
  // An admin who is in OPS: opening its member list stores the team's members, opening the team its states and issues.
  await changeTeam(owner.page, 'add', opsTeamId(), await memberId('admin'));
  const admin = await open(browser, baseURL, 'admin');
  await admin.page.goto('/settings/teams');
  await admin.page.getByTestId('team-members-open-OPS').click();
  await warm(admin.page, membersPrefix, 3);
  await admin.page.goto('/');
  await admin.page.getByTestId('team-OPS').click();
  await expect(admin.page.getByTestId('issue-title-3')).toHaveValue('OPS issue 3');
  await warm(admin.page, opsPrefix(), SEEDED_ISSUES);
  await openTeamShapeInPage(admin.page, workspaceId(), opsTeamId(), 'workflowStates');
  await warm(admin.page, statesPrefix, 1);
  await warm(admin.page, membersPrefix, 3);

  await changeTeam(owner.page, 'remove', opsTeamId(), await memberId('admin'));
  await expect(admin.page.getByTestId('team-OPS')).toHaveCount(0, { timeout: REVOCATION_MS });
  for (const prefix of [opsPrefix(), statesPrefix, membersPrefix]) {
    await expect
      .poll(() => persistedRowCount(admin.page, workspaceId(), prefix), { timeout: REVOCATION_MS })
      .toBe(0);
  }
  expect(await persistedCollections(admin.page, workspaceId())).not.toContainEqual(
    expect.stringContaining(opsTeamId()),
  );
  await admin.context.close();
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

async function engTeamId(): Promise<string> {
  const db = createDb(process.env.DATABASE_URL as string);
  try {
    const found = await db.pool.query<{ id: string }>(
      `select id from team where workspace_id = $1 and key = 'ENG'`,
      [workspaceId()],
    );
    return (found.rows[0] as { id: string }).id;
  } finally {
    await db.close();
  }
}

test('guest removed from team loses co-members', async ({ browser, baseURL }, testInfo) => {
  await restoreDemoLayoutNow();
  const owner = await open(browser, baseURL, 'owner');
  await owner.page.goto('/');
  const guest = await open(browser, baseURL, 'guest');
  await guest.page.goto('/');
  await expect(guest.page.getByTestId('team-ENG')).toBeVisible();
  // The guest shares ENG with the owner, the admin and the member: four profiles, itself included.
  const members = `members-${workspaceId()}`;
  await warm(guest.page, members, 4);
  expect(await liveRowCount(guest.page, workspaceId(), 'members')).toBe(4);

  await changeTeam(owner.page, 'remove', await engTeamId(), await memberId('guest'));
  const removedAt = Date.now();
  // The co-members are not the guest's to see any more: gone from the page and from the device, whose copy is what the
  // next visit would show first.
  await expect
    .poll(() => liveRowCount(guest.page, workspaceId(), 'members'), { timeout: REVOCATION_MS })
    .toBe(1);
  await expect
    .poll(() => persistedRowCount(guest.page, workspaceId(), members), { timeout: REVOCATION_MS })
    .toBe(1);
  const took = Date.now() - removedAt;
  testInfo.annotations.push({ type: 'removal-to-store-ms', description: String(took) });
  console.log(`removal to members store: ${took} ms`);
  expect(took).toBeLessThan(REVOCATION_MS);
  await guest.context.close();
  await owner.context.close();
});

test('a deleted issue leaves the device copy of a cold shape, resuming from the stored offset', async ({
  browser,
  baseURL,
}, testInfo) => {
  await restoreDemoLayoutNow();
  const eng = await engTeamId();
  const db = createDb(process.env.DATABASE_URL as string);
  const prefix = `issues-${workspaceId()}-${eng}`;
  try {
    await db.pool.query(`delete from issue where team_id = $1 and number >= 900`, [eng]);
    await db.pool.query(
      `insert into issue (workspace_id, team_id, number, title, state_id, creator_id)
       select workspace_id, team_id, 900, 'E2E temporary', state_id, creator_id
         from issue where team_id = $1 and number = 1`,
      [eng],
    );
    const owner = await open(browser, baseURL, 'owner');
    await owner.page.goto('/');
    await expect(owner.page.getByTestId('issue-title-3')).toHaveValue('ENG issue 3');
    // The cold copy holds the seeded issues and the temporary one.
    await warm(owner.page, prefix, SEEDED_ISSUES + 1);

    const shapeRequests: string[] = [];
    owner.page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname.endsWith(`/teams/${eng}/issues`)) shapeRequests.push(url.search);
    });
    await db.pool.query(`delete from issue where team_id = $1 and number = 900`, [eng]);
    const deletedAt = Date.now();
    await expect
      .poll(() => persistedRowCount(owner.page, workspaceId(), prefix), { timeout: REVOCATION_MS })
      .toBe(SEEDED_ISSUES);
    testInfo.annotations.push({
      type: 'delete-to-store-ms',
      description: String(Date.now() - deletedAt),
    });
    // Resumed, not downloaded again: no request started the shape over (`offset=-1`), and the device copy's own pass
    // asked from a stored position.
    expect(shapeRequests.filter((search) => search.includes('offset=-1'))).toEqual([]);
    expect(shapeRequests.some((search) => /offset=\d+_\d+/.test(search))).toBe(true);
    await owner.context.close();
  } finally {
    await db.pool.query(`delete from issue where team_id = $1 and number >= 900`, [eng]);
    await db.close();
  }
});
