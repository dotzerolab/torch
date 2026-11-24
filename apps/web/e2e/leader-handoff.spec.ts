import { expect, type Page, test } from '@playwright/test';
import { addSecondWorkspace } from './helpers/second-workspace.ts';
import { openSessionAs } from './helpers/session.ts';

/** Counts the shape requests a page makes from now on. */
function countSyncRequests(page: Page): { count: () => number } {
  let n = 0;
  page.on('request', (request) => {
    if (request.url().includes('/api/sync/')) n += 1;
  });
  return { count: () => n };
}

test('a tab that switched to another workspace does not keep the lock of the first: the other tabs take over', async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({ baseURL });
  await openSessionAs(context, baseURL, 'owner');
  const second = await addSecondWorkspace(context);
  let other: Awaited<ReturnType<typeof browser.newContext>> | null = null;
  try {
    // The first tab opens first and leads the demo workspace; two more tabs follow it.
    const leader = await context.newPage();
    await leader.goto('/');
    await expect(leader.getByTestId('issue-title-3')).toHaveValue('ENG issue 3');
    const switcher = await context.newPage();
    await switcher.goto('/');
    await expect(switcher.getByTestId('issue-title-3')).toHaveValue('ENG issue 3');
    const follower = await context.newPage();
    const followerRequests = countSyncRequests(follower);
    await follower.goto('/');
    await expect(follower.getByTestId('issue-title-3')).toHaveValue('ENG issue 3');
    expect(followerRequests.count()).toBe(0);

    // One follower leaves the demo workspace for the second one, then the leader tab closes: the waiting lock goes to a
    // tab that no longer shows the workspace unless that tab let go of it when it left.
    await switcher.getByRole('button', { name: 'Switch workspace' }).click();
    await switcher.getByText(second.name).click();
    await expect(switcher.getByTestId('workspace-name').first()).toContainText(second.name);
    await leader.close();

    // The tab that stayed takes over within 3 s: it starts to ask for its shapes (the tab that left must not have the lock).
    await expect.poll(() => followerRequests.count(), { timeout: 3000 }).toBeGreaterThan(0);

    // The tab on the second workspace goes away before the live check. A browser lets a profile hold about six open
    // connections per origin on HTTP/1.1, and every led workspace keeps four long polls (three of the workspace and the
    // issues of a team): two led workspaces are eight, so one of them would wait for a slot and the check below would
    // measure the connection pool, not the takeover. The lock was already shown to have passed to the follower.
    await switcher.close();

    // The promoted tab stays live: an edit made on another device reaches it.
    other = await browser.newContext({ baseURL });
    await openSessionAs(other, baseURL, 'owner');
    const remote = await other.newPage();
    await remote.goto('/');
    await expect(remote.getByTestId('issue-title-7')).toBeVisible();
    const title = `Handoff ${crypto.randomUUID().slice(0, 8)}`;
    const answered = remote.waitForResponse(
      (response) => response.request().method() === 'PATCH' && response.url().includes('/issues/'),
    );
    await remote.getByTestId('issue-title-7').fill(title);
    await remote.getByTestId('issue-title-7').press('Enter');
    await answered;
    await expect(follower.getByTestId('issue-title-7')).toHaveValue(title, { timeout: 4000 });

    // The other specs read the seeded title.
    const restored = remote.waitForResponse(
      (response) => response.request().method() === 'PATCH' && response.url().includes('/issues/'),
    );
    await remote.getByTestId('issue-title-7').fill('ENG issue 7');
    await remote.getByTestId('issue-title-7').press('Enter');
    await restored;
  } finally {
    await other?.close();
    await context.close();
    await second.remove();
  }
});
