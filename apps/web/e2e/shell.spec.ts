import {
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  expect,
  type Page,
  test,
} from '@playwright/test';
import { issueTitle, issueTitleInput } from './helpers/issues.ts';
import { signInAs } from './helpers/sign-in.ts';

declare global {
  interface Window {
    __themes: string[];
  }
}

// A sign-in link is limited to five per address per 15 minutes and the other specs already use the demo addresses,
// so the specs here sign in once (as a member) and every test starts from that session's cookie.
// The first shape of a page is created by the sync service on demand, which can take a few seconds on a busy machine.
const FIRST_SYNC_MS = 20_000;

let session: Awaited<ReturnType<BrowserContext['storageState']>> | undefined;

async function signedInPage(
  browser: Browser,
  baseURL: string | undefined,
  options: BrowserContextOptions = {},
): Promise<Page> {
  const context = await browser.newContext({ baseURL, ...options, storageState: session });
  const page = await context.newPage();
  if (!session) {
    await signInAs(page, 'member');
    session = await context.storageState();
  } else {
    await page.goto('/');
    await expect(page.getByTestId('workspace-name')).toBeVisible();
  }
  return page;
}

test('theme: follows the system, keeps a stored choice across a reload with no wrong frame, and the choice beats the system', async ({
  browser,
  baseURL,
}) => {
  const page = await signedInPage(browser, baseURL, { colorScheme: 'dark' });
  // Records every value data-theme takes while a document loads, from before its first script runs.
  await page.addInitScript(() => {
    window.__themes = [];
    const record = () => {
      const theme = document.documentElement.getAttribute('data-theme');
      if (theme && window.__themes.at(-1) !== theme) window.__themes.push(theme);
    };
    new MutationObserver(record).observe(document, {
      subtree: true,
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    document.addEventListener('DOMContentLoaded', record);
  });

  // No choice stored: the emulated dark system setting decides, before anything is clicked.
  await page.reload();
  await expect(page.getByTestId('workspace-name')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await page.evaluate(() => window.__themes)).toEqual(['dark']);

  await page.getByRole('button', { name: 'Theme' }).click();
  await page.getByRole('menuitem', { name: 'Light' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  await page.reload();
  await expect(page.getByTestId('workspace-name')).toBeVisible();
  // The choice wins although the browser still says dark, and no frame of this load was dark.
  expect(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(true);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await page.evaluate(() => window.__themes)).toEqual(['light']);

  // Back to the system setting.
  await page.getByRole('button', { name: 'Theme' }).click();
  await page.getByRole('menuitem', { name: 'System' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.context().close();
});

test('phone width: no horizontal scroll, and the sidebar opens from the header and closes with Escape', async ({
  browser,
  baseURL,
}) => {
  const viewport = { width: 320, height: 640 };
  const overflows = (page: Page) =>
    page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);

  // The sign-in page first, without a session.
  const visitor = await browser.newContext({ baseURL, viewport });
  const login = await visitor.newPage();
  await login.goto('/login');
  await expect(login.getByTestId('login-email')).toBeVisible();
  expect(await overflows(login)).toBe(false);
  await visitor.close();

  const page = await signedInPage(browser, baseURL, { viewport });
  await expect(page.getByTestId('issue-title-1')).toBeVisible({ timeout: FIRST_SYNC_MS });
  expect(await overflows(page)).toBe(false);

  const toggle = page.getByRole('button', { name: 'Open sidebar' });
  await expect(page.getByRole('navigation', { name: 'Sidebar' })).toHaveCount(0);
  await toggle.click();
  const drawer = page.getByRole('dialog', { name: 'Sidebar' });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByTestId('team-ENG')).toBeVisible();
  expect(await overflows(page)).toBe(false);

  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await expect(toggle).toBeFocused();
  await page.context().close();
});

test('keyboard: ? opens the shortcut list and Escape closes it; a ? typed in a title field is just text; mod+/ toggles the sidebar', async ({
  browser,
  baseURL,
}) => {
  const page = await signedInPage(browser, baseURL);
  await expect(page.getByTestId('issue-title-1')).toBeVisible({ timeout: FIRST_SYNC_MS });

  await page.keyboard.press('?');
  const help = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(help).toBeVisible();
  await expect(help).toContainText('Toggle sidebar');
  await page.keyboard.press('Escape');
  await expect(help).toHaveCount(0);
  // Focus is back on the page, not lost inside a removed dialog.
  await expect.poll(() => page.evaluate(() => document.activeElement === document.body)).toBe(true);

  await issueTitle(page, 1).dblclick();
  const field = issueTitleInput(page, 1);
  // Renaming selects the whole title and focuses the field: the right arrow puts the caret after it.
  await expect(field).toBeFocused();
  await field.press('ArrowRight');
  await page.keyboard.type('?');
  await expect(field).toHaveValue('ENG issue 1?');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // Leave the title as it was: Escape puts the synced title back.
  await page.keyboard.press('Escape');
  await expect(issueTitle(page, 1)).toHaveText('ENG issue 1');
  await page.locator('body').click({ position: { x: 1, y: 1 } });

  const sidebar = page.getByRole('navigation', { name: 'Sidebar' });
  await expect(sidebar).toBeVisible();
  await page.keyboard.press('Control+/');
  await expect(sidebar).toHaveCount(0);
  await page.keyboard.press('Control+/');
  await expect(sidebar).toBeVisible();
  await page.context().close();
});
