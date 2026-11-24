import { expect, test } from '@playwright/test';
import {
  deleteTeamRowsInPage,
  persistedCollections,
  persistedRowCount,
  storageNames,
} from './helpers/device-store.ts';
import { openSessionAs } from './helpers/session.ts';

const workspaceId = () => process.env.E2E_DEMO_WORKSPACE_ID as string;
const opsTeamId = () => process.env.E2E_DEMO_OPS_TEAM_ID as string;

// The seeded teams hold 50 issues each.
const SEEDED_ISSUES = 50;

test('warm start renders before network', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  await openSessionAs(context, baseURL, 'owner');
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.getByTestId('issue-title-3')).toHaveValue('ENG issue 3');
  // The device copy is written in the background: wait until the whole team list is on it.
  await expect
    .poll(() => persistedRowCount(page, workspaceId(), 'issues-'), { timeout: 10_000 })
    .toBeGreaterThanOrEqual(SEEDED_ISSUES);

  // The network answers nothing from now on: the next visit has only the device copy.
  await context.route('**/api/sync/**', (route) => route.abort('connectionfailed'));
  await page.reload();

  await expect(page.getByTestId('issue-title-3')).toHaveValue('ENG issue 3', { timeout: 3000 });
  await expect(page.getByTestId('team-ENG')).toBeVisible();
  await context.close();
});

test('sign-out wipes the signed-out workspace from OPFS and IndexedDB, and leaves other stores', async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({ baseURL });
  await openSessionAs(context, baseURL, 'owner');
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.getByTestId('issue-title-3')).toHaveValue('ENG issue 3');
  await expect
    .poll(() => persistedRowCount(page, workspaceId(), 'issues-'), { timeout: 10_000 })
    .toBeGreaterThanOrEqual(SEEDED_ISSUES);

  // Another person's store on the same origin (a shared computer): it must survive.
  const other = 'ws-00000000-0000-4000-8000-000000000000-v1';
  await page.evaluate(async (name) => {
    const root = await navigator.storage.getDirectory();
    await root.getFileHandle(name, { create: true });
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(`${name}-outbox`, 1);
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
      request.onerror = () => reject(request.error);
    });
  }, other);

  const before = await storageNames(page);
  expect(before.opfs.some((name) => name.startsWith(`ws-${workspaceId()}-`))).toBe(true);

  await page.getByTestId('sign-out').click();
  await expect(page).toHaveURL(/\/login$/);

  const after = await storageNames(page);
  const mine = (name: string) => name.startsWith(`ws-${workspaceId()}-`);
  expect(after.opfs.filter(mine)).toEqual([]);
  expect(after.indexedDb.filter(mine)).toEqual([]);
  expect(after.opfs).toContain(other);
  expect(after.indexedDb).toContain(`${other}-outbox`);
  await context.close();
});

test('losing a team deletes its rows from the real store and keeps the other teams', async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({ baseURL });
  await openSessionAs(context, baseURL, 'owner');
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.getByTestId('issue-title-3')).toHaveValue('ENG issue 3');
  await page.getByTestId('team-OPS').click();
  await expect(page.getByTestId('issue-title-3')).toHaveValue('OPS issue 3');
  await expect
    .poll(() => persistedRowCount(page, workspaceId(), `issues-${workspaceId()}-${opsTeamId()}`), {
      timeout: 10_000,
    })
    .toBeGreaterThanOrEqual(SEEDED_ISSUES);
  const opsPrefix = `issues-${workspaceId()}-${opsTeamId()}`;
  const all = await persistedRowCount(page, workspaceId(), 'issues-');
  const ops = await persistedRowCount(page, workspaceId(), opsPrefix);
  expect(all).toBeGreaterThan(ops); // ENG is on the device too
  expect(await persistedCollections(page, workspaceId())).toEqual(
    expect.arrayContaining([expect.stringContaining(opsTeamId())]),
  );

  await deleteTeamRowsInPage(page, workspaceId(), opsTeamId());

  const left = await persistedCollections(page, workspaceId());
  expect(left.filter((id) => id.includes(opsTeamId()))).toEqual([]);
  expect(await persistedRowCount(page, workspaceId(), opsPrefix)).toBe(0);
  // Every other team's rows are still there.
  expect(await persistedRowCount(page, workspaceId(), 'issues-')).toBe(all - ops);
  await context.close();
});
