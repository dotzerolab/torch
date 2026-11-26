import { expect, type Page, test } from '@playwright/test';
import { seedPerf } from '../../server/src/cli/seed-perf.ts';
import { createDb } from '../../server/src/db.ts';
import { issueTitle, issueTitleInput } from './helpers/issues.ts';
import { openSessionAs } from './helpers/session.ts';

// The sync bar on 10,000 issues (docs/design.md section 14, ADR 0001 sections 2 and 5), measured in real Chromium
// against the dev server (React in development mode, so these numbers are a ceiling, not a best case):
//   local update < 100 ms, remote change < 1 s, cold start to interactive < 3 s, first remote edit after a cold load
//   < 1 s, and on the issue views: filter change, list/board switch and peek open < 100 ms (from the click to the frame
//   that shows the result; the median of three). `pnpm e2e:perf` runs it; `pnpm e2e` does not.
test.describe.configure({ mode: 'serial' });
test.setTimeout(120_000);

const LOCAL_UPDATE_MS = 100;
const REMOTE_CHANGE_MS = 1000;
const COLD_START_MS = 3000;
const FIRST_REMOTE_EDIT_MS = 1000;
const VIEW_ACTION_MS = 100;
const PERF_COUNT = 10_000;
// Seeded priorities are the issue index modulo five, so one issue in five is urgent.
const URGENT_ISSUES = 2000;
const SHAPES_MODULE = '/src/sync/shapes.ts';

type PerfIds = { workspaceId: string; teamId: string; issues: Record<number, string> };
let ids: PerfIds;

// Each run changes a few titles; this puts them back so a re-run starts from the seeded state.
const EDITED = [7, 13, 19];

test.beforeAll(async () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set (see .env.example)');
  const db = createDb(databaseUrl);
  try {
    await seedPerf(db.orm);
    await db.pool.query(
      `update issue set title = 'PERF issue ' || number
        where team_id = (select t.id from team t join workspace w on w.id = t.workspace_id
                          where w.slug = 'perf' and t.key = 'PERF')
          and number = any($1) and title <> 'PERF issue ' || number`,
      [EDITED],
    );
    const found = await db.pool.query<{
      workspace_id: string;
      team_id: string;
      id: string;
      number: number;
    }>(
      `select i.workspace_id, i.team_id, i.id, i.number
         from issue i join team t on t.id = i.team_id join workspace w on w.id = t.workspace_id
        where w.slug = 'perf' and t.key = 'PERF' and i.number = any($1)`,
      [EDITED],
    );
    const first = found.rows[0];
    if (!first) throw new Error('the performance workspace has no issues');
    ids = {
      workspaceId: first.workspace_id,
      teamId: first.team_id,
      issues: Object.fromEntries(found.rows.map((row) => [row.number, row.id])),
    };
  } finally {
    await db.close();
  }
});

async function openPerfPage(browser: import('@playwright/test').Browser, baseURL?: string) {
  const context = await browser.newContext({ baseURL });
  await openSessionAs(context, baseURL, 'owner', 'perf');
  return { context, page: await context.newPage() };
}

/** The page is interactive when the first issue is on screen. The list is windowed: the rows the specs edit (numbers 7, 13 and 19, all in the first group) are near the top. */
async function coldStart(page: Page): Promise<number> {
  await page.goto('/');
  await page.getByTestId('issue-title-1').waitFor({ state: 'visible' });
  // `performance.now()` counts from the start of the navigation.
  return page.evaluate(() => performance.now());
}

/** Changes a title in the database and returns how long the open page took to show it. */
async function remoteChange(page: Page, number: number, title: string): Promise<number> {
  const databaseUrl = process.env.DATABASE_URL as string;
  const db = createDb(databaseUrl);
  try {
    const arrived = page.evaluate(
      ({ testid, title }) =>
        new Promise<number>((resolve) => {
          const timer = setInterval(() => {
            const title_ = document.querySelector(`[data-testid="${testid}"]`);
            if (title_?.textContent === title) {
              clearInterval(timer);
              resolve(Date.now());
            }
          }, 5);
        }),
      { testid: `issue-title-${number}`, title },
    );
    await db.pool.query('update issue set title = $1 where id = $2', [title, ids.issues[number]]);
    const committed = Date.now();
    return (await arrived) - committed;
  } finally {
    await db.close();
  }
}

const report = (name: string, ms: number) => console.info(`@perf ${name} ${Math.round(ms)} ms`);

test('@perf cold start to interactive < 3 s', async ({ browser, baseURL }) => {
  const { context, page } = await openPerfPage(browser, baseURL);
  const ms = await coldStart(page);
  report('cold-start', ms);
  expect(ms).toBeLessThan(COLD_START_MS);
  await context.close();
});

test('@perf first remote edit after cold load < 1 s', async ({ browser, baseURL }) => {
  // A new browser context has no device copy: this is the first visit, with the whole list still being written to it.
  const { context, page } = await openPerfPage(browser, baseURL);
  await coldStart(page);
  const ms = await remoteChange(page, 13, `First edit ${crypto.randomUUID().slice(0, 8)}`);
  report('first-remote-edit', ms);
  expect(ms).toBeLessThan(FIRST_REMOTE_EDIT_MS);
  await context.close();
});

test('@perf remote change < 1 s and local update < 100 ms on a settled page', async ({
  browser,
  baseURL,
}) => {
  const { context, page } = await openPerfPage(browser, baseURL);
  await coldStart(page);
  // Settled: the first sync and its writes to the device are done.
  await page.waitForTimeout(5000);

  const remote = await remoteChange(page, 7, `Remote ${crypto.randomUUID().slice(0, 8)}`);
  report('remote-change', remote);
  expect(remote).toBeLessThan(REMOTE_CHANGE_MS);

  const title = `Local ${crypto.randomUUID().slice(0, 8)}`;
  await issueTitle(page, 19).dblclick();
  const field = issueTitleInput(page, 19);
  await expect(field).toBeVisible();
  // From the Enter key to the optimistic row being on screen: the collection holds the new title and a frame was drawn.
  const shown = page.evaluate(
    ({ module, workspaceId, teamId, issueId, title, testid }) =>
      new Promise<number>((resolve, reject) => {
        const input = document.querySelector<HTMLInputElement>(`[data-testid="${testid}"]`);
        if (!input) return reject(new Error('the rename field is not on the page'));
        input.addEventListener(
          'keydown',
          async (event) => {
            if (event.key !== 'Enter') return;
            const started = performance.now();
            const { syncRegistry } = await import(/* @vite-ignore */ module);
            const issues = syncRegistry.get({ kind: 'issues', workspaceId, teamId });
            const tick = () => {
              if (issues.get(issueId)?.title !== title) return setTimeout(tick, 0);
              requestAnimationFrame(() => resolve(performance.now() - started));
            };
            tick();
          },
          { capture: true, once: true },
        );
      }),
    {
      module: SHAPES_MODULE,
      workspaceId: ids.workspaceId,
      teamId: ids.teamId,
      issueId: ids.issues[19],
      title,
      testid: 'issue-title-input-19',
    },
  );
  await field.fill(title);
  await field.press('Enter');
  const local = await shown;
  report('local-update', local);
  expect(local).toBeLessThan(LOCAL_UPDATE_MS);
  await context.close();
});

/**
 * Starts a timer at the next click anywhere on the page and stops it at the first frame drawn after `ready` (source of a
 * function body expression, checked on every change of the page) holds. Call it before the click and await it after.
 */
function timeNextClick(page: Page, ready: string): Promise<number> {
  return page.evaluate(
    (source) =>
      new Promise<number>((resolve) => {
        const holds = new Function(`return (${source});`) as () => boolean;
        document.addEventListener(
          'click',
          () => {
            const started = performance.now();
            const done = () => requestAnimationFrame(() => resolve(performance.now() - started));
            if (holds()) return done();
            const observer = new MutationObserver(() => {
              if (!holds()) return;
              observer.disconnect();
              done();
            });
            observer.observe(document.body, {
              subtree: true,
              childList: true,
              attributes: true,
            });
          },
          { capture: true, once: true },
        );
      }),
    ready,
  );
}

const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] as number;

const LIST_FULL = `document.querySelector('.issue-list')?.getAttribute('data-issue-count') === '${PERF_COUNT}'`;

test('@perf filter change, list/board switch and peek open < 100 ms on 10,000 issues', async ({
  browser,
  baseURL,
}) => {
  const { context, page } = await openPerfPage(browser, baseURL);
  await coldStart(page);
  await page.waitForTimeout(5000);
  await page.waitForFunction(`${LIST_FULL}`);

  // Filter change: Priority = Urgent narrows 10,000 issues to a fifth; Clear brings them back.
  const filter: number[] = [];
  for (let run = 0; run < 3; run += 1) {
    await page.getByRole('button', { name: 'Filter', exact: true }).click();
    await page.locator('.popover').getByRole('button', { name: 'Priority', exact: true }).click();
    const option = page.getByRole('option', { name: /^Urgent/ });
    await option.waitFor();
    const took = timeNextClick(
      page,
      `document.querySelector('.issue-list')?.getAttribute('data-issue-count') === '${URGENT_ISSUES}'`,
    );
    await option.click();
    filter.push(await took);
    await page.keyboard.press('Escape');
    const cleared = timeNextClick(page, LIST_FULL);
    await page.getByRole('button', { name: 'Clear' }).click();
    await cleared;
  }
  report('filter-change', median(filter));
  expect(median(filter)).toBeLessThan(VIEW_ACTION_MS);

  // List <-> board.
  const switches: number[] = [];
  for (let run = 0; run < 3; run += 1) {
    for (const [layout, ready] of [
      [
        'Board',
        `document.querySelector('.board')?.getAttribute('data-issue-count') === '${PERF_COUNT}'`,
      ],
      ['List', LIST_FULL],
    ] as const) {
      await page.getByRole('button', { name: 'Display' }).click();
      const radio = page.getByRole('radio', { name: layout });
      await radio.waitFor();
      const took = timeNextClick(page, ready);
      await radio.click();
      switches.push(await took);
      await page.keyboard.press('Escape');
    }
  }
  report('list-board-switch', median(switches));
  expect(median(switches)).toBeLessThan(VIEW_ACTION_MS);

  // Peek: a click on a row opens the side panel.
  const peeks: number[] = [];
  for (const number of [7, 13, 19]) {
    const took = timeNextClick(page, `!!document.querySelector('[data-testid="issue-peek"]')`);
    await page.getByTestId(`issue-${number}`).click({ position: { x: 4, y: 4 } });
    peeks.push(await took);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('issue-peek')).toHaveCount(0);
  }
  report('peek-open', median(peeks));
  expect(median(peeks)).toBeLessThan(VIEW_ACTION_MS);
  await context.close();
});
