import { event, externalRef, type IssueRow, issue, issueActivity } from '@torch/shared/db/schema';
import { and, asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { Db } from '../db.ts';
import type { ClientActor } from '../permissions/load-actor.ts';
import { createWorkspaceFixture, type WorkspaceFixture } from '../test/fixtures.ts';
import { useSharedDatabase } from '../test/shared-database.ts';
import { recordIssueChange } from './record.ts';

const databaseUrl = process.env.DATABASE_URL;

// Integration: needs the dev compose Postgres (see db.test.ts). Skipped, loudly, when DATABASE_URL is not set.
if (!databaseUrl) {
  console.warn(
    '[activity/record.test] SKIPPED the change recorder tests: DATABASE_URL is not set. ' +
      'Start `docker compose -f docker-compose.dev.yml up -d --wait postgres` and set DATABASE_URL (see .env.example).',
  );
}

const actorOf = (f: WorkspaceFixture, client: ClientActor['client'] = 'web'): ClientActor => ({
  workspaceId: f.workspaceId,
  memberId: f.members.member.id,
  role: 'member',
  teamIds: new Set([f.teams.eng.id]),
  client,
});

describe.skipIf(!databaseUrl)('recordIssueChange', () => {
  const getDb = useSharedDatabase();

  async function setup() {
    const db: Db = getDb();
    const f = await createWorkspaceFixture(db.orm);
    const first = f.issues.eng[0] as IssueRow;
    const update = async (set: Partial<typeof issue.$inferInsert>) => {
      const [after] = await db.orm.update(issue).set(set).where(eq(issue.id, first.id)).returning();
      return after as IssueRow;
    };
    const rows = async () => ({
      activity: await db.orm
        .select()
        .from(issueActivity)
        .where(eq(issueActivity.issueId, first.id))
        .orderBy(asc(issueActivity.field), asc(issueActivity.type)),
      events: await db.orm
        .select()
        .from(event)
        .where(eq(event.workspaceId, f.workspaceId))
        .orderBy(asc(event.type)),
    });
    return { db, f, first, update, rows };
  }

  it('an update of title and state writes two activity rows and two events', async () => {
    const { db, f, first, update, rows } = await setup();
    const after = await update({ title: 'A better title', stateId: f.states.eng.started.id });

    await db.orm.transaction((tx) =>
      recordIssueChange(tx, actorOf(f), { kind: 'updated', before: first, after }),
    );

    const { activity, events } = await rows();
    expect(activity.map((row) => [row.field, row.type])).toEqual([
      ['stateId', 'issue.field_changed'],
      ['title', 'issue.field_changed'],
    ]);
    const title = activity.find((row) => row.field === 'title');
    expect(title).toMatchObject({
      fromValue: first.title,
      toValue: 'A better title',
      actorId: f.members.member.id,
      client: 'web',
      teamId: f.teams.eng.id,
      workspaceId: f.workspaceId,
    });
    const state = activity.find((row) => row.field === 'stateId');
    expect(state).toMatchObject({ fromValue: first.stateId, toValue: f.states.eng.started.id });

    expect(events.map((row) => row.type)).toEqual(['issue.state_changed', 'issue.updated']);
    for (const row of events) {
      expect(row).toMatchObject({
        version: 1,
        actorId: f.members.member.id,
        client: 'web',
        subjectType: 'issue',
        subjectId: first.id,
        teamId: f.teams.eng.id,
      });
      expect(row.data).toMatchObject({ identifier: 'ENG-1', number: 1 });
    }
    const updated = events.find((row) => row.type === 'issue.updated');
    expect(updated?.data.changes).toEqual({
      title: { before: first.title, after: 'A better title' },
      stateId: { before: first.stateId, after: f.states.eng.started.id },
    });
    const stateEvent = events.find((row) => row.type === 'issue.state_changed');
    expect(stateEvent?.data.changes).toEqual({
      stateId: { before: first.stateId, after: f.states.eng.started.id },
    });
  });

  it('a rolled-back transaction leaves no activity and no event', async () => {
    const { db, f, first, update, rows } = await setup();
    const after = await update({ title: 'Never committed' });

    await expect(
      db.orm.transaction(async (tx) => {
        await recordIssueChange(tx, actorOf(f), { kind: 'updated', before: first, after });
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');

    const { activity, events } = await rows();
    expect(activity).toEqual([]);
    expect(events).toEqual([]);
  });

  it('a description change records the field and no text', async () => {
    const { db, f, first, update, rows } = await setup();
    const after = await update({ description: 'Secret launch notes, never in history' });

    await db.orm.transaction((tx) =>
      recordIssueChange(tx, actorOf(f), { kind: 'updated', before: first, after }),
    );

    const { activity, events } = await rows();
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({ field: 'description', fromValue: null, toValue: null });
    expect(events).toHaveLength(1);
    expect(events[0]?.data.changes).toEqual({ description: { changed: true } });
    expect(JSON.stringify([activity, events])).not.toContain('Secret launch notes');
  });

  it('an assignee change writes issue.assigned next to issue.updated', async () => {
    const { db, f, first, update, rows } = await setup();
    const after = await update({ assigneeId: f.members.admin.id });

    await db.orm.transaction((tx) =>
      recordIssueChange(tx, actorOf(f), { kind: 'updated', before: first, after }),
    );

    const { events } = await rows();
    expect(events.map((row) => row.type)).toEqual(['issue.assigned', 'issue.updated']);
    const assigned = events.find((row) => row.type === 'issue.assigned');
    expect(assigned?.data.changes).toEqual({
      assigneeId: { before: first.assigneeId, after: f.members.admin.id },
    });
  });

  it('a change of sort order or of the state timestamps alone records nothing', async () => {
    const { db, f, first, update, rows } = await setup();
    const after = await update({ sortOrder: -5, startedAt: new Date() });

    await db.orm.transaction((tx) =>
      recordIssueChange(tx, actorOf(f), { kind: 'updated', before: first, after }),
    );

    const { activity, events } = await rows();
    expect(activity).toEqual([]);
    expect(events).toEqual([]);
  });

  it('the client of the actor is the client of every row', async () => {
    const { db, f, first, update, rows } = await setup();
    const after = await update({ priority: 1 });

    await db.orm.transaction((tx) =>
      recordIssueChange(tx, actorOf(f, 'api'), { kind: 'updated', before: first, after }),
    );

    const { activity, events } = await rows();
    expect([...activity, ...events].map((row) => row.client)).toEqual(['api', 'api']);
  });

  it('a created issue writes one activity row and an issue.created event with its external reference', async () => {
    const { db, f, first, rows } = await setup();
    const [ref] = await db.orm
      .insert(externalRef)
      .values({
        workspaceId: f.workspaceId,
        subjectType: 'issue',
        subjectId: first.id,
        source: 'tracker',
        externalId: 'REQ-7',
        url: 'https://example.test/r/7',
      })
      .returning();

    await db.orm.transaction((tx) =>
      recordIssueChange(tx, actorOf(f), { kind: 'created', issue: first, externalRef: ref }),
    );

    const { activity, events } = await rows();
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({ type: 'issue.created', field: null });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'issue.created', subjectId: first.id });
    expect(events[0]?.data).toMatchObject({
      identifier: 'ENG-1',
      number: 1,
      issue: { title: first.title, stateId: first.stateId, priority: first.priority },
      externalRefs: [{ source: 'tracker', id: 'REQ-7', url: 'https://example.test/r/7' }],
    });
    expect(JSON.stringify(events[0]?.data)).not.toContain(first.description || 'no-description');
  });

  it('events of an issue that has an external reference carry it', async () => {
    const { db, f, first, update, rows } = await setup();
    await db.orm.insert(externalRef).values({
      workspaceId: f.workspaceId,
      subjectType: 'issue',
      subjectId: first.id,
      source: 'tracker',
      externalId: 'REQ-8',
    });
    const after = await update({ priority: 2 });

    await db.orm.transaction((tx) =>
      recordIssueChange(tx, actorOf(f), { kind: 'updated', before: first, after }),
    );

    const { events } = await rows();
    expect(events[0]?.data.externalRefs).toEqual([{ source: 'tracker', id: 'REQ-8', url: null }]);
  });

  it('label changes write one activity row per label and one issue.updated event', async () => {
    const { db, f, first, rows } = await setup();
    const added = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
    const removed = ['33333333-3333-4333-8333-333333333333'];

    await db.orm.transaction((tx) =>
      recordIssueChange(tx, actorOf(f), { kind: 'labels', issueId: first.id, added, removed }),
    );

    const { activity, events } = await rows();
    expect(activity.map((row) => [row.type, row.field])).toEqual([
      ['issue.label_added', 'labels'],
      ['issue.label_added', 'labels'],
      ['issue.label_removed', 'labels'],
    ]);
    expect(
      activity
        .filter((row) => row.type === 'issue.label_added')
        .map((row) => row.toValue)
        .sort(),
    ).toEqual(added);
    expect(activity.find((row) => row.type === 'issue.label_removed')?.fromValue).toBe(removed[0]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'issue.updated' });
    expect(events[0]?.data.changes).toEqual({ labels: { added, removed } });
  });

  it('a label change that adds and removes nothing records nothing', async () => {
    const { db, f, first, rows } = await setup();

    await db.orm.transaction((tx) =>
      recordIssueChange(tx, actorOf(f), {
        kind: 'labels',
        issueId: first.id,
        added: [],
        removed: [],
      }),
    );

    const { activity, events } = await rows();
    expect(activity).toEqual([]);
    expect(events).toEqual([]);
  });

  it.each([
    ['relation', 'added', 'issue.relation_added', 'relations'],
    ['relation', 'removed', 'issue.relation_removed', 'relations'],
    ['subscriber', 'added', 'issue.subscriber_added', 'subscribers'],
    ['subscriber', 'removed', 'issue.subscriber_removed', 'subscribers'],
    ['link', 'added', 'issue.link_added', 'links'],
    ['link', 'removed', 'issue.link_removed', 'links'],
    ['attachment', 'added', 'issue.attachment_added', 'attachments'],
    ['attachment', 'removed', 'issue.attachment_removed', 'attachments'],
  ] as const)('a %s %s writes %s and one issue.updated event', async (kind, op, type, key) => {
    const { db, f, first, rows } = await setup();
    const data = { id: '44444444-4444-4444-8444-444444444444', note: 'x' };

    await db.orm.transaction((tx) =>
      recordIssueChange(tx, actorOf(f), { kind, issueId: first.id, op, data }),
    );

    const { activity, events } = await rows();
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({ type, field: key });
    expect(op === 'added' ? activity[0]?.toValue : activity[0]?.fromValue).toEqual(data);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'issue.updated' });
    expect(events[0]?.data.changes).toEqual({ [key]: { [op]: [data] } });
  });

  it('an attachment change carries the file name, size and type, never a storage key', async () => {
    const { db, f, first, rows } = await setup();
    const data = {
      attachmentId: '55555555-5555-4555-8555-555555555555',
      fileName: 'report.pdf',
      size: 2048,
      contentType: 'application/pdf',
    };

    await db.orm.transaction((tx) =>
      recordIssueChange(tx, actorOf(f), {
        kind: 'attachment',
        issueId: first.id,
        op: 'added',
        data,
      }),
    );

    const { activity, events } = await rows();
    expect(activity[0]?.toValue).toEqual(data);
    expect(events[0]?.data.changes).toEqual({ attachments: { added: [data] } });
    expect(JSON.stringify([activity, events])).not.toContain('storage');
    expect(JSON.stringify([activity, events])).not.toContain('workspaces/');
  });

  it('archiving writes issue.archived; unarchiving writes issue.updated with the archive timestamp', async () => {
    const { db, f, update, rows } = await setup();
    const stamp = new Date('2026-11-01T10:00:00.000Z');
    const archived = await update({ archivedAt: stamp });

    await db.orm.transaction((tx) =>
      recordIssueChange(tx, actorOf(f), { kind: 'archived', issue: archived }),
    );
    const afterArchive = await rows();
    expect(afterArchive.activity.map((row) => row.type)).toEqual(['issue.archived']);
    expect(afterArchive.events.map((row) => row.type)).toEqual(['issue.archived']);

    const restored = await update({ archivedAt: null });
    await db.orm.transaction((tx) =>
      recordIssueChange(tx, actorOf(f), { kind: 'unarchived', issue: restored }),
    );
    const afterRestore = await rows();
    expect(afterRestore.activity.map((row) => row.type).sort()).toEqual([
      'issue.archived',
      'issue.unarchived',
    ]);
    expect(afterRestore.events.map((row) => row.type)).toEqual(['issue.archived', 'issue.updated']);
    const updated = afterRestore.events.find((row) => row.type === 'issue.updated');
    expect(updated?.data.changes).toEqual({ archivedAt: { after: null } });
    const archivedEvent = afterRestore.events.find((row) => row.type === 'issue.archived');
    expect(archivedEvent?.data.archivedAt).toBe(stamp.toISOString());
  });

  it('an issue of another workspace is refused', async () => {
    const { db, f, first } = await setup();
    const other = await createWorkspaceFixture(db.orm);

    await expect(
      db.orm.transaction((tx) =>
        recordIssueChange(tx, actorOf(other), {
          kind: 'labels',
          issueId: first.id,
          added: ['11111111-1111-4111-8111-111111111111'],
          removed: [],
        }),
      ),
    ).rejects.toThrow(/issue not found/);
    expect(
      await db.orm
        .select()
        .from(issueActivity)
        .where(
          and(eq(issueActivity.issueId, first.id), eq(issueActivity.workspaceId, f.workspaceId)),
        ),
    ).toEqual([]);
  });
});
