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
    // Browser APIs and matchers for the component tests (a no-op in node-only files).
    setupFiles: ['apps/web/src/test/setup.ts'],
    // Migrates the dev database once per run when DATABASE_URL is set.
    globalSetup: ['scripts/test-global-setup.ts'],
    // Show console output of passing files too, so a skipped integration test announces itself.
    disableConsoleIntercept: true,
  },
});
