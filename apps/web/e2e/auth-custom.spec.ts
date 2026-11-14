import { expect, test } from '@playwright/test';
import { clearMailbox, waitForMessage } from './helpers/mailpit.ts';
import { demoEmail } from './helpers/sign-in.ts';

// Runs in the "custom-brand" project: its server reads BRAND_CONFIG_PATH=e2e/fixtures/brand.acme.json.
test('the sign-in email subject carries the Acme brand', async ({ page }) => {
  const email = demoEmail('admin');
  await clearMailbox(email);
  await page.goto('/login');
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('login-sent')).toBeVisible();

  const message = await waitForMessage(email);

  expect(message.subject).toBe('Sign in to Acme Tasks');
  expect(message.text).not.toContain('Torch');
});
