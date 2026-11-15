// The demo workspace as `seedDev` creates it, restored after the specs that change it (invite a person, create a
// team, move memberships, deactivate) and before every run, so no spec sees what an earlier one left behind.
import { createDb } from '../../../server/src/db.ts';

const SEEDED = ['owner', 'admin', 'member', 'guest', 'outsider'].map(
  (role) => `${role}@example.test`,
);

/** The demo workspace as `seedDev` creates it: five members, ENG (public) and OPS (private), their memberships. */
export async function restoreDemoLayout(pool: ReturnType<typeof createDb>['pool']): Promise<void> {
  const demo = `(select id from workspace where slug = 'demo')`;
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`delete from audit_log where workspace_id = ${demo}`);
    await client.query(`delete from invite where workspace_id = ${demo}`);
    await client.query(`delete from team_member where workspace_id = ${demo}`);
    await client.query(
      `delete from workflow_state where workspace_id = ${demo}
          and team_id in (select id from team where workspace_id = ${demo} and key not in ('ENG', 'OPS'))`,
    );
    await client.query(
      `delete from team where workspace_id = ${demo} and key not in ('ENG', 'OPS')`,
    );
    await client.query(
      `delete from member where workspace_id = ${demo} and email <> all ($1::text[])`,
      [SEEDED],
    );
    await client.query(
      `update member set deactivated_at = null, locale = 'en',
              handle = split_part(email, '@', 1),
              name = initcap(split_part(email, '@', 1)) || ' Example',
              role = case when email = 'outsider@example.test' then 'member' else split_part(email, '@', 1) end::member_role
        where workspace_id = ${demo}`,
    );
    await client.query(`update team set private = (key = 'OPS') where workspace_id = ${demo}`);
    await client.query(
      `insert into team_member (workspace_id, team_id, member_id)
       select t.workspace_id, t.id, m.id
         from team t join member m on m.workspace_id = t.workspace_id
        where t.workspace_id = ${demo}
          and ((t.key = 'ENG' and m.email in ('owner@example.test', 'admin@example.test', 'member@example.test', 'guest@example.test'))
            or (t.key = 'OPS' and m.email in ('owner@example.test', 'member@example.test')))`,
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

/** Opens its own connection: for a spec's `afterAll`. */
export async function restoreDemoLayoutNow(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set (see .env.example)');
  const db = createDb(databaseUrl);
  try {
    await restoreDemoLayout(db.pool);
  } finally {
    await db.close();
  }
}
