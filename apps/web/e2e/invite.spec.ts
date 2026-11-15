import { expect, test } from '@playwright/test';
import { restoreDemoLayoutNow } from './helpers/demo-layout.ts';
import { clearMailbox, latestInviteLink } from './helpers/mailpit.ts';
import { openSessionAs } from './helpers/session.ts';

const GUEST_EMAIL = 'new-guest@example.test';

test.afterAll(restoreDemoLayoutNow);

test('an owner invites a guest into ENG; the guest joins from the link and sees ENG only', async ({
  browser,
  baseURL,
}) => {
  await clearMailbox(GUEST_EMAIL);

  // The owner sends the invitation from the members page.
  const ownerContext = await browser.newContext({ baseURL });
  await openSessionAs(ownerContext, baseURL, 'owner');
  const owner = await ownerContext.newPage();
  await owner.goto('/settings/members');
  await owner.getByTestId('invite-open').click();
  const dialog = owner.getByRole('dialog');
  await dialog.getByLabel('Email', { exact: true }).fill(GUEST_EMAIL);
  await dialog.getByRole('combobox', { name: 'Role', exact: true }).click();
  await owner.getByRole('option', { name: 'Guest' }).click();
  await dialog.getByRole('checkbox', { name: /Engineering/ }).check();
  await dialog.getByTestId('invite-submit').click();
  await expect(owner.getByTestId(`invite-${GUEST_EMAIL}`)).toBeVisible();

  // The link: the page names the workspace and the role, and the address bar keeps no token.
  const link = await latestInviteLink(GUEST_EMAIL);
  const guestContext = await browser.newContext({ baseURL });
  const guest = await guestContext.newPage();
  await guest.goto(link);
  await expect(guest.getByTestId('invite-workspace')).toContainText('Demo');
  await expect(guest.getByTestId('invite-role')).toContainText('Guest');
  expect(guest.url()).not.toContain('token');
  expect(new URL(guest.url()).hash).toBe('');

  // Accepting with a name signs the guest in: ENG is there, OPS is not.
  await guest.getByLabel('Your name').fill('New Guest');
  await guest.getByTestId('invite-accept').click();
  await expect(guest.getByTestId('workspace-name')).toBeVisible();
  await expect(guest.getByTestId('team-ENG')).toBeVisible();
  await expect(guest.getByTestId('team-OPS')).toHaveCount(0);

  // A guest has no members page.
  await guest.goto('/settings/members');
  await expect(guest.getByTestId('no-access')).toBeVisible();
  await expect(guest.getByTestId('members-table')).toHaveCount(0);
  await expect(guest.getByTestId('settings-tab-members')).toHaveCount(0);

  // The link is spent.
  const stranger = await (await browser.newContext({ baseURL })).newPage();
  await stranger.goto(link);
  await expect(stranger.getByTestId('invite-invalid')).toBeVisible();

  await stranger.context().close();
  await guestContext.close();
  await ownerContext.close();
});
