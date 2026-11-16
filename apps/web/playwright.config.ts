import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type PlaywrightTestConfig } from '@playwright/test';

// The stacks need DATABASE_URL, ELECTRIC_URL, ELECTRIC_SECRET, SMTP_URL and MAILPIT_API_URL. CI sets them; on a
// dev machine they come from the repo's .env (the same file the server reads), without overriding the shell.
const envFile = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

// High ports on purpose: 3000, 5173 and 5432 are often taken on a dev machine. They stay BELOW the ephemeral range
// (32768-60999 on Linux, 49152-65535 on macOS and Windows): the OS hands that range to outgoing connections, so on a
// busy CI runner one of them can already hold the port when a server tries to bind it (EADDRINUSE).
// Two stacks run side by side: the default brand, and one whose server reads a custom brand file.
const stacks = {
  default: { server: 23100, web: 23200 },
  customBrand: { server: 23101, web: 23201 },
};
const acmeBrandPath = fileURLToPath(new URL('./e2e/fixtures/brand.acme.json', import.meta.url));

// `pnpm e2e:perf` runs only the 10,000-issue performance spec (it seeds a big workspace and takes minutes); `pnpm e2e`
// never includes it.
const perfRun = process.env.E2E_PERF === '1';

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
  projects: perfRun
    ? [
        {
          name: 'perf',
          testMatch: /perf\.spec\.ts$/,
          use: { browserName: 'chromium', baseURL: `http://localhost:${stacks.default.web}` },
        },
      ]
    : [
        {
          name: 'chromium',
          testIgnore: /(-custom|perf)\.spec\.ts$/,
          use: { browserName: 'chromium', baseURL: `http://localhost:${stacks.default.web}` },
        },
        {
          name: 'custom-brand',
          testMatch: /-custom\.spec\.ts$/,
          use: { browserName: 'chromium', baseURL: `http://localhost:${stacks.customBrand.web}` },
        },
      ],
  webServer: perfRun
    ? stackServers(stacks.default)
    : [
        ...stackServers(stacks.default),
        ...stackServers(stacks.customBrand, { BRAND_CONFIG_PATH: acmeBrandPath }),
      ],
});
