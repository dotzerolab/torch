import { expect, test } from '@playwright/test';
import { demoEmail, requestSignInLink, signInAs } from './helpers/sign-in.ts';

test('owner signs in through the emailed link', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);

  const link = await requestSignInLink(page, demoEmail('owner'));

  // A mail scanner opens the link before the person does: opening it (even twice) must not use it up.
  await page.goto(link);
  await expect(page.getByTestId('verify-continue')).toBeVisible();
  await page.goto(link);
  await expect(page.getByTestId('verify-continue')).toBeVisible();
  expect((await page.request.get('/api/auth/session')).status()).toBe(401);

  await page.getByTestId('verify-continue').click();

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('workspace-name')).toHaveText('Demo');
  await expect(page.getByTestId('team-ENG')).toBeVisible();
  await expect(page.getByTestId('team-OPS')).toBeVisible();
});

test('a used sign-in link is refused the second time', async ({ page }) => {
  const link = await requestSignInLink(page, demoEmail('admin'));
  await page.goto(link);
  await page.getByTestId('verify-continue').click();
  await expect(page.getByTestId('workspace-name')).toBeVisible();

  await page.goto(link);
  await page.getByTestId('verify-continue').click();

  await expect(page.getByTestId('verify-error')).toBeVisible();
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
