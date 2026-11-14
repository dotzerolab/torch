import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type PlaywrightTestConfig } from '@playwright/test';

// The stacks need DATABASE_URL, ELECTRIC_URL, ELECTRIC_SECRET, SMTP_URL and MAILPIT_API_URL. CI sets them; on a
// dev machine they come from the repo's .env (the same file the server reads), without overriding the shell.
const envFile = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

// High ports on purpose: 3000, 5173 and 5432 are often taken on a dev machine.
// Two stacks run side by side: the default brand, and one whose server reads a custom brand file.
const stacks = {
  default: { server: 43100, web: 43200 },
  customBrand: { server: 43101, web: 43201 },
};
const acmeBrandPath = fileURLToPath(new URL('./e2e/fixtures/brand.acme.json', import.meta.url));

type WebServers = Extract<NonNullable<PlaywrightTestConfig['webServer']>, unknown[]>;

function stackServers(
  stack: { server: number; web: number },
  env: Record<string, string> = {},
): WebServers {
  return [
    {
      command: 'node src/main.ts',
      cwd: '../server',
      // APP_URL is where the browser reaches this stack: the sign-in links and the CSRF origin check use it.
      env: { PORT: String(stack.server), APP_URL: `http://localhost:${stack.web}`, ...env },
      url: `http://localhost:${stack.server}/health`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: `pnpm exec vite --port ${stack.web} --strictPort`,
      env: { API_TARGET: `http://localhost:${stack.server}` },
      url: `http://localhost:${stack.web}`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ];
}

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  // One worker: the specs share the seeded demo members and one mailbox per address.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: { trace: 'retain-on-failure' },
  projects: [
    {
      name: 'chromium',
      testIgnore: /-custom\.spec\.ts$/,
      use: { browserName: 'chromium', baseURL: `http://localhost:${stacks.default.web}` },
    },
    {
      name: 'custom-brand',
      testMatch: /-custom\.spec\.ts$/,
      use: { browserName: 'chromium', baseURL: `http://localhost:${stacks.customBrand.web}` },
    },
  ],
  webServer: [
    ...stackServers(stacks.default),
    ...stackServers(stacks.customBrand, { BRAND_CONFIG_PATH: acmeBrandPath }),
  ],
});
