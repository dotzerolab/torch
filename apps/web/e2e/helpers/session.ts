import type { BrowserContext } from '@playwright/test';
import { generateToken, hashToken } from '../../../server/src/auth/tokens.ts';
import { createDb } from '../../../server/src/db.ts';
import { type DemoRole, demoEmail } from './sign-in.ts';

/**
 * Signs a demo member in without the email round trip: a session row for the member and its cookie in the context.
 * The sign-in screens have their own specs (a person may ask for only a few links per address and quarter hour, and
 * the server limits the links per client), so the specs of the settings screens start from a session instead.
 */
export async function openSessionAs(
  context: BrowserContext,
  baseURL: string | undefined,
  role: DemoRole,
  workspaceSlug = 'demo',
): Promise<void> {
  if (!baseURL) throw new Error('openSessionAs needs the baseURL of the stack');
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set (see .env.example)');
  const token = generateToken();
  const db = createDb(databaseUrl);
  try {
    const found = await db.pool.query<{ id: string; workspace_id: string }>(
      `select m.id, m.workspace_id from member m join workspace w on w.id = m.workspace_id
        where w.slug = $2 and m.email = $1`,
      [demoEmail(role), workspaceSlug],
    );
    const row = found.rows[0];
    if (!row) throw new Error(`no ${workspaceSlug} member for ${role}`);
    await db.pool.query(
      `insert into session (workspace_id, member_id, token_hash, expires_at)
       values ($1, $2, $3, now() + interval '1 day')`,
      [row.workspace_id, row.id, hashToken(token)],
    );
  } finally {
    await db.close();
  }
  await context.addCookies([{ name: 'sid', value: token, url: baseURL, httpOnly: true }]);
}
