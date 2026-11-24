import type { BrowserContext } from '@playwright/test';
import { hashToken } from '../../../server/src/auth/tokens.ts';
import { insertWorkspaceLayout } from '../../../server/src/db/seed.ts';
import { createDb } from '../../../server/src/db.ts';

/**
 * Gives the person of a context (signed in by `openSessionAs`) a second workspace: its own members, teams and issues,
 * and a session in it under the same cookie, so the workspace switcher lists it. `remove` deletes it again, so no
 * other spec (the sign-in specs list the workspaces of an address) ever sees it.
 */
export async function addSecondWorkspace(
  context: BrowserContext,
): Promise<{ id: string; name: string; remove: () => Promise<void> }> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set (see .env.example)');
  const token = (await context.cookies()).find((cookie) => cookie.name === 'sid')?.value;
  if (!token) throw new Error('the context has no session cookie');
  const suffix = crypto.randomUUID().slice(0, 8);
  const name = `Second ${suffix}`;
  const db = createDb(databaseUrl);
  try {
    const layout = await db.orm.transaction((tx) =>
      insertWorkspaceLayout(tx, {
        name,
        slug: `e2e-second-${suffix}`,
        email: {
          owner: `owner-${suffix}@example.test`,
          admin: `admin-${suffix}@example.test`,
          member: `member-${suffix}@example.test`,
          guest: `guest-${suffix}@example.test`,
          outsider: `outsider-${suffix}@example.test`,
        },
        issuesPerTeam: 3,
      }),
    );
    await db.pool.query(
      `insert into session (workspace_id, member_id, token_hash, expires_at)
       values ($1, $2, $3, now() + interval '1 day')`,
      [layout.workspaceId, layout.members.owner.id, hashToken(token)],
    );
    return {
      id: layout.workspaceId,
      name,
      remove: async () => {
        const cleanup = createDb(databaseUrl);
        try {
          // Every table that names the workspace, children first: a pass deletes what no other row still points at.
          const tables = await cleanup.pool.query<{ table_name: string }>(
            `select table_name from information_schema.columns
              where table_schema = 'public' and column_name = 'workspace_id'`,
          );
          let left = tables.rows.map((row) => row.table_name);
          for (let pass = 0; pass < 6 && left.length > 0; pass += 1) {
            const stuck: string[] = [];
            for (const table of left) {
              await cleanup.pool
                .query(`delete from "${table}" where workspace_id = $1`, [layout.workspaceId])
                .catch(() => stuck.push(table));
            }
            left = stuck;
          }
          await cleanup.pool.query('delete from workspace where id = $1', [layout.workspaceId]);
        } finally {
          await cleanup.close();
        }
      },
    };
  } finally {
    await db.close();
  }
}
