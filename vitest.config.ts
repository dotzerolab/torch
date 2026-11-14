import { defineConfig } from 'vitest/config';

// One Vitest run for the whole repo. Playwright specs (*.spec.ts) are excluded on purpose.
export default defineConfig({
  test: {
    include: [
      'apps/*/src/**/*.test.{ts,tsx}',
      'packages/*/src/**/*.test.ts',
      'scripts/**/*.test.ts',
    ],
    environment: 'node',
    // Migrates the dev database once per run when DATABASE_URL is set.
    globalSetup: ['scripts/test-global-setup.ts'],
    // Show console output of passing files too, so a skipped integration test announces itself.
    disableConsoleIntercept: true,
  },
});
