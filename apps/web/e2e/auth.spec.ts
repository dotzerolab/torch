import { expect, test } from '@playwright/test';
import { demoEmail, requestSignInLink, signInAs } from './helpers/sign-in.ts';

test('owner signs in through the emailed link', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);

  const link = await requestSignInLink(page, demoEmail('owner'));
  // The token is in the fragment, so no server (ours, a proxy, a static host) ever sees it in a URL.
  expect(new URL(link).search).toBe('');
  const token = new URL(link).hash.replace('#token=', '');
  expect(token).toMatch(/^[\w-]{43}$/);
  const requested: string[] = [];
  page.on('request', (request) => requested.push(request.url()));

  // A mail scanner opens the link before the person does: opening it (even twice) must not use it up.
  await page.goto(link);
  await expect(page.getByTestId('verify-continue')).toBeVisible();
  await page.goto('/login');
  await page.goto(link);
  await expect(page.getByTestId('verify-continue')).toBeVisible();
  expect((await page.request.get('/api/auth/session')).status()).toBe(401);

  // The address bar lost the token before the button is pressed, and the page says who is signing in.
  await expect(page).toHaveURL(/\/auth\/verify$/);
  expect(new URL(page.url()).hash).toBe('');
  await expect(page.getByTestId('verify-email')).toContainText('owner@example.test');

  await page.getByTestId('verify-continue').click();

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('workspace-name')).toHaveText('Demo');
  await expect(page.getByTestId('team-ENG')).toBeVisible();
  await expect(page.getByTestId('team-OPS')).toBeVisible();
  // No request of the whole flow carried the token in its URL.
  expect(requested.filter((url) => url.includes(token))).toEqual([]);
});

test('a link opened in a browser that is already signed in replaces the old cookie', async ({
  page,
  request,
}) => {
  await signInAs(page, 'owner');
  const first = (await page.context().cookies()).find((cookie) => cookie.name === 'sid');
  expect(first?.value).toBeTruthy();

  const link = await requestSignInLink(page, demoEmail('owner'));
  await page.goto(link);
  await page.getByTestId('verify-continue').click();
  await expect(page.getByTestId('workspace-name')).toBeVisible();

  const second = (await page.context().cookies()).find((cookie) => cookie.name === 'sid');
  expect(second?.value).toBeTruthy();
  expect(second?.value).not.toBe(first?.value);
  // The first cookie is dead, not just replaced in this browser: replaying it anywhere gets a 401.
  const replay = await request.get('/api/auth/session', {
    headers: { cookie: `sid=${first?.value}` },
  });
  expect(replay.status()).toBe(401);
  expect((await page.request.get('/api/auth/session')).status()).toBe(200);
});

test('a link without a token in the fragment, or with one in the query, is refused', async ({
  page,
}) => {
  const link = await requestSignInLink(page, demoEmail('member'));
  const token = new URL(link).hash.replace('#token=', '');

  await page.goto('/auth/verify');
  await expect(page.getByTestId('verify-error')).toBeVisible();
  await page.goto(`/auth/verify?token=${token}`);
  await expect(page.getByTestId('verify-error')).toBeVisible();

  // Neither attempt used the link up.
  await page.goto(link);
  await expect(page.getByTestId('verify-continue')).toBeVisible();
});

test('a used sign-in link is refused the second time', async ({ page }) => {
  const link = await requestSignInLink(page, demoEmail('admin'));
  await page.goto(link);
  await page.getByTestId('verify-continue').click();
  await expect(page.getByTestId('workspace-name')).toBeVisible();

  // Opening a used link is refused on the spot (the preview knows), before there is a button to press.
  await page.goto('/login');
  await page.goto(link);

  await expect(page.getByTestId('verify-error')).toBeVisible();
  await expect(page.getByTestId('verify-continue')).toHaveCount(0);
  await expect(page.getByTestId('verify-email')).toHaveCount(0);
});

test('sign out returns to /login', async ({ page }) => {
  await signInAs(page, 'admin');

  await page.getByTestId('sign-out').click();

  await expect(page).toHaveURL(/\/login$/);
  expect((await page.request.get('/api/auth/session')).status()).toBe(401);
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
});

test.describe('Italian browser', () => {
  test.use({ locale: 'it-IT' });

  test('Italian locale shows Italian sign-in text', async ({ page }) => {
    await page.goto('/login');

    await expect(page.getByTestId('login-submit')).toHaveText('Inviami un link di accesso');
    await expect(page.getByLabel('Email')).toBeVisible();
    await page.getByTestId('login-email').fill('nobody@example.test');
    await page.getByTestId('login-submit').click();
    await expect(page.getByTestId('login-sent')).toContainText('Controlla la tua email');
  });
});
