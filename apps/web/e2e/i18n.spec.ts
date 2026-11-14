import { expect, test } from '@playwright/test';

test.describe('Italian browser', () => {
  test.use({ locale: 'it-IT' });

  test('heading is in Italian and the page language follows', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByTestId('app-title')).toHaveText('Benvenuto in Torch');
    await expect(page.locator('html')).toHaveAttribute('lang', 'it');
  });
});

test.describe('English browser', () => {
  test.use({ locale: 'en-GB' });

  test('heading is in English', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByTestId('app-title')).toHaveText('Welcome to Torch');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  });
});
