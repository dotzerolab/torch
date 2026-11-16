// Before the stacks start: bring the dev database to the latest schema, make sure the demo workspace exists,
// and put it back to its seeded state so every run (and every re-run) starts from the same data.

import { runMigrations } from '../../server/src/db/migrate.ts';
import { seedDev } from '../../server/src/db/seed.ts';
import { createDb } from '../../server/src/db.ts';
import { restoreDemoLayout } from './helpers/demo-layout.ts';

const REQUIRED = ['DATABASE_URL', 'ELECTRIC_URL', 'ELECTRIC_SECRET', 'SMTP_URL', 'MAILPIT_API_URL'];

export default async function globalSetup(): Promise<void> {
  const missing = REQUIRED.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(
      `e2e needs the full stack: set ${missing.join(', ')} (see .env.example) and start ` +
        '`docker compose -f docker-compose.dev.yml up -d --wait postgres electric mail`.',
    );
  }
  const databaseUrl = process.env.DATABASE_URL as string;

  await runMigrations(databaseUrl);
  const db = createDb(databaseUrl);
  try {
    await seedDev(db.orm);
    // Titles edited by an earlier run, and the sign-in links and sessions it left (they count against the
    // 5-links-per-15-minutes limit of each demo address). The performance workspace (`pnpm e2e:perf`) has the same
    // addresses: a link covers every workspace of an address, so its tokens count too.
    await db.pool.query(
      `update issue set title = t.key || ' issue ' || issue.number
         from team t, workspace w
        where issue.team_id = t.id and issue.workspace_id = w.id and w.slug = 'demo'`,
    );
    await db.pool.query(
      `delete from login_token where workspace_id in (select id from workspace where slug in ('demo', 'perf'))`,
    );
    await db.pool.query(
      `delete from session where workspace_id in (select id from workspace where slug in ('demo', 'perf'))`,
    );

    // What the members, teams and invites specs change: the people invited, the teams created, the roles, names,
    // team memberships and deactivations all go back to the seeded layout.
    await restoreDemoLayout(db.pool);

    // The specs read ids that no signed-in guest may see; workers inherit these variables.
    const ids = await db.pool.query<{ workspace_id: string; ops_team_id: string }>(
      `select w.id as workspace_id, t.id as ops_team_id
         from workspace w join team t on t.workspace_id = w.id
        where w.slug = 'demo' and t.key = 'OPS'`,
    );
    const row = ids.rows[0];
    if (!row) throw new Error('the demo workspace has no OPS team');
    process.env.E2E_DEMO_WORKSPACE_ID = row.workspace_id;
    process.env.E2E_DEMO_OPS_TEAM_ID = row.ops_team_id;
  } finally {
    await db.close();
  }
}
