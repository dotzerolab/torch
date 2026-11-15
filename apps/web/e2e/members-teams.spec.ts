import { type Browser, expect, type Page, test } from '@playwright/test';
import { restoreDemoLayoutNow } from './helpers/demo-layout.ts';
import { openSessionAs } from './helpers/session.ts';
import type { DemoRole } from './helpers/sign-in.ts';

// The tests change the demo workspace in order (deactivate, team, removal), so they run one after the other; the
// global setup puts the workspace back before every run.
test.describe.configure({ mode: 'serial' });

const SYNC_MS = 10_000;

// Later specs expect the seeded layout (ENG first, the guest in it): put it back when this file is done.
test.afterAll(restoreDemoLayoutNow);

async function pageOf(browser: Browser, baseURL: string | undefined, role: DemoRole, path = '/') {
  const context = await browser.newContext({ baseURL });
  await openSessionAs(context, baseURL, role);
  const page = await context.newPage();
  await page.goto(path);
  return page;
}

async function openRowMenu(page: Page, handle: string, name: string, item: string) {
  await expect(page.getByTestId(`member-row-${handle}`)).toBeVisible();
  await page.getByRole('button', { name: `Actions for ${name}` }).click();
  await page.getByRole('menuitem', { name: item }).click();
}

test('an admin is never offered the owner or admin role', async ({ browser, baseURL }) => {
  const admin = await pageOf(browser, baseURL, 'admin', '/settings/members');
  await expect(admin.getByTestId('member-row-member')).toBeVisible();

  await admin.getByRole('combobox', { name: 'Role of Member Example' }).click();
  await expect(admin.getByRole('option')).toHaveText(['Member', 'Guest']);
  await admin.keyboard.press('Escape');

  // Owners and admins cannot be moved by an admin, and nobody moves themselves.
  await expect(admin.getByRole('combobox', { name: 'Role of Owner Example' })).toBeDisabled();
  await expect(admin.getByRole('combobox', { name: 'Role of Admin Example' })).toBeDisabled();
  await admin.context().close();
});

test('an owner deactivates the guest: the guest is signed out on the next navigation', async ({
  browser,
  baseURL,
}) => {
  const guest = await pageOf(browser, baseURL, 'guest');
  await expect(guest.getByTestId('team-ENG')).toBeVisible();
  const owner = await pageOf(browser, baseURL, 'owner', '/settings/members');

  await openRowMenu(owner, 'guest', 'Guest Example', 'Deactivate');
  await owner.getByTestId('confirm-toggle').click();
  await expect(
    owner.getByTestId('member-row-guest').getByText('Deactivated', { exact: true }),
  ).toBeVisible({ timeout: SYNC_MS });

  await guest.goto('/');
  await expect(guest).toHaveURL(/\/login$/);

  // Bring the guest back: the row is active again.
  await openRowMenu(owner, 'guest', 'Guest Example', 'Reactivate');
  await owner.getByTestId('confirm-toggle').click();
  await expect(
    owner.getByTestId('member-row-guest').getByText('Active', { exact: true }),
  ).toBeVisible({
    timeout: SYNC_MS,
  });
  await guest.context().close();
  await owner.context().close();
});

test('an owner creates the team DOCS and adds the member: the member sees it after the sync', async ({
  browser,
  baseURL,
}) => {
  const member = await pageOf(browser, baseURL, 'member');
  await expect(member.getByTestId('team-ENG')).toBeVisible();
  await expect(member.getByTestId('team-DOCS')).toHaveCount(0);
  const owner = await pageOf(browser, baseURL, 'owner', '/settings/teams');

  await owner.getByTestId('new-team-open').click();
  const dialog = owner.getByRole('dialog');
  await dialog.getByLabel('Key').fill('DOCS');
  await dialog.getByLabel('Name', { exact: true }).fill('Documentation');
  await dialog.getByTestId('new-team-submit').click();
  await expect(owner.getByTestId('team-row-DOCS')).toBeVisible({ timeout: SYNC_MS });

  await owner.getByTestId('team-members-open-DOCS').click();
  const editor = owner.getByRole('dialog');
  await editor.getByRole('combobox', { name: 'Add a member' }).click();
  await owner.getByRole('option', { name: 'Member Example' }).click();
  await editor.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(editor.getByRole('button', { name: 'Remove Member Example' })).toBeVisible({
    timeout: SYNC_MS,
  });

  await expect(member.getByTestId('team-DOCS')).toBeVisible({ timeout: SYNC_MS });
  await member.context().close();
  await owner.context().close();
});

test('a guest removed from ENG no longer sees it after a reload', async ({ browser, baseURL }) => {
  const guest = await pageOf(browser, baseURL, 'guest');
  await expect(guest.getByTestId('team-ENG')).toBeVisible();
  const owner = await pageOf(browser, baseURL, 'owner', '/settings/teams');

  await owner.getByTestId('team-members-open-ENG').click();
  const editor = owner.getByRole('dialog');
  await editor.getByRole('button', { name: 'Remove Guest Example' }).click();
  await expect(editor.getByRole('button', { name: 'Remove Guest Example' })).toHaveCount(0, {
    timeout: SYNC_MS,
  });

  await guest.reload();
  await expect(guest.getByTestId('workspace-name')).toBeVisible();
  await expect(guest.getByTestId('team-ENG')).toHaveCount(0);
  await guest.context().close();
  await owner.context().close();
});

test('a member edits their own profile and sees the new name', async ({ browser, baseURL }) => {
  const member = await pageOf(browser, baseURL, 'member', '/settings/profile');
  const name = member.getByLabel('Name', { exact: true });
  await expect(name).toHaveValue('Member Example');

  await name.fill('Member Renamed');
  await member.getByTestId('profile-save').click();
  await expect(member.getByText('Profile saved.')).toBeVisible();

  await member.reload();
  await expect(member.getByLabel('Name', { exact: true })).toHaveValue('Member Renamed');
  await member.context().close();
});
