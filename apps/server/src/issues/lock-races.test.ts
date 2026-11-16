// Concurrency tests for the row locks of the issue writers. Every foreign-key check takes `for key share` on the row it
// points at, and `for update` conflicts with it, so a writer that locks rows with `for update` and then inserts a row
// that points at a row another writer holds can deadlock with that writer (Postgres aborts one with 40P01, which the
// API would answer as a 500). The window is a few milliseconds wide, so each test widens it on purpose: a trigger
// sleeps at the exact statement where the first call is between its lock and its foreign-key check, the test waits
// until that call is asleep, starts the second call, and lets both finish. With the wrong lock modes or lock order the
// cycle forms every time; with the right ones the second call waits for the first.
import { describe, expect, it } from 'vitest';
import type { Db } from '../db.ts';
import { createWorkspaceFixture, pgErrorCode } from '../test/fixtures.ts';
import { actorOf, freshTeam, makeIssue } from '../test/issue-helpers.ts';
import { useSharedDatabase } from '../test/shared-database.ts';
import { archiveWorkflowState } from '../workflow/service.ts';
import { createIssue } from './create-issue.ts';
import { addRelation } from './relations.ts';
import { updateIssue } from './update-issue.ts';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.warn(
    '[issues/lock-races.test] SKIPPED: DATABASE_URL is not set. ' +
      'Start `docker compose -f docker-compose.dev.yml up -d --wait postgres` and set DATABASE_URL (see .env.example).',
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A before-trigger that sleeps half a second on `table`, only where `when` holds (a row condition), for one test. */
async function slowTrigger(
  db: Db,
  event: 'insert' | 'update',
  table: 'issue_relation' | 'issue' | 'team',
  level: 'statement' | 'row',
  when?: string,
): Promise<() => Promise<void>> {
  await db.pool.query(
    `create or replace function slow_race() returns trigger language plpgsql as
     $$ begin perform pg_sleep(0.5); return new; end $$`,
  );
  await db.pool.query(
    `create trigger slow_race before ${event} on ${table} for each ${level}
     ${when ? `when (${when})` : ''} execute function slow_race()`,
  );
  return async () => {
    await db.pool.query(`drop trigger slow_race on ${table}`);
  };
}

/** Resolves once some backend of this database is inside `pg_sleep` (the slowed statement), i.e. the first call is mid-way. */
async function waitUntilAsleep(db: Db): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { rowCount } = await db.pool.query(
      `select 1 from pg_stat_activity where datname = current_database() and wait_event = 'PgSleep'`,
    );
    if (rowCount) return;
    await sleep(10);
  }
  throw new Error('the first call never reached the slowed statement');
}

/** "ok", the refusal code, or `threw <pg code>` for a call that rejected (a deadlock victim). */
function outcome(settled: PromiseSettledResult<unknown>): string {
  if (settled.status === 'rejected') {
    return `threw ${pgErrorCode(settled.reason) ?? String(settled.reason)}`;
  }
  const value = settled.value as { ok: boolean; code?: string; error?: { code: string } };
  return value.ok ? 'ok' : (value.code ?? value.error?.code ?? 'refused');
}

/** Starts `first`, waits until it sleeps, then starts `second`; both run to the end. */
async function race(
  db: Db,
  first: () => Promise<unknown>,
  second: () => Promise<unknown>,
): Promise<string[]> {
  const running = first();
  running.catch(() => undefined);
  await waitUntilAsleep(db);
  const other = second();
  return (await Promise.allSettled([running, other])).map(outcome);
}

describe.skipIf(!databaseUrl)('issue writers never deadlock each other', () => {
  const getDb = useSharedDatabase();

  async function world(key: string) {
    const db = getDb();
    const f = await createWorkspaceFixture(db.orm);
    const t = await freshTeam(db, f, key);
    return {
      db,
      f,
      t,
      owner: await actorOf(db, f, 'owner'),
      member: await actorOf(db, f, 'member'),
    };
  }

  it('(a) a relation A to B against a relation B to A', async () => {
    const w = await world('LRA');
    const a = await makeIssue(w.db, w.f, w.t.team.id, 'A');
    const b = await makeIssue(w.db, w.f, w.t.team.id, 'B');
    const drop = await slowTrigger(w.db, 'insert', 'issue_relation', 'statement');
    try {
      const outcomes = await race(
        w.db,
        () => addRelation(w.db.orm, w.member, a.id, { relatedIssueId: b.id, type: 'blocks' }),
        () => addRelation(w.db.orm, w.member, b.id, { relatedIssueId: a.id, type: 'blocks' }),
      );
      expect(outcomes).toEqual(['ok', 'ok']);
    } finally {
      await drop();
    }
  });

  it('(b) an edit of an issue against the archive of the state it sits in', async () => {
    const w = await world('LRB');
    const started = w.t.stateId('started');
    const x = await makeIssue(w.db, w.f, w.t.team.id, 'X', { stateId: started });
    const drop = await slowTrigger(
      w.db,
      'update',
      'issue',
      'row',
      'new.title is distinct from old.title',
    );
    try {
      const outcomes = await race(
        w.db,
        () => updateIssue(w.db.orm, w.member, x.id, { title: 'X renamed' }),
        () =>
          archiveWorkflowState(w.db.orm, w.owner, w.t.team.id, started, {
            moveIssuesTo: w.t.stateId('unstarted'),
          }),
      );
      expect(outcomes).toEqual(['ok', 'ok']);
    } finally {
      await drop();
    }
  });

  it('(c) setting a parent against a relation that starts at the parent', async () => {
    const w = await world('LRC');
    const x = await makeIssue(w.db, w.f, w.t.team.id, 'X');
    const p = await makeIssue(w.db, w.f, w.t.team.id, 'P');
    const drop = await slowTrigger(
      w.db,
      'update',
      'issue',
      'row',
      'new.parent_id is distinct from old.parent_id',
    );
    try {
      const outcomes = await race(
        w.db,
        () => updateIssue(w.db.orm, w.member, x.id, { parentId: p.id }),
        () => addRelation(w.db.orm, w.member, p.id, { relatedIssueId: x.id, type: 'blocks' }),
      );
      expect(outcomes).toEqual(['ok', 'ok']);
    } finally {
      await drop();
    }
  });

  it('(d) a create in a state against the archive of that state', async () => {
    const w = await world('LRD');
    const started = w.t.stateId('started');
    const drop = await slowTrigger(w.db, 'update', 'team', 'statement');
    try {
      const outcomes = await race(
        w.db,
        () =>
          createIssue(w.db.orm, w.member, { teamId: w.t.team.id, title: 'New', stateId: started }),
        () =>
          archiveWorkflowState(w.db.orm, w.owner, w.t.team.id, started, {
            moveIssuesTo: w.t.stateId('unstarted'),
          }),
      );
      // The archive always finishes; the create either got in first or finds the state archived (422).
      expect(outcomes[1]).toBe('ok');
      expect(['ok', 'invalid_reference']).toContain(outcomes[0]);
    } finally {
      await drop();
    }
  });
});
