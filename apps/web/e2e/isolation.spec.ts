import { expect, test } from '@playwright/test';
import { issueCount, issueTitle } from './helpers/issues.ts';
import { signInAs } from './helpers/sign-in.ts';

const workspaceId = () => process.env.E2E_DEMO_WORKSPACE_ID as string;
const opsTeamId = () => process.env.E2E_DEMO_OPS_TEAM_ID as string;

test('guest sees ENG only', async ({ page }) => {
  await signInAs(page, 'guest');

  await expect(page.getByTestId('team-ENG')).toBeVisible();
  await expect(page.getByTestId('team-OPS')).toHaveCount(0);
  await expect(issueTitle(page, 1)).toHaveText('ENG issue 1');
  await expect.poll(() => issueCount(page)).toBe(50);
});

test('guest request to the OPS issues shape answers 404', async ({ page }) => {
  await signInAs(page, 'guest');
  const base = `/api/sync/w/${workspaceId()}/teams`;

  const ops = await page.request.get(`${base}/${opsTeamId()}/issues?offset=-1`);
  const unknown = await page.request.get(
    `${base}/00000000-0000-4000-8000-000000000000/issues?offset=-1`,
  );

  expect(ops.status()).toBe(404);
  // Same answer as for a team that does not exist: nothing confirms that OPS is there.
  expect(await ops.text()).toBe(await unknown.text());
});
