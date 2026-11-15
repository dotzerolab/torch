import { event, issue, issueActivity, label, workflowState } from '@torch/shared/db/schema';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createIssue } from '../issues/create-issue.ts';
import { updateIssue } from '../issues/update-issue.ts';
import { archiveLabel, createLabel, listLabels, updateLabel } from '../labels/service.ts';
import { createWorkspaceFixture } from '../test/fixtures.ts';
import { actorOf, freshTeam, makeIssue, newLabel } from '../test/issue-helpers.ts';
import { useSharedDatabase } from '../test/shared-database.ts';
import {
  archiveWorkflowState,
  createWorkflowState,
  listWorkflowStates,
  updateWorkflowState,
} from './service.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.warn('[workflow/service.test] SKIPPED: DATABASE_URL is not set (see .env.example).');
}

describe.skipIf(!databaseUrl)('workflow states', () => {
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
      guest: await actorOf(db, f, 'guest'),
    };
  }

  it('creates a state at the end of the list, refuses a taken name and edits name, color and position', async () => {
    const w = await world('WFA');
    const created = await createWorkflowState(w.db.orm, w.owner, w.t.team.id, {
      name: 'Review',
      type: 'started',
    });
    expect(created.ok && created.value).toMatchObject({
      name: 'Review',
      position: 6,
      type: 'started',
    });
    const again = await createWorkflowState(w.db.orm, w.owner, w.t.team.id, {
      name: 'review',
      type: 'started',
    });
    expect(again).toMatchObject({ ok: false, code: 'workflow_state_name_taken', status: 409 });
    if (!created.ok) return;
    const edited = await updateWorkflowState(w.db.orm, w.owner, w.t.team.id, created.value.id, {
      name: 'In review',
      position: 3,
    });
    expect(edited.ok && edited.value).toMatchObject({ name: 'In review', position: 3 });
    const clash = await updateWorkflowState(w.db.orm, w.owner, w.t.team.id, created.value.id, {
      name: 'todo',
    });
    expect(clash).toMatchObject({ ok: false, code: 'workflow_state_name_taken' });
    expect(
      await updateWorkflowState(w.db.orm, w.member, w.t.team.id, created.value.id, {
        color: '#000000',
      }),
    ).toMatchObject({ ok: false, code: 'forbidden', status: 403 });
  });

  it('archive moves issues: each moved issue gets activity and an event, and the state is hidden', async () => {
    const w = await world('WFB');
    const started = w.t.stateId('started');
    const a = await makeIssue(w.db, w.f, w.t.team.id, 'In progress A', { stateId: started });
    const b = await makeIssue(w.db, w.f, w.t.team.id, 'In progress B', { stateId: started });
    const done = w.t.stateId('completed');

    const noTarget = await archiveWorkflowState(w.db.orm, w.owner, w.t.team.id, started);
    expect(noTarget).toMatchObject({ ok: false, code: 'move_target_required', status: 422 });
    const badTarget = await archiveWorkflowState(w.db.orm, w.owner, w.t.team.id, started, {
      moveIssuesTo: started,
    });
    expect(badTarget).toMatchObject({ ok: false, code: 'invalid_reference', status: 422 });

    const result = await archiveWorkflowState(w.db.orm, w.member, w.t.team.id, started, {
      moveIssuesTo: done,
    });
    expect(result).toMatchObject({ ok: false, code: 'forbidden' });
    const archived = await archiveWorkflowState(w.db.orm, w.owner, w.t.team.id, started, {
      moveIssuesTo: done,
    });
    expect(archived.ok && archived.value.archivedAt).toBeTruthy();

    for (const moved of [a, b]) {
      const [row] = await w.db.orm.select().from(issue).where(eq(issue.id, moved.id));
      expect(row?.stateId).toBe(done);
      expect(row?.completedAt).not.toBeNull();
      const activity = await w.db.orm
        .select()
        .from(issueActivity)
        .where(and(eq(issueActivity.issueId, moved.id), eq(issueActivity.field, 'stateId')));
      expect(activity).toHaveLength(1);
      expect(activity[0]).toMatchObject({ actorId: w.owner.memberId, client: 'web' });
      const events = await w.db.orm.select().from(event).where(eq(event.subjectId, moved.id));
      expect(events.map((e) => e.type)).toContain('issue.state_changed');
    }

    const visible = await listWorkflowStates(w.db.orm, w.guest, w.t.team.id);
    expect(visible.ok && visible.value.map((s) => s.id)).not.toContain(started);
    const all = await listWorkflowStates(w.db.orm, w.guest, w.t.team.id, { includeArchived: true });
    expect(all.ok && all.value.map((s) => s.id)).toContain(started);
    // The name is free again, and an archived state takes no new issue.
    const reuse = await createWorkflowState(w.db.orm, w.owner, w.t.team.id, {
      name: 'In Progress',
      type: 'started',
    });
    expect(reuse.ok).toBe(true);
    const into = await createIssue(w.db.orm, w.owner, {
      teamId: w.t.team.id,
      title: 'Late',
      stateId: started,
    });
    expect(into).toMatchObject({ ok: false });
    const move = await updateIssue(w.db.orm, w.owner, a.id, { stateId: started });
    expect(move).toMatchObject({ ok: false, code: 'invalid_state' });
    // Archiving twice changes nothing.
    expect((await archiveWorkflowState(w.db.orm, w.owner, w.t.team.id, started)).ok).toBe(true);
  });

  it('last completed state kept; a team keeps one backlog or unstarted state', async () => {
    const w = await world('WFC');
    expect(
      await archiveWorkflowState(w.db.orm, w.owner, w.t.team.id, w.t.stateId('completed')),
    ).toMatchObject({ ok: false, code: 'workflow_state_required', status: 422 });
    const [first] = await w.db.orm
      .select()
      .from(workflowState)
      .where(and(eq(workflowState.teamId, w.t.team.id), eq(workflowState.type, 'backlog')));
    // Backlog goes (Todo is unstarted and stays), then Todo may not.
    expect((await archiveWorkflowState(w.db.orm, w.owner, w.t.team.id, first?.id ?? '')).ok).toBe(
      true,
    );
    expect(
      await archiveWorkflowState(w.db.orm, w.owner, w.t.team.id, w.t.stateId('unstarted')),
    ).toMatchObject({ ok: false, code: 'workflow_state_required' });
    // A second completed state lets the first one go.
    await createWorkflowState(w.db.orm, w.owner, w.t.team.id, {
      name: 'Shipped',
      type: 'completed',
    });
    expect(
      (await archiveWorkflowState(w.db.orm, w.owner, w.t.team.id, w.t.stateId('completed'))).ok,
    ).toBe(true);
    // New issues now start in the unstarted state.
    const created = await createIssue(w.db.orm, w.owner, { teamId: w.t.team.id, title: 'Fresh' });
    expect(created.ok && created.body.issue.stateId).toBe(w.t.stateId('unstarted'));
  });

  it('two archives at once cannot leave the team without a backlog or unstarted state', async () => {
    const w = await world('WFD');
    const backlog = w.t.stateId('backlog');
    const unstarted = w.t.stateId('unstarted');
    const [one, two] = await Promise.all([
      archiveWorkflowState(w.db.orm, w.owner, w.t.team.id, backlog),
      archiveWorkflowState(w.db.orm, w.owner, w.t.team.id, unstarted),
    ]);
    expect([one.ok, two.ok].filter(Boolean)).toHaveLength(1);
  });

  it('a state of another team, a missing id and a hidden team are 404', async () => {
    const w = await world('WFE');
    const other = await freshTeam(w.db, w.f, 'WFF');
    expect(
      await archiveWorkflowState(w.db.orm, w.owner, w.t.team.id, other.stateId('started')),
    ).toMatchObject({ ok: false, status: 404 });
    expect(await listWorkflowStates(w.db.orm, w.owner, 'nope')).toMatchObject({
      ok: false,
      status: 404,
    });
  });
});

describe.skipIf(!databaseUrl)('labels', () => {
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
      guest: await actorOf(db, f, 'guest'),
    };
  }

  it('workspace labels are for admins, team labels for members, and names are unique per scope', async () => {
    const w = await world('LBA');
    const input = { name: 'Bug', color: '#ff0000' };
    expect(await createLabel(w.db.orm, w.member, input)).toMatchObject({ ok: false, status: 403 });
    expect((await createLabel(w.db.orm, w.owner, input)).ok).toBe(true);
    expect(await createLabel(w.db.orm, w.owner, { ...input, name: 'bug' })).toMatchObject({
      ok: false,
      code: 'label_name_taken',
      status: 409,
    });
    const own = { ...input, teamId: w.t.team.id };
    expect((await createLabel(w.db.orm, w.member, own)).ok).toBe(true);
    expect(await createLabel(w.db.orm, w.guest, { ...own, name: 'Other' })).toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it('a group label cannot be put on an issue; a child of another scope or team is 422', async () => {
    const w = await world('LBB');
    const other = await freshTeam(w.db, w.f, 'LBC');
    const group = await createLabel(w.db.orm, w.member, {
      name: 'Area',
      color: '#00ff00',
      teamId: w.t.team.id,
      isGroup: true,
    });
    if (!group.ok) throw new Error('group refused');
    const child = await createLabel(w.db.orm, w.member, {
      name: 'Web',
      color: '#00ff00',
      teamId: w.t.team.id,
      parentId: group.value.id,
    });
    expect(child.ok && child.value.parentId).toBe(group.value.id);

    const foreign = await createLabel(w.db.orm, w.owner, {
      name: 'Api',
      color: '#00ff00',
      teamId: other.team.id,
      parentId: group.value.id,
    });
    expect(foreign).toMatchObject({ ok: false, code: 'invalid_reference', status: 422 });
    const workspaceChild = await createLabel(w.db.orm, w.owner, {
      name: 'Ops',
      color: '#00ff00',
      parentId: group.value.id,
    });
    expect(workspaceChild).toMatchObject({ ok: false, code: 'invalid_reference' });
    const groupWithParent = await createLabel(w.db.orm, w.member, {
      name: 'Nested',
      color: '#00ff00',
      teamId: w.t.team.id,
      isGroup: true,
      parentId: group.value.id,
    });
    expect(groupWithParent).toMatchObject({ ok: false, status: 400 });

    const onIssue = await createIssue(w.db.orm, w.owner, {
      teamId: w.t.team.id,
      title: 'Labelled',
      labelIds: [group.value.id],
    });
    expect(onIssue).toMatchObject({ ok: false });
    const issueRow = await makeIssue(w.db, w.f, w.t.team.id, 'Plain');
    expect(
      await updateIssue(w.db.orm, w.owner, issueRow.id, { addLabelIds: [group.value.id] }),
    ).toMatchObject({ ok: false, code: 'invalid_reference' });
  });

  it('archive frees the name, keeps the label on its issues and is idempotent; edits need the right', async () => {
    const w = await world('LBD');
    const labelled = await newLabel(w.db, w.f, 'Old', { teamId: w.t.team.id });
    const issueRow = await makeIssue(w.db, w.f, w.t.team.id, 'Has old', {
      labelIds: [labelled.id],
    });
    expect(await archiveLabel(w.db.orm, w.guest, labelled.id)).toMatchObject({
      ok: false,
      status: 403,
    });
    expect((await archiveLabel(w.db.orm, w.member, labelled.id)).ok).toBe(true);
    expect((await archiveLabel(w.db.orm, w.member, labelled.id)).ok).toBe(true);
    expect(
      (
        await createLabel(w.db.orm, w.member, {
          name: 'old',
          color: '#000000',
          teamId: w.t.team.id,
        })
      ).ok,
    ).toBe(true);
    const [row] = await w.db.orm.select().from(label).where(eq(label.id, labelled.id));
    expect(row?.archivedAt).not.toBeNull();
    const shown = await listLabels(w.db.orm, w.guest, { teamId: w.t.team.id });
    expect(shown.ok && shown.value.map((l) => l.id)).not.toContain(labelled.id);
    expect(
      await updateIssue(w.db.orm, w.owner, issueRow.id, { addLabelIds: [labelled.id] }),
    ).toMatchObject({ ok: false, code: 'invalid_reference' });
    expect(await updateLabel(w.db.orm, w.member, labelled.id, { name: 'Older' })).toMatchObject({
      ok: true,
    });
  });
});
