import { event, issue, issueActivity, issueLabel } from '@torch/shared/db/schema';
import { asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { Db } from '../db.ts';
import { createWorkspaceFixture } from '../test/fixtures.ts';
import { actorOf, freshTeam, makeIssue, newLabel } from '../test/issue-helpers.ts';
import { useSharedDatabase } from '../test/shared-database.ts';
import { archiveIssue, unarchiveIssue } from './archive.ts';
import { updateIssue } from './update-issue.ts';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.warn(
    '[issues/update-issue-fields.test] SKIPPED: DATABASE_URL is not set. ' +
      'Start `docker compose -f docker-compose.dev.yml up -d --wait postgres` and set DATABASE_URL (see .env.example).',
  );
}

describe.skipIf(!databaseUrl)('updateIssue: every field, parents, labels, archive', () => {
  const getDb = useSharedDatabase();

  const rowOf = async (db: Db, id: string) => {
    const [row] = await db.orm.select().from(issue).where(eq(issue.id, id));
    if (!row) throw new Error('issue vanished');
    return row;
  };
  const activityOf = (db: Db, id: string) =>
    db.orm
      .select()
      .from(issueActivity)
      .where(eq(issueActivity.issueId, id))
      .orderBy(asc(issueActivity.createdAt));
  const eventsOf = (db: Db, id: string) =>
    db.orm.select().from(event).where(eq(event.subjectId, id)).orderBy(asc(event.occurredAt));

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

  it('state timestamps follow the state: set on entering, cleared on leaving completed or canceled', async () => {
    const w = await world('STT');
    const { db } = w;
    const created = await makeIssue(db, w.f, w.t.team.id, 'Timestamps');
    expect(created.startedAt).toBeNull();
    const step = async (type: 'started' | 'completed' | 'canceled' | 'unstarted') => {
      const result = await updateIssue(db.orm, w.owner, created.id, { stateId: w.t.stateId(type) });
      expect(result.ok, type).toBe(true);
      return rowOf(db, created.id);
    };

    const started = await step('started');
    expect(started.startedAt).not.toBeNull();
    const completed = await step('completed');
    expect(completed.completedAt).not.toBeNull();
    expect(completed.startedAt?.getTime()).toBe(started.startedAt?.getTime());
    const canceled = await step('canceled');
    expect(canceled.completedAt).toBeNull();
    expect(canceled.canceledAt).not.toBeNull();
    const back = await step('unstarted');
    expect(back.canceledAt).toBeNull();
    expect(back.completedAt).toBeNull();
  });

  it('updates description, estimate, due date, sort order and clears estimate, due date and parent with null', async () => {
    const w = await world('FLD');
    const parent = await makeIssue(w.db, w.f, w.t.team.id, 'Parent');
    const child = await makeIssue(w.db, w.f, w.t.team.id, 'Child');

    const set = await updateIssue(w.db.orm, w.member, child.id, {
      description: 'New body',
      estimate: 8,
      dueDate: '2027-01-31',
      sortOrder: 12.5,
      parentId: parent.id,
    });
    expect(set).toEqual({ ok: true, txid: expect.any(Number) });
    const after = await rowOf(w.db, child.id);
    expect(after).toMatchObject({
      description: 'New body',
      estimate: 8,
      dueDate: '2027-01-31',
      sortOrder: 12.5,
      parentId: parent.id,
    });

    await updateIssue(w.db.orm, w.member, child.id, {
      estimate: null,
      dueDate: null,
      parentId: null,
    });
    expect(await rowOf(w.db, child.id)).toMatchObject({
      estimate: null,
      dueDate: null,
      parentId: null,
    });
  });

  it('label group keeps one: adding a child of a group takes the other child off; remove works; unknown labels 422', async () => {
    const w = await world('LBL');
    const group = await newLabel(w.db, w.f, 'Area', { teamId: w.t.team.id, isGroup: true });
    const web = await newLabel(w.db, w.f, 'Web', { teamId: w.t.team.id, parentId: group.id });
    const api = await newLabel(w.db, w.f, 'API', { teamId: w.t.team.id, parentId: group.id });
    const bug = await newLabel(w.db, w.f, 'Bug');
    const target = await makeIssue(w.db, w.f, w.t.team.id, 'Labelled', { labelIds: [web.id] });
    const labelsOf = async () =>
      (await w.db.orm.select().from(issueLabel).where(eq(issueLabel.issueId, target.id)))
        .map((row) => row.labelId)
        .sort();

    expect(
      await updateIssue(w.db.orm, w.member, target.id, { addLabelIds: [api.id, bug.id] }),
    ).toMatchObject({ ok: true });
    expect(await labelsOf()).toEqual([api.id, bug.id].sort());

    expect(
      await updateIssue(w.db.orm, w.member, target.id, { removeLabelIds: [bug.id] }),
    ).toMatchObject({ ok: true });
    expect(await labelsOf()).toEqual([api.id]);

    for (const addLabelIds of [[group.id], ['99999999-9999-4999-8999-999999999999']]) {
      const refused = await updateIssue(w.db.orm, w.member, target.id, { addLabelIds });
      expect(refused).toMatchObject({
        ok: false,
        code: 'invalid_reference',
        status: 422,
        details: { field: 'addLabelIds' },
      });
    }
    const rows = (await activityOf(w.db, target.id)).filter((a) =>
      a.type.startsWith('issue.label'),
    );
    expect(rows.map((a) => [a.type, a.toValue ?? a.fromValue])).toEqual([
      ['issue.label_added', api.id],
      ['issue.label_added', bug.id],
      ['issue.label_removed', web.id],
      ['issue.label_removed', bug.id],
    ]);
  });

  it('self parent and descendant parent are 422 parent_cycle; a hidden or archived parent is invalid_reference', async () => {
    const w = await world('CYC');
    const a = await makeIssue(w.db, w.f, w.t.team.id, 'A');
    const b = await makeIssue(w.db, w.f, w.t.team.id, 'B', { parentId: a.id });
    const c = await makeIssue(w.db, w.f, w.t.team.id, 'C', { parentId: b.id });

    expect(await updateIssue(w.db.orm, w.owner, a.id, { parentId: a.id })).toMatchObject({
      ok: false,
      code: 'parent_cycle',
      status: 422,
    });
    for (const target of [b.id, c.id]) {
      expect(await updateIssue(w.db.orm, w.owner, a.id, { parentId: target })).toMatchObject({
        ok: false,
        code: 'parent_cycle',
        status: 422,
      });
    }
    expect((await rowOf(w.db, a.id)).parentId).toBeNull();

    await archiveIssue(w.db.orm, w.owner, a.id);
    const d = await makeIssue(w.db, w.f, w.t.team.id, 'D');
    expect(await updateIssue(w.db.orm, w.owner, d.id, { parentId: a.id })).toMatchObject({
      ok: false,
      code: 'invalid_reference',
      details: { field: 'parentId' },
    });
  });

  it('concurrent cycle: A under B and B under A at the same time leave exactly one applied', async () => {
    const w = await world('CCY');
    for (let round = 0; round < 6; round++) {
      const a = await makeIssue(w.db, w.f, w.t.team.id, `A${round}`);
      const b = await makeIssue(w.db, w.f, w.t.team.id, `B${round}`);
      const results = await Promise.all([
        updateIssue(w.db.orm, w.owner, a.id, { parentId: b.id }),
        updateIssue(w.db.orm, w.owner, b.id, { parentId: a.id }),
      ]);
      expect(
        results.filter((r) => r.ok),
        `round ${round}`,
      ).toHaveLength(1);
      expect(results.find((r) => !r.ok)).toMatchObject({ code: 'parent_cycle', status: 422 });
      const parents = [(await rowOf(w.db, a.id)).parentId, (await rowOf(w.db, b.id)).parentId];
      expect(parents.filter((p) => p !== null)).toHaveLength(1);
    }
  });

  it('archived is read-only: PATCH answers 409 issue_archived until unarchive; the number is kept', async () => {
    const w = await world('ARC');
    const target = await makeIssue(w.db, w.f, w.t.team.id, 'To archive');

    expect(await archiveIssue(w.db.orm, w.member, target.id)).toEqual({
      ok: true,
      txid: expect.any(Number),
    });
    const archived = await rowOf(w.db, target.id);
    expect(archived.archivedAt).not.toBeNull();
    expect(archived.number).toBe(target.number);
    expect(await updateIssue(w.db.orm, w.member, target.id, { title: 'nope' })).toMatchObject({
      ok: false,
      code: 'issue_archived',
      status: 409,
    });
    expect((await rowOf(w.db, target.id)).title).toBe('To archive');
    // Archiving twice changes nothing and records nothing more.
    const before = (await activityOf(w.db, target.id)).length;
    expect(await archiveIssue(w.db.orm, w.member, target.id)).toMatchObject({ ok: true });
    expect((await activityOf(w.db, target.id)).length).toBe(before);

    expect(await unarchiveIssue(w.db.orm, w.member, target.id)).toMatchObject({ ok: true });
    expect((await rowOf(w.db, target.id)).archivedAt).toBeNull();
    expect(await updateIssue(w.db.orm, w.member, target.id, { title: 'back' })).toMatchObject({
      ok: true,
    });
    expect((await activityOf(w.db, target.id)).map((a) => a.type)).toEqual([
      'issue.created',
      'issue.archived',
      'issue.unarchived',
      'issue.field_changed',
    ]);
    expect((await eventsOf(w.db, target.id)).map((e) => e.type)).toEqual([
      'issue.created',
      'issue.archived',
      'issue.updated',
      'issue.updated',
    ]);
  });

  it('archive of another workspace issue or a malformed id is 404', async () => {
    const w = await world('ARV');
    const other = await createWorkspaceFixture(w.db.orm);
    const target = await makeIssue(w.db, w.f, w.t.team.id, 'Private to this workspace');
    const foreign = await actorOf(w.db, other, 'owner');
    expect(await archiveIssue(w.db.orm, foreign, target.id)).toEqual({
      ok: false,
      code: 'not_found',
      status: 404,
    });
    expect(await archiveIssue(w.db.orm, w.owner, 'not-a-uuid')).toMatchObject({ status: 404 });
  });

  it('records activity and events for each change; description text never leaves the row', async () => {
    const w = await world('ACT');
    const target = await makeIssue(w.db, w.f, w.t.team.id, 'History');
    const secret = 'a private description';

    await updateIssue(w.db.orm, w.member, target.id, {
      description: secret,
      priority: 2,
      stateId: w.t.stateId('started'),
      assigneeId: w.f.members.admin.id,
    });

    const activity = await activityOf(w.db, target.id);
    const changed = activity.filter((a) => a.type === 'issue.field_changed');
    expect(changed.map((a) => a.field).sort()).toEqual([
      'assigneeId',
      'description',
      'priority',
      'stateId',
    ]);
    expect(changed.every((a) => a.client === 'web' && a.actorId === w.f.members.member.id)).toBe(
      true,
    );
    const events = await eventsOf(w.db, target.id);
    expect(events.map((e) => e.type).sort()).toEqual([
      'issue.assigned',
      'issue.created',
      'issue.state_changed',
      'issue.updated',
    ]);
    expect(JSON.stringify([activity, events])).not.toContain(secret);
    const updated = events.find((e) => e.type === 'issue.updated');
    expect(updated?.data).toMatchObject({ changes: { description: { changed: true } } });
  });
});
