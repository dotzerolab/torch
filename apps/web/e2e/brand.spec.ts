import { expect, test } from '@playwright/test';

test('default brand shows in the title and heading', async ({ page }) => {
  await page.goto('/');

  await expect(page).toHaveTitle('Torch');
  await expect(page.getByTestId('app-title')).toHaveText('Welcome to Torch');
  await expect(page.locator('link[rel="icon"]').first()).toHaveAttribute(
    'href',
    '/brand/favicon.svg',
  );
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute(
    'href',
    '/brand/apple-touch-icon.png',
  );
});
