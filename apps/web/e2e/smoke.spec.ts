import { expect, test } from '@playwright/test';

test('app title is visible', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('app-title')).toBeVisible();
});
