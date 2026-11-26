// Comments, files and documents, end to end: two people in two browser contexts, the real server, the real shapes and the
// real storage service. The components are mounted by the harness page (e2e/harness), since the routes that mount them
// belong to the issue screens.
import { type Browser, type BrowserContext, expect, type Page, test } from '@playwright/test';
import { createDb } from '../../server/src/db.ts';
import { openSessionAs } from './helpers/session.ts';
import type { DemoRole } from './helpers/sign-in.ts';

// A 1x1 PNG: real magic bytes, so the server's check of the stored object passes.
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

type Ids = {
  workspace: string;
  engTeam: string;
  opsTeam: string;
  engIssue: string;
  opsIssue: string;
};

async function demoIds(): Promise<Ids> {
  const db = createDb(process.env.DATABASE_URL as string);
  try {
    const found = await db.pool.query<{
      key: string;
      team: string;
      issue: string;
      workspace: string;
    }>(
      `select distinct on (t.key) t.key, t.id as team, i.id as issue, w.id as workspace
         from issue i join team t on t.id = i.team_id join workspace w on w.id = i.workspace_id
        where w.slug = 'demo' and t.key in ('ENG', 'OPS')
        order by t.key, i.number`,
    );
    const eng = found.rows.find((row) => row.key === 'ENG');
    const ops = found.rows.find((row) => row.key === 'OPS');
    if (!eng || !ops) throw new Error('the demo workspace has no ENG and OPS issues');
    return {
      workspace: eng.workspace,
      engTeam: eng.team,
      opsTeam: ops.team,
      engIssue: eng.issue,
      opsIssue: ops.issue,
    };
  } finally {
    await db.close();
  }
}

async function countComments(body: string): Promise<number> {
  const db = createDb(process.env.DATABASE_URL as string);
  try {
    const result = await db.pool.query<{ n: string }>(
      'select count(*) as n from comment where body = $1',
      [body],
    );
    return Number(result.rows[0]?.n ?? 0);
  } finally {
    await db.close();
  }
}

async function person(browser: Browser, baseURL: string | undefined, role: DemoRole) {
  const context = await browser.newContext({ baseURL });
  await openSessionAs(context, baseURL, role);
  return { context, page: await context.newPage() };
}

const harness = (params: Record<string, string>) =>
  `/e2e/harness/index.html?${new URLSearchParams(params)}`;
const issueView = (ids: Ids) => harness({ view: 'issue', team: ids.engTeam, issue: ids.engIssue });
const unique = () => crypto.randomUUID().slice(0, 8);

async function send(page: Page, label: string, text: string) {
  await page.getByRole('textbox', { name: label }).fill(text);
  await page.keyboard.press('Control+Enter');
}

test.describe
  .serial('comments and files', () => {
    let ids: Ids;
    let alice: { context: BrowserContext; page: Page };
    let bruno: { context: BrowserContext; page: Page };

    test.beforeAll(async ({ browser, baseURL }) => {
      ids = await demoIds();
      alice = await person(browser, baseURL, 'member');
      bruno = await person(browser, baseURL, 'admin');
      await alice.page.goto(issueView(ids));
      await bruno.page.goto(issueView(ids));
      await expect(alice.page.getByTestId('comment-thread')).toBeVisible();
      await expect(bruno.page.getByTestId('comment-thread')).toBeVisible();
    });
    test.afterAll(async () => {
      await alice?.context.close();
      await bruno?.context.close();
    });

    test('a comment reaches the other person, who replies and reacts; the first resolves; an edit keeps its history', async () => {
      const text = `First comment ${unique()}`;
      await send(alice.page, 'Write a comment', text);
      await expect(alice.page.getByText(text)).toBeVisible();
      // The server bumps the issue, the live issues shape says so, and the other page reads the comments again.
      await expect(bruno.page.getByText(text)).toBeVisible({ timeout: 8000 });

      // The author edits: the new text shows, the first one stays in the history.
      const edited = `${text} (edited)`;
      await alice.page.getByRole('button', { name: 'More actions' }).click();
      await alice.page.getByRole('menuitem', { name: 'Edit' }).click();
      await alice.page.getByRole('textbox', { name: 'Edit' }).fill(edited);
      await alice.page.getByRole('button', { name: 'Save' }).click();
      await expect(alice.page.getByText(edited)).toBeVisible();
      await expect(bruno.page.getByText(edited)).toBeVisible({ timeout: 8000 });
      await alice.page
        .getByRole('button', { name: /edited/ })
        .first()
        .click();
      const history = alice.page.getByTestId('edit-history');
      await expect(history.getByText(text, { exact: true })).toBeVisible();
      await expect(history.getByText('Current version')).toBeVisible();
      await alice.page.keyboard.press('Escape');

      // The other person replies and reacts.
      const reply = `Reply ${unique()}`;
      const thread = bruno.page.locator('[data-testid^="thread-"]').filter({ hasText: edited });
      await thread.getByRole('button', { name: 'Reply' }).click();
      await send(bruno.page, 'Reply to Member Example', reply);
      await expect(bruno.page.getByText(reply)).toBeVisible();
      await thread.getByRole('button', { name: 'Add reaction' }).first().click();
      await bruno.page.getByRole('button', { name: 'React with 🎉' }).click();
      await expect(alice.page.getByText(reply)).toBeVisible({ timeout: 8000 });
      await expect(alice.page.getByRole('button', { name: /React with 🎉 \(1\)/ })).toBeVisible({
        timeout: 8000,
      });

      // The first person resolves the thread; both see it collapsed with who resolved it.
      await alice.page
        .locator('[data-testid^="thread-"]')
        .filter({ hasText: edited })
        .getByRole('button', { name: 'Resolve thread' })
        .click();
      await expect(alice.page.getByText('Resolved by Member Example')).toBeVisible();
      await expect(bruno.page.getByText('Resolved by Member Example')).toBeVisible({
        timeout: 8000,
      });
    });

    test('a PNG goes to the storage and the other person sees it and downloads it; an html file is refused', async () => {
      await alice.page.getByTestId('file-input').setInputFiles({
        name: 'pixel.png',
        mimeType: 'image/png',
        buffer: PIXEL,
      });
      const row = (page: Page) =>
        page.locator('li[data-testid^="attachment-"]').filter({ hasText: 'pixel.png' });
      await expect(row(alice.page)).toBeVisible({ timeout: 15_000 });
      await expect(row(bruno.page)).toBeVisible({ timeout: 8000 });

      // The thumbnail and the download are the server's own address; it redirects to a short-lived signed one.
      const id = ((await row(bruno.page).getAttribute('data-testid')) ?? '').replace(
        'attachment-',
        '',
      );
      const download = await bruno.page.request.get(
        `/api/w/${ids.workspace}/attachments/${id}/file`,
      );
      expect(download.ok()).toBe(true);
      expect(download.headers()['content-type']).toContain('image/png');
      expect((await download.body()).equals(PIXEL)).toBe(true);
      const thumb = row(bruno.page).getByRole('img', { name: 'pixel.png' });
      await expect
        .poll(() => thumb.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
        .toBe(1);

      // An html file never reaches the server or the storage.
      const requests: string[] = [];
      alice.page.on('request', (request) => requests.push(request.url()));
      await alice.page.getByTestId('file-input').setInputFiles({
        name: 'page.html',
        mimeType: 'text/html',
        buffer: Buffer.from('<script>alert(1)</script>'),
      });
      await expect(alice.page.getByText('This type of file is not allowed.')).toBeVisible();
      expect(requests.filter((url) => url.includes('/attachments'))).toEqual([]);
    });

    test('a person outside the team never sees the comments of its issue', async ({
      browser,
      baseURL,
    }) => {
      const owner = await person(browser, baseURL, 'owner');
      const secret = `Private note ${unique()}`;
      const written = await owner.context.request.post(
        `/api/w/${ids.workspace}/issues/${ids.opsIssue}/comments`,
        {
          data: { body: secret },
          headers: { 'idempotency-key': crypto.randomUUID(), origin: baseURL ?? '' },
        },
      );
      expect(written.status()).toBe(201);

      const guest = await person(browser, baseURL, 'guest');
      try {
        const shape = await guest.context.request.get(
          `/api/sync/w/${ids.workspace}/issues/${ids.opsIssue}/comments?offset=-1`,
        );
        expect(shape.status()).toBe(404);
        const rest = await guest.context.request.get(
          `/api/w/${ids.workspace}/issues/${ids.opsIssue}/comments`,
        );
        expect(rest.status()).toBe(404);

        // A page that asks for that issue anyway shows nothing of it.
        await guest.page.goto(harness({ view: 'issue', team: ids.engTeam, issue: ids.opsIssue }));
        await expect(guest.page.getByTestId('comment-thread')).toBeVisible();
        await guest.page.waitForTimeout(1500);
        await expect(guest.page.getByText(secret)).toHaveCount(0);
        await expect(guest.page.locator('[data-testid^="thread-"]')).toHaveCount(0);
      } finally {
        await guest.context.close();
        await owner.context.close();
      }
    });

    test('a team document is created and edited by one person and read by the other', async () => {
      await alice.page.goto(harness({ view: 'documents', team: ids.engTeam }));
      await bruno.page.goto(harness({ view: 'documents', team: ids.engTeam }));
      await alice.page.getByRole('button', { name: 'New document' }).click();

      const title = `Runbook ${unique()}`;
      const body = `# Steps\n\nBody ${unique()}`;
      await alice.page.getByRole('textbox', { name: 'Title' }).fill(title);
      await alice.page.getByRole('textbox', { name: 'Document text' }).fill(body);
      await alice.page.keyboard.press('Control+s');
      await expect(alice.page.getByText('Saved')).toBeVisible();

      // The titles are a live shape: the other person's list shows it without a reload; opening it reads the body.
      await expect(bruno.page.getByText(title)).toBeVisible({ timeout: 8000 });
      await bruno.page.getByText(title).click();
      await expect(bruno.page.getByRole('textbox', { name: 'Document text' })).toHaveValue(body, {
        timeout: 8000,
      });

      // The history keeps the first text once the second is saved.
      const second = `${body}\n\nSecond paragraph`;
      await alice.page.getByRole('textbox', { name: 'Document text' }).fill(second);
      await alice.page.keyboard.press('Control+s');
      await expect(bruno.page.getByRole('textbox', { name: 'Document text' })).toHaveValue(second, {
        timeout: 8000,
      });
      await bruno.page.getByRole('button', { name: 'History' }).click();
      await expect(bruno.page.getByTestId('revision-list').getByText(/Body/).first()).toBeVisible();
    });

    test('a comment written offline appears after reconnecting, once', async () => {
      await alice.page.goto(issueView(ids));
      await expect(alice.page.getByTestId('comment-thread')).toBeVisible();
      const text = `Offline comment ${unique()}`;
      await alice.context.setOffline(true);
      await send(alice.page, 'Write a comment', text);
      // It shows at once, marked as being sent, and waits in the queue.
      const sending = alice.page.getByTestId(/^comment-pending/).filter({ hasText: text });
      await expect(sending.getByText('Sending…')).toBeVisible();

      await alice.context.setOffline(false);
      await expect(alice.page.getByText('Sending…')).toHaveCount(0, { timeout: 20_000 });
      await expect(alice.page.getByText(text)).toHaveCount(1);
      await expect.poll(() => countComments(text), { timeout: 10_000 }).toBe(1);
    });
  });
