// The data steps of the migrations that carry them, run on a database that is already migrated: the statements are read
// from the migration files and applied to rows made to look like a database from before the step (a team with two
// states whose names differ only by case; issues already in a started, completed or canceled state).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createWorkspaceFixture } from '../test/fixtures.ts';
import { freshTeam, makeIssue } from '../test/issue-helpers.ts';
import { useSharedDatabase } from '../test/shared-database.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.warn('[db/migration-backfill.test] SKIPPED: DATABASE_URL is not set (see .env.example).');
}

const statementsOf = (file: string): string[] =>
  readFileSync(fileURLToPath(new URL(`../../migrations/${file}`, import.meta.url)), 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter(Boolean);

describe.skipIf(!databaseUrl)('migration data steps', () => {
  const getDb = useSharedDatabase();

  it('0004 renames states that differ only by case before the unique index is created', async () => {
    const db = getDb();
    const f = await createWorkspaceFixture(db.orm);
    const t = await freshTeam(db, f, 'MIG');
    const statements = statementsOf('0004_workflow_state_archive.sql');
    const create = statements.find((statement) => statement.startsWith('CREATE UNIQUE INDEX'));
    const rename = statements.find((statement) => statement.startsWith('UPDATE "workflow_state"'));
    expect(create).toBeDefined();
    expect(rename).toBeDefined();
    if (!create || !rename) return;
    // A database from before the step: the case-sensitive rule only.
    await db.pool.query('drop index workflow_state_team_name_unique');
    try {
      for (const name of ['Review', 'REVIEW', 'review']) {
        await db.pool.query(
          `insert into workflow_state (workspace_id, team_id, name, type, position)
           values ($1, $2, $3, 'started', 9)`,
          [f.workspaceId, t.team.id, name],
        );
      }
      await db.pool.query(rename);
      const { rows } = await db.pool.query<{ name: string }>(
        `select name from workflow_state where team_id = $1 and lower(name) like 'review%' order by created_at, id`,
        [t.team.id],
      );
      expect(rows).toHaveLength(3);
      expect(rows[0]?.name).toBe('Review');
      expect(new Set(rows.map((row) => row.name.toLowerCase())).size).toBe(3);
      // The index can now be created.
      await db.pool.query(create);
    } finally {
      await db.pool.query(
        `delete from workflow_state where team_id = $1 and lower(name) like 'review%'`,
        [t.team.id],
      );
      await db.pool.query('drop index if exists workflow_state_team_name_unique');
      await db.pool.query(
        statementsOf('0004_workflow_state_archive.sql').find((s) => s.startsWith('CREATE UNIQUE')),
      );
    }
  });

  it('0002 sets started_at, completed_at and canceled_at from updated_at for issues already in those states', async () => {
    const db = getDb();
    const f = await createWorkspaceFixture(db.orm);
    const t = await freshTeam(db, f, 'MIB');
    const inState = {
      started: await makeIssue(db, f, t.team.id, 'S', { stateId: t.stateId('started') }),
      completed: await makeIssue(db, f, t.team.id, 'C', { stateId: t.stateId('completed') }),
      canceled: await makeIssue(db, f, t.team.id, 'X', { stateId: t.stateId('canceled') }),
      unstarted: await makeIssue(db, f, t.team.id, 'U', { stateId: t.stateId('unstarted') }),
    };
    // From before the step: no timestamps at all, an old updated_at.
    await db.pool.query(
      `update issue set started_at = null, completed_at = null, canceled_at = null,
              updated_at = '2026-01-02T03:04:05Z' where team_id = $1`,
      [t.team.id],
    );
    const backfill = statementsOf('0002_issue_fields_labels_relations.sql').filter((statement) =>
      statement.startsWith('UPDATE "issue"'),
    );
    expect(backfill.length).toBeGreaterThan(0);
    for (const statement of backfill) await db.pool.query(statement);

    const { rows } = await db.pool.query<{
      id: string;
      started_at: Date | null;
      completed_at: Date | null;
      canceled_at: Date | null;
    }>('select id, started_at, completed_at, canceled_at from issue where team_id = $1', [
      t.team.id,
    ]);
    const of = (id: string) => rows.find((row) => row.id === id);
    const stamp = new Date('2026-01-02T03:04:05Z').getTime();
    expect(of(inState.started.id)?.started_at?.getTime()).toBe(stamp);
    expect(of(inState.completed.id)?.completed_at?.getTime()).toBe(stamp);
    expect(of(inState.canceled.id)?.canceled_at?.getTime()).toBe(stamp);
    expect(of(inState.started.id)?.completed_at).toBeNull();
    expect(of(inState.unstarted.id)).toMatchObject({
      started_at: null,
      completed_at: null,
      canceled_at: null,
    });
  });
});
