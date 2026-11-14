import { expect, type Page } from '@playwright/test';
import { clearMailbox, latestSignInLink } from './mailpit.ts';

/** The seeded members of the demo workspace (apps/server/src/db/seed.ts). */
export type DemoRole = 'owner' | 'admin' | 'member' | 'guest' | 'outsider';
export const demoEmail = (role: DemoRole) => `${role}@example.test`;

/** Types the email on /login, submits, and returns the link the server mailed. */
export async function requestSignInLink(page: Page, email: string): Promise<string> {
  await clearMailbox(email);
  await page.goto('/login');
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('login-sent')).toBeVisible();
  return latestSignInLink(email);
}

/** The whole path a person takes: request the link, open it, press Continue, land on the workspace. */
export async function signInAs(page: Page, role: DemoRole): Promise<void> {
  const link = await requestSignInLink(page, demoEmail(role));
  await page.goto(link);
  await page.getByTestId('verify-continue').click();
  await expect(page.getByTestId('workspace-name')).toBeVisible();
}
