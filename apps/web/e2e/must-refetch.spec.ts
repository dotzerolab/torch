import { expect, test } from '@playwright/test';
import { createDb } from '../../server/src/db.ts';
import { issueCount } from './helpers/issues.ts';
import { openSessionAs } from './helpers/session.ts';
import { shapesInFlight } from './helpers/shapes-in-flight.ts';

// Electric answers `409 must-refetch` when it can no longer continue a shape from the offset a client holds (the shape
// was compacted or its definition changed). The page must keep showing what the device holds meanwhile, then end with
// exactly what the server says, and go on receiving changes live.
const HOLD_MS = 1500;
const LIVE_MS = 3000;

async function setTitle(number: number, title: string): Promise<void> {
  const db = createDb(process.env.DATABASE_URL as string);
  try {
    await db.pool.query(
      `update issue set title = $1
        where team_id = (select id from team where workspace_id = $2 and key = 'ENG') and number = $3`,
      [title, process.env.E2E_DEMO_WORKSPACE_ID, number],
    );
  } finally {
    await db.close();
  }
}

test('a must-refetch answer: the device copy shows at once, the page ends with the server rows and stays live', async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({ baseURL });
  await openSessionAs(context, baseURL, 'owner');
  const first = await context.newPage();
  const shapes = shapesInFlight(first);
  await first.goto('/teams/ENG');
  await expect.poll(() => issueCount(first)).toBe(50);
  // The first copy to the device is written when the requests go quiet: the next load starts from it.
  await shapes.settle();
  await first.close();

  const fresh = `Refetched ${crypto.randomUUID().slice(0, 8)}`;
  const later = `Live ${crypto.randomUUID().slice(0, 8)}`;
  try {
    // The server moves on while this device is away; its copy is stale.
    await setTitle(6, fresh);

    const page = await context.newPage();
    let answered = false;
    await page.route(/\/api\/sync\/w\/[^/]+\/teams\/[^/]+\/issues(\?|$)/, async (route) => {
      if (answered) return route.continue();
      answered = true;
      // A slow server: the page has the whole of HOLD_MS to show what it has.
      await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
      await route.fulfill({
        status: 409,
        headers: { 'electric-handle': 'x', 'content-type': 'application/json' },
        body: '[{"headers":{"control":"must-refetch"}}]',
      });
    });
    await page.goto('/teams/ENG');

    // At once, from the device: the old title of issue 6 and the other rows, before the server has answered.
    await expect(page.getByTestId('issue-title-6')).toHaveText('ENG issue 6', { timeout: HOLD_MS });
    expect(answered).toBe(true);
    await expect.poll(() => issueCount(page)).toBe(50);

    // The refetch ends with what the server holds: its title, the same 50 rows, none twice.
    await expect(page.getByTestId('issue-title-6')).toHaveText(fresh, { timeout: 10_000 });
    await expect.poll(() => issueCount(page)).toBe(50);
    await expect(page.getByTestId('issue-title-6')).toHaveCount(1);

    // Live again: a change made now arrives without a reload.
    await setTitle(8, later);
    await expect(page.getByTestId('issue-title-8')).toHaveText(later, { timeout: LIVE_MS });
    await page.close();
  } finally {
    await setTitle(6, 'ENG issue 6');
    await setTitle(8, 'ENG issue 8');
    await context.close();
  }
});
