import { expect, test } from '@playwright/test';

// Runs in the "custom-brand" project: its server reads BRAND_CONFIG_PATH=e2e/fixtures/brand.acme.json.
test('a custom brand file replaces the product name everywhere', async ({ page }) => {
  await page.goto('/');

  await expect(page).toHaveTitle('Acme Tasks');
  await expect(page.getByTestId('app-title')).toHaveText('Welcome to Acme Tasks');
  await expect(page.locator('body')).not.toContainText('Torch');
  // The favicon is the brand's own, and nothing of the default brand's icons stays in the page.
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', '/acme/favicon.svg');
  await expect(page.locator('link[rel="icon"]')).toHaveCount(1);
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveCount(0);
});

test('the web manifest and the page link to it carry the custom brand', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    'href',
    '/api/manifest.webmanifest',
  );

  const response = await page.request.get('/api/manifest.webmanifest');
  expect(response.ok()).toBe(true);
  expect(response.headers()['content-type']).toContain('application/manifest+json');
  const manifest = await response.json();
  expect(manifest.name).toBe('Acme Tasks');
  expect(manifest.theme_color).toBe('#3366ff');
  expect(manifest.icons).toEqual([
    { src: '/acme/favicon.svg', sizes: 'any', type: 'image/svg+xml' },
  ]);
  expect(JSON.stringify(manifest)).not.toContain('Torch');
});
