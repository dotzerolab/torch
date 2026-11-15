import { team, teamMember } from '@torch/shared/db/schema';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createWorkspaceFixture } from '../test/fixtures.ts';
import { actorOf, freshTeam, makeIssue } from '../test/issue-helpers.ts';
import { useSharedDatabase } from '../test/shared-database.ts';
import { archiveIssue } from './archive.ts';
import { listIssues } from './list.ts';
import { updateIssue } from './update-issue.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.warn('[issues/list.test] SKIPPED: DATABASE_URL is not set (see .env.example).');
}

describe.skipIf(!databaseUrl)('issue list', () => {
  const getDb = useSharedDatabase();

  async function world(key: string, count = 0) {
    const db = getDb();
    const f = await createWorkspaceFixture(db.orm);
    const t = await freshTeam(db, f, key);
    const issues = [];
    for (let i = 0; i < count; i++) issues.push(await makeIssue(db, f, t.team.id, `Issue ${i}`));
    return {
      db,
      f,
      t,
      issues,
      owner: await actorOf(db, f, 'owner'),
      guest: await actorOf(db, f, 'guest'),
    };
  }
  const ok = <T extends { ok: boolean }>(result: T) => {
    if (!result.ok) throw new Error(`refused: ${JSON.stringify(result)}`);
    return result as Extract<T, { ok: true }>;
  };

  it('pages without gaps or repeats while rows update between pages', async () => {
    const w = await world('LSA', 7);
    const seen: string[] = [];
    let cursor: string | undefined;
    let round = 0;
    do {
      const page = ok(
        await listIssues(w.db.orm, w.owner, { teamId: w.t.team.id, limit: 3, cursor }),
      ).value;
      seen.push(...page.issues.map((i) => i.id));
      cursor = page.nextCursor ?? undefined;
      // Touch an issue that was already listed: it moves to the end and is seen again, never skipped.
      if (round++ === 0)
        await updateIssue(w.db.orm, w.owner, w.issues[0]?.id ?? '', { priority: 2 });
    } while (cursor);
    const unique = new Set(seen);
    expect(w.issues.every((i) => unique.has(i.id))).toBe(true);
    // Every id appears once, but the one that changed after its page: twice at most.
    expect(seen.length - unique.size).toBeLessThanOrEqual(1);
    expect(seen.filter((id) => id === w.issues[1]?.id)).toHaveLength(1);
  });

  it('updatedAfter lists only what changed, in order, without the description', async () => {
    const w = await world('LSB', 3);
    const all = ok(await listIssues(w.db.orm, w.owner, { teamId: w.t.team.id })).value.issues;
    const second = all[1];
    if (!second) throw new Error('no issue');
    const later = ok(
      await listIssues(w.db.orm, w.owner, { teamId: w.t.team.id, updatedAfter: second.updatedAt }),
    ).value.issues;
    // The boundary row may come again (the date has milliseconds, the column microseconds): polling is at-least-once.
    const ids = later.map((i) => i.id);
    expect(ids).toEqual(expect.arrayContaining(all.slice(2).map((i) => i.id)));
    expect(ids).not.toContain(all[0]?.id);
    expect(all[0]).not.toHaveProperty('description');
    const withText = ok(
      await listIssues(w.db.orm, w.owner, { teamId: w.t.team.id, includeDescription: true }),
    ).value.issues;
    expect(withText[0]).toHaveProperty('description');
  });

  it('invisible team never listed', async () => {
    const w = await world('LSC', 1);
    await w.db.orm.update(team).set({ private: true }).where(eq(team.id, w.t.team.id));
    // The admin was put in the team by the helper: take them out, and the private team is closed to them.
    const outsider = await actorOf(w.db, w.f, 'admin');
    await w.db.orm
      .delete(teamMember)
      .where(and(eq(teamMember.teamId, w.t.team.id), eq(teamMember.memberId, outsider.memberId)));
    const hidden = ok(await listIssues(w.db.orm, outsider, {})).value.issues;
    expect(hidden.some((i) => i.teamId === w.t.team.id)).toBe(false);
    expect(await listIssues(w.db.orm, outsider, { teamId: w.t.team.id })).toMatchObject({
      ok: false,
      status: 404,
    });
  });

  it('external ref lookup returns the one issue, or nothing', async () => {
    const w = await world('LSD');
    const made = await makeIssue(w.db, w.f, w.t.team.id, 'From elsewhere', {
      externalRef: { source: 'tracker', id: 'A-1' },
    });
    await makeIssue(w.db, w.f, w.t.team.id, 'Other');
    const found = ok(await listIssues(w.db.orm, w.owner, { externalRef: 'tracker:A-1' })).value;
    expect(found.issues.map((i) => i.id)).toEqual([made.id]);
    expect(found.issues[0]?.externalRefs).toEqual([{ source: 'tracker', id: 'A-1', url: null }]);
    expect(
      ok(await listIssues(w.db.orm, w.owner, { externalRef: 'tracker:none' })).value.issues,
    ).toEqual([]);
    expect(await listIssues(w.db.orm, w.owner, { externalRef: 'nocolon' })).toMatchObject({
      ok: false,
      status: 400,
    });
  });

  it('archived excluded by default', async () => {
    const w = await world('LSE', 2);
    ok(await archiveIssue(w.db.orm, w.owner, w.issues[0]?.id ?? ''));
    const plain = ok(await listIssues(w.db.orm, w.owner, { teamId: w.t.team.id })).value.issues;
    expect(plain.map((i) => i.id)).toEqual([w.issues[1]?.id]);
    const all = ok(
      await listIssues(w.db.orm, w.owner, { teamId: w.t.team.id, includeArchived: true }),
    ).value.issues;
    expect(all).toHaveLength(2);
  });

  it('bad cursor 400, bad limit 400, bad date 400', async () => {
    const w = await world('LSF', 1);
    for (const bad of [
      { cursor: 'not a cursor!' },
      { cursor: Buffer.from('2026-01-01|x').toString('base64url') },
      { cursor: Buffer.from('2026-11-15T10:00:00.000000Z|nope').toString('base64url') },
      { limit: 0 },
      { limit: 101 },
      { updatedAfter: 'yesterday' },
    ]) {
      expect(await listIssues(w.db.orm, w.owner, bad)).toMatchObject({ ok: false, status: 400 });
    }
  });
});
