import {
  type ActivityClient,
  event,
  externalRef,
  idempotencyKey,
  issue,
  issueActivity,
  issueLabel,
  issueLink,
  issueSubscriber,
  label,
  member,
  team,
  teamMember,
  workflowState,
} from '@torch/shared/db/schema';
import { defaultWorkflowStates } from '@torch/shared/db/workflow-defaults';
import type { IssueCreateInput } from '@torch/shared/mutations/issue';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { Db } from '../db.ts';
import { type ClientActor, loadClientActor } from '../permissions/load-actor.ts';
import { createWorkspaceFixture, type WorkspaceFixture } from '../test/fixtures.ts';
import { useSharedDatabase } from '../test/shared-database.ts';
import { createIssue } from './create-issue.ts';

const databaseUrl = process.env.DATABASE_URL;

// Integration: needs the dev compose Postgres (see db.test.ts). Skipped, loudly, when DATABASE_URL is not set.
if (!databaseUrl) {
  console.warn(
    '[issues/create-issue.test] SKIPPED the createIssue tests: DATABASE_URL is not set. ' +
      'Start `docker compose -f docker-compose.dev.yml up -d --wait postgres` and set DATABASE_URL (see .env.example).',
  );
}

type Who = keyof WorkspaceFixture['members'];

describe.skipIf(!databaseUrl)('createIssue', () => {
  const getDb = useSharedDatabase();

  const actorOf = async (
    db: Db,
    f: WorkspaceFixture,
    who: Who,
    client: ActivityClient = 'web',
  ): Promise<ClientActor> => {
    const actor = await loadClientActor(db.orm, f.workspaceId, f.members[who].id, client);
    if (!actor) throw new Error(`no actor for ${who}`);
    return actor;
  };

  /** A new public team with the default workflow, no issues (counter 0) and the four layout roles in it (not the outsider). */
  async function freshTeam(
    db: Db,
    f: WorkspaceFixture,
    key: string,
    opts: { withoutBacklog?: boolean; without?: Who[] } = {},
  ) {
    const [created] = await db.orm
      .insert(team)
      .values({ workspaceId: f.workspaceId, key, name: `Team ${key}` })
      .returning();
    if (!created) throw new Error('team insert returned no row');
    const defaults = defaultWorkflowStates().filter(
      (state) => !(opts.withoutBacklog && state.type === 'backlog'),
    );
    const states = await db.orm
      .insert(workflowState)
      .values(
        defaults.map((state) => ({ workspaceId: f.workspaceId, teamId: created.id, ...state })),
      )
      .returning();
    const roles = (['owner', 'admin', 'member', 'guest'] as const).filter(
      (who) => !opts.without?.includes(who),
    );
    await db.orm.insert(teamMember).values(
      roles.map((who) => ({
        workspaceId: f.workspaceId,
        teamId: created.id,
        memberId: f.members[who].id,
      })),
    );
    const stateId = (type: (typeof states)[number]['type']) => {
      const found = states.find((state) => state.type === type);
      if (!found) throw new Error(`no ${type} state`);
      return found.id;
    };
    return { team: created, stateId };
  }

  const newLabel = async (
    db: Db,
    f: WorkspaceFixture,
    name: string,
    over: Partial<typeof label.$inferInsert> = {},
  ) => {
    const [row] = await db.orm
      .insert(label)
      .values({ workspaceId: f.workspaceId, name, color: '#336699', ...over })
      .returning();
    if (!row) throw new Error('label insert returned no row');
    return row;
  };

  const ok = async (promise: ReturnType<typeof createIssue>) => {
    const result = await promise;
    if (!result.ok) throw new Error(`expected a created issue, got ${result.error.code}`);
    return result;
  };
  const refused = async (promise: ReturnType<typeof createIssue>) => {
    const result = await promise;
    if (result.ok) throw new Error('expected a refusal, got a created issue');
    return result.error;
  };

  const issuesOf = (db: Db, teamId: string) =>
    db.orm.select().from(issue).where(eq(issue.teamId, teamId));
  const counterOf = async (db: Db, teamId: string) =>
    (await db.orm.select({ n: team.issueCounter }).from(team).where(eq(team.id, teamId)))[0]?.n;

  it('all fields in one call', async () => {
    const db = getDb();
    const f = await createWorkspaceFixture(db.orm);
    const t = await freshTeam(db, f, 'ALL');
    const teamLabel = await newLabel(db, f, 'Bug', { teamId: t.team.id });
    const workspaceLabel = await newLabel(db, f, 'Frontend');
    const parent = f.issues.eng[0];
    if (!parent) throw new Error('no parent issue');
    const actor = await actorOf(db, f, 'member');

    const input: IssueCreateInput = {
      teamId: t.team.id,
      title: '  Everything at once  ',
      description: 'The body',
      stateId: t.stateId('started'),
      priority: 2,
      estimate: 5,
      assigneeId: f.members.admin.id,
      labelIds: [teamLabel.id, workspaceLabel.id],
      dueDate: '2026-12-31',
      parentId: parent.id,
      subscriberIds: [f.members.guest.id],
      links: [
        { url: 'https://example.test/spec', title: 'Spec' },
        { url: 'http://example.test/two' },
      ],
      sortOrder: 7.5,
      externalRef: { source: 'tracker', id: 'REQ-1', url: 'https://example.test/r/1' },
    };
    const { body, replayed } = await ok(createIssue(db.orm, actor, input));

    expect(replayed).toBe(false);
    expect(Number.isInteger(body.txid) && body.txid > 0).toBe(true);
    expect(body.issue).toMatchObject({
      identifier: 'ALL-1',
      number: 1,
      teamId: t.team.id,
      title: 'Everything at once',
      description: 'The body',
      stateId: t.stateId('started'),
      priority: 2,
      estimate: 5,
      assigneeId: f.members.admin.id,
      creatorId: f.members.member.id,
      dueDate: '2026-12-31',
      parentId: parent.id,
      sortOrder: 7.5,
      archivedAt: null,
      completedAt: null,
      canceledAt: null,
    });
    expect(body.issue.startedAt).toEqual(expect.any(String));
    expect([...body.issue.labelIds].sort()).toEqual([teamLabel.id, workspaceLabel.id].sort());
    expect(body.issue.externalRefs).toEqual([
      { source: 'tracker', id: 'REQ-1', url: 'https://example.test/r/1' },
    ]);

    const id = body.issue.id;
    const labels = await db.orm.select().from(issueLabel).where(eq(issueLabel.issueId, id));
    expect(labels.map((row) => row.labelId).sort()).toEqual(
      [teamLabel.id, workspaceLabel.id].sort(),
    );
    // The creator and the assignee are subscribed on top of the people the caller listed.
    const subscribers = await db.orm
      .select()
      .from(issueSubscriber)
      .where(eq(issueSubscriber.issueId, id));
    expect(subscribers.map((row) => row.memberId).sort()).toEqual(
      [f.members.member.id, f.members.admin.id, f.members.guest.id].sort(),
    );
    const links = await db.orm.select().from(issueLink).where(eq(issueLink.issueId, id));
    expect(links.map((row) => [row.url, row.title, row.createdBy]).sort()).toEqual([
      ['http://example.test/two', null, f.members.member.id],
      ['https://example.test/spec', 'Spec', f.members.member.id],
    ]);
    const refs = await db.orm.select().from(externalRef).where(eq(externalRef.subjectId, id));
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ source: 'tracker', externalId: 'REQ-1', subjectType: 'issue' });

    const activity = await db.orm.select().from(issueActivity).where(eq(issueActivity.issueId, id));
    expect(activity.map((row) => row.type)).toEqual(['issue.created']);
    const events = await db.orm.select().from(event).where(eq(event.subjectId, id));
    expect(events.map((row) => row.type)).toEqual(['issue.created']);
    expect(events[0]?.data).toMatchObject({
      identifier: 'ALL-1',
      externalRefs: [{ source: 'tracker', id: 'REQ-1', url: 'https://example.test/r/1' }],
    });
    expect(await counterOf(db, t.team.id)).toBe(1);
  });

  it('records the client the caller authenticated through', async () => {
    const db = getDb();
    const f = await createWorkspaceFixture(db.orm);
    const t = await freshTeam(db, f, 'CLI');
    const actor = await actorOf(db, f, 'admin', 'api');

    const { body } = await ok(
      createIssue(db.orm, actor, { teamId: t.team.id, title: 'Through the API' }),
    );

    const events = await db.orm.select().from(event).where(eq(event.subjectId, body.issue.id));
    const activity = await db.orm
      .select()
      .from(issueActivity)
      .where(eq(issueActivity.issueId, body.issue.id));
    expect([...events, ...activity].map((row) => row.client)).toEqual(['api', 'api']);
  });

  it('parallel creates: 50 at once get numbers 1..50 with no gap and no duplicate', async () => {
    const db = getDb();
    const f = await createWorkspaceFixture(db.orm);
    const t = await freshTeam(db, f, 'PAR');
    const actor = await actorOf(db, f, 'member');

    const results = await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        createIssue(db.orm, actor, { teamId: t.team.id, title: `Parallel ${index}` }),
      ),
    );

    const numbers = results.map((result) => (result.ok ? result.body.issue.number : -1));
    expect([...numbers].sort((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect((await issuesOf(db, t.team.id)).map((row) => row.number).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 50 }, (_, i) => i + 1),
    );
    expect(await counterOf(db, t.team.id)).toBe(50);
  });

  it('replay keeps the number: the same key and body answer again without a new issue', async () => {
    const db = getDb();
    const f = await createWorkspaceFixture(db.orm);
    const t = await freshTeam(db, f, 'REP');
    const actor = await actorOf(db, f, 'member');
    const input = { teamId: t.team.id, title: 'Once only', labelIds: [] };

    const first = await ok(createIssue(db.orm, actor, input, { idempotencyKey: 'key-1' }));
    const second = await ok(createIssue(db.orm, actor, input, { idempotencyKey: 'key-1' }));

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.body.issue.id).toBe(first.body.issue.id);
    expect(second.body.issue.number).toBe(1);
    expect(await issuesOf(db, t.team.id)).toHaveLength(1);
    expect(await counterOf(db, t.team.id)).toBe(1);
    const events = await db.orm.select().from(event).where(eq(event.workspaceId, f.workspaceId));
    expect(events.filter((row) => row.type === 'issue.created')).toHaveLength(1);
    // The next create without a key takes number 2: the replay consumed none.
    const next = await ok(createIssue(db.orm, actor, { teamId: t.team.id, title: 'Next' }));
    expect(next.body.issue.number).toBe(2);
  });

  it('a replay passes the current visibility check and keeps no copy of the description', async () => {
    const db = getDb();
    const f = await createWorkspaceFixture(db.orm);
    const t = await freshTeam(db, f, 'REV');
    const actor = await actorOf(db, f, 'member');
    const input = { teamId: t.team.id, title: 'Secret plan', description: 'password hunter2' };

    const first = await ok(createIssue(db.orm, actor, input, { idempotencyKey: 'key-priv' }));
    expect(first.body.issue.description).toBe('password hunter2');
    // The stored answer is the issue id, never the text.
    const [stored] = await db.orm
      .select()
      .from(idempotencyKey)
      .where(eq(idempotencyKey.workspaceId, f.workspaceId));
    expect(JSON.stringify(stored?.response)).not.toContain('hunter2');
    expect(stored?.response).toMatchObject({ issueId: first.body.issue.id });

    // A replay while the actor still sees the team rebuilds the answer, with the issue as it is now.
    await db.orm
      .update(issue)
      .set({ description: 'edited later' })
      .where(eq(issue.id, first.body.issue.id));
    const again = await ok(createIssue(db.orm, actor, input, { idempotencyKey: 'key-priv' }));
    expect(again.replayed).toBe(true);
    expect(again.body.issue.id).toBe(first.body.issue.id);
    expect(again.body.txid).toBe(first.body.txid);

    // The team turns private and the actor is no longer in it: the same replay is 404.
    await db.orm.update(team).set({ private: true }).where(eq(team.id, t.team.id));
    await db.orm
      .delete(teamMember)
      .where(and(eq(teamMember.teamId, t.team.id), eq(teamMember.memberId, f.members.member.id)));
    const denied = await createIssue(db.orm, actor, input, { idempotencyKey: 'key-priv' });
    expect(denied).toMatchObject({ ok: false, error: { status: 404, code: 'not_found' } });
  });

  it('two requests with one key at the same time create one issue', async () => {
    const db = getDb();
    const f = await createWorkspaceFixture(db.orm);
    const t = await freshTeam(db, f, 'RAC');
    const actor = await actorOf(db, f, 'member');
    const input = { teamId: t.team.id, title: 'Racing' };

    const results = await Promise.all([
      createIssue(db.orm, actor, input, { idempotencyKey: 'race' }),
      createIssue(db.orm, actor, input, { idempotencyKey: 'race' }),
      createIssue(db.orm, actor, input, { idempotencyKey: 'race' }),
    ]);

    const created = results.filter((result) => result.ok && !result.replayed);
    const replays = results.filter((result) => result.ok && result.replayed);
    expect(created).toHaveLength(1);
    expect(replays).toHaveLength(2);
    expect(await issuesOf(db, t.team.id)).toHaveLength(1);
  });

  it('key reused with another body is refused; another actor may use the same key', async () => {
    const db = getDb();
    const f = await createWorkspaceFixture(db.orm);
    const t = await freshTeam(db, f, 'KEY');
    const member = await actorOf(db, f, 'member');
    const admin = await actorOf(db, f, 'admin');

    await ok(
      createIssue(
        db.orm,
        member,
        { teamId: t.team.id, title: 'First' },
        { idempotencyKey: 'shared' },
      ),
    );
    const error = await refused(
      createIssue(
        db.orm,
        member,
        { teamId: t.team.id, title: 'Different' },
        { idempotencyKey: 'shared' },
      ),
    );
    expect(error).toMatchObject({ code: 'idempotency_key_reused', status: 422 });
    expect(await issuesOf(db, t.team.id)).toHaveLength(1);

    const other = await ok(
      createIssue(
        db.orm,
        admin,
        { teamId: t.team.id, title: 'Different' },
        { idempotencyKey: 'shared' },
      ),
    );
    expect(other.replayed).toBe(false);
    expect(await issuesOf(db, t.team.id)).toHaveLength(2);
  });

  it('a refused create does not keep its key', async () => {
    const db = getDb();
    const f = await createWorkspaceFixture(db.orm);
    const t = await freshTeam(db, f, 'REF');
    const actor = await actorOf(db, f, 'member');
    const key = { idempotencyKey: 'retry' };

    const first = await refused(
      createIssue(
        db.orm,
        actor,
        { teamId: t.team.id, title: 'Bad', stateId: f.states.ops.backlog.id },
        key,
      ),
    );
    expect(first.code).toBe('invalid_reference');
    const second = await ok(createIssue(db.orm, actor, { teamId: t.team.id, title: 'Good' }, key));

    expect(second.replayed).toBe(false);
    expect(second.body.issue.number).toBe(1);
  });

  it('an external reference in use answers 409 and consumes no number', async () => {
    const db = getDb();
    const f = await createWorkspaceFixture(db.orm);
    const t = await freshTeam(db, f, 'EXT');
    const actor = await actorOf(db, f, 'member');
    const externalRefInput = { source: 'tracker', id: 'REQ-9' };

    const first = await ok(
      createIssue(db.orm, actor, { teamId: t.team.id, title: 'A', externalRef: externalRefInput }),
    );
    const second = await refused(
      createIssue(db.orm, actor, { teamId: t.team.id, title: 'B', externalRef: externalRefInput }),
    );

    expect(second).toMatchObject({
      code: 'external_ref_exists',
      status: 409,
      details: { issueId: first.body.issue.id, identifier: 'EXT-1' },
    });
    expect(await counterOf(db, t.team.id)).toBe(1);
    const third = await ok(createIssue(db.orm, actor, { teamId: t.team.id, title: 'C' }));
    expect(third.body.issue.number).toBe(2);
  });

  it('two creates with one external reference at the same time: one wins, one gets 409', async () => {
    const db = getDb();
    const f = await createWorkspaceFixture(db.orm);
    const t = await freshTeam(db, f, 'ERC');
    const actor = await actorOf(db, f, 'member');
    const externalRefInput = { source: 'tracker', id: 'RACE' };

    const results = await Promise.all(
      [1, 2, 3].map((n) =>
        createIssue(db.orm, actor, {
          teamId: t.team.id,
          title: `R${n}`,
          externalRef: externalRefInput,
        }),
      ),
    );

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const errors = results.flatMap((result) => (result.ok ? [] : [result.error]));
    expect(errors.map((error) => [error.code, error.status])).toEqual([
      ['external_ref_exists', 409],
      ['external_ref_exists', 409],
    ]);
    expect(await counterOf(db, t.team.id)).toBe(1);
    expect(await issuesOf(db, t.team.id)).toHaveLength(1);
  });

  it('the conflicting issue is named only to somebody who can see its team', async () => {
    const db = getDb();
    const f = await createWorkspaceFixture(db.orm);
    const t = await freshTeam(db, f, 'VIS');
    // OPS is private: the owner and the member are in it, the admin is not.
    const ownerInOps = await actorOf(db, f, 'owner');
    await ok(
      createIssue(db.orm, ownerInOps, {
        teamId: f.teams.ops.id,
        title: 'Secret',
        externalRef: { source: 'tracker', id: 'HIDDEN' },
      }),
    );

    const admin = await actorOf(db, f, 'admin');
    const error = await refused(
      createIssue(db.orm, admin, {
        teamId: t.team.id,
        title: 'Probe',
        externalRef: { source: 'tracker', id: 'HIDDEN' },
      }),
    );

    expect(error.code).toBe('external_ref_exists');
    expect(error.status).toBe(409);
    expect(error.details).toBeUndefined();
  });

  it('the same external id in another workspace or another source is free', async () => {
    const db = getDb();
    const a = await createWorkspaceFixture(db.orm);
    const b = await createWorkspaceFixture(db.orm);
    const ta = await freshTeam(db, a, 'FRE');
    const tb = await freshTeam(db, b, 'FRE');

    await ok(
      createIssue(db.orm, await actorOf(db, a, 'member'), {
        teamId: ta.team.id,
        title: 'A',
        externalRef: { source: 'tracker', id: 'X' },
      }),
    );
    await ok(
      createIssue(db.orm, await actorOf(db, b, 'member'), {
        teamId: tb.team.id,
        title: 'B',
        externalRef: { source: 'tracker', id: 'X' },
      }),
    );
    await ok(
      createIssue(db.orm, await actorOf(db, a, 'member'), {
        teamId: ta.team.id,
        title: 'C',
        externalRef: { source: 'other', id: 'X' },
      }),
    );
  });

  it('foreign workspace ids are rejected, field by field', async () => {
    const db = getDb();
    const f = await createWorkspaceFixture(db.orm);
    const other = await createWorkspaceFixture(db.orm);
    const t = await freshTeam(db, f, 'FOR');
    const foreignLabel = await newLabel(db, other, 'Elsewhere');
    const foreignIssue = other.issues.eng[0];
    if (!foreignIssue) throw new Error('no foreign issue');
    const actor = await actorOf(db, f, 'member');

    const cases: [string, Partial<IssueCreateInput>][] = [
      ['stateId', { stateId: other.states.eng.backlog.id }],
      ['assigneeId', { assigneeId: other.members.member.id }],
      ['labelIds', { labelIds: [foreignLabel.id] }],
      ['parentId', { parentId: foreignIssue.id }],
      ['subscriberIds', { subscriberIds: [other.members.member.id] }],
    ];
    for (const [field, patch] of cases) {
      const error = await refused(
        createIssue(db.orm, actor, { teamId: t.team.id, title: 'Nope', ...patch }),
      );
      expect(error, field).toMatchObject({
        code: 'invalid_reference',
        status: 422,
        details: { field },
      });
    }
    expect(await issuesOf(db, t.team.id)).toEqual([]);
    expect(await counterOf(db, t.team.id)).toBe(0);

    // The team itself is another workspace's: not found, like an id that does not exist.
    const error = await refused(
      createIssue(db.orm, actor, { teamId: other.teams.eng.id, title: 'Nope' }),
    );
    expect(error).toMatchObject({ code: 'not_found', status: 404 });
  });

  it('references that exist but do not fit are rejected with the field name', async () => {
    const db = getDb();
    const f = await createWorkspaceFixture(db.orm);
    // The guest is not in this team: a team they cannot see.
    const t = await freshTeam(db, f, 'FIT', { without: ['guest'] });
    const otherTeamLabel = await newLabel(db, f, 'Ops only', { teamId: f.teams.ops.id });
    const archivedLabel = await newLabel(db, f, 'Retired', { archivedAt: new Date() });
    const group = await newLabel(db, f, 'Area', { isGroup: true });
    await db.orm
      .update(member)
      .set({ deactivatedAt: new Date() })
      .where(eq(member.id, f.members.outsider.id));
    const [archivedParent] = await db.orm
      .update(issue)
      .set({ archivedAt: new Date() })
      .where(eq(issue.id, f.issues.eng[1]?.id ?? ''))
      .returning();
    const opsIssue = f.issues.ops[0];
    if (!archivedParent || !opsIssue) throw new Error('fixture issues missing');
    // The admin is not in OPS (private), so OPS-1 is invisible to them.
    const actor = await actorOf(db, f, 'admin');

    const cases: [string, Partial<IssueCreateInput>][] = [
      ['stateId', { stateId: f.states.ops.backlog.id }],
      ['assigneeId', { assigneeId: f.members.outsider.id }],
      ['assigneeId', { assigneeId: f.members.guest.id }],
      ['labelIds', { labelIds: [otherTeamLabel.id] }],
      ['labelIds', { labelIds: [archivedLabel.id] }],
      ['labelIds', { labelIds: [group.id] }],
      ['parentId', { parentId: archivedParent.id }],
      ['parentId', { parentId: opsIssue.id }],
      ['subscriberIds', { subscriberIds: [f.members.outsider.id] }],
      ['subscriberIds', { subscriberIds: [f.members.guest.id] }],
    ];
    for (const [field, patch] of cases) {
      const error = await refused(
        createIssue(db.orm, actor, { teamId: t.team.id, title: 'Nope', ...patch }),
      );
      expect(error, `${field} ${JSON.stringify(patch)}`).toMatchObject({
        code: 'invalid_reference',
        status: 422,
        details: { field },
      });
    }
    // An invisible parent says nothing more than "invalid": no title, no number.
    const hidden = await refused(
      createIssue(db.orm, actor, { teamId: t.team.id, title: 'Nope', parentId: opsIssue.id }),
    );
    expect(JSON.stringify(hidden)).not.toContain(opsIssue.title);
    expect(await issuesOf(db, t.team.id)).toEqual([]);
  });

  it('a guest creates only in the teams they belong to; a private team of others is 404', async () => {
    const db = getDb();
    const f = await createWorkspaceFixture(db.orm);
    const guest = await actorOf(db, f, 'guest');
    const admin = await actorOf(db, f, 'admin');

    expect(
      await refused(createIssue(db.orm, guest, { teamId: f.teams.ops.id, title: 'No' })),
    ).toMatchObject({ code: 'not_found', status: 404 });
    expect(
      await refused(createIssue(db.orm, admin, { teamId: f.teams.ops.id, title: 'No' })),
    ).toMatchObject({ code: 'not_found', status: 404 });
    const created = await ok(createIssue(db.orm, guest, { teamId: f.teams.eng.id, title: 'Mine' }));
    expect(created.body.issue.creatorId).toBe(f.members.guest.id);
    // The guest cannot see a public team they are not in.
    const t = await freshTeam(db, f, 'GST', { without: ['guest'] });
    expect(
      await refused(createIssue(db.orm, guest, { teamId: t.team.id, title: 'No' })),
    ).toMatchObject({ code: 'not_found', status: 404 });
  });

  it('a member who lost the team before the write is refused (the actor is read again under the lock)', async () => {
    const db = getDb();
    const f = await createWorkspaceFixture(db.orm);
    const t = await freshTeam(db, f, 'STL');
    const stale = await actorOf(db, f, 'guest');
    await db.orm
      .delete(teamMember)
      .where(and(eq(teamMember.teamId, t.team.id), eq(teamMember.memberId, f.members.guest.id)));

    const error = await refused(createIssue(db.orm, stale, { teamId: t.team.id, title: 'Late' }));

    expect(error).toMatchObject({ code: 'not_found', status: 404 });
  });

  it('the default state is the first backlog state, else the first unstarted one', async () => {
    const db = getDb();
    const f = await createWorkspaceFixture(db.orm);
    const normal = await freshTeam(db, f, 'DEF');
    const noBacklog = await freshTeam(db, f, 'NOB', { withoutBacklog: true });
    const actor = await actorOf(db, f, 'member');

    const a = await ok(createIssue(db.orm, actor, { teamId: normal.team.id, title: 'A' }));
    const b = await ok(createIssue(db.orm, actor, { teamId: noBacklog.team.id, title: 'B' }));

    expect(a.body.issue.stateId).toBe(normal.stateId('backlog'));
    expect(b.body.issue.stateId).toBe(noBacklog.stateId('unstarted'));
    expect(a.body.issue.startedAt).toBeNull();
  });

  it('a new issue goes to the top of its state; an explicit sort order is kept', async () => {
    const db = getDb();
    const f = await createWorkspaceFixture(db.orm);
    const t = await freshTeam(db, f, 'SRT');
    const actor = await actorOf(db, f, 'member');

    const first = await ok(createIssue(db.orm, actor, { teamId: t.team.id, title: '1' }));
    const second = await ok(createIssue(db.orm, actor, { teamId: t.team.id, title: '2' }));
    const third = await ok(
      createIssue(db.orm, actor, { teamId: t.team.id, title: '3', sortOrder: 100 }),
    );
    const other = await ok(
      createIssue(db.orm, actor, {
        teamId: t.team.id,
        title: '4',
        stateId: t.stateId('unstarted'),
      }),
    );

    expect(first.body.issue.sortOrder).toBe(0);
    expect(second.body.issue.sortOrder).toBe(-1);
    expect(third.body.issue.sortOrder).toBe(100);
    expect(other.body.issue.sortOrder).toBe(0);
  });

  it('two labels of one group on a new issue keep the last one', async () => {
    const db = getDb();
    const f = await createWorkspaceFixture(db.orm);
    const t = await freshTeam(db, f, 'GRP');
    const group = await newLabel(db, f, 'Area', { isGroup: true });
    const web = await newLabel(db, f, 'Web', { parentId: group.id });
    const api = await newLabel(db, f, 'API', { parentId: group.id });
    const plain = await newLabel(db, f, 'Plain');
    const actor = await actorOf(db, f, 'member');

    const { body } = await ok(
      createIssue(db.orm, actor, {
        teamId: t.team.id,
        title: 'G',
        labelIds: [web.id, plain.id, api.id, plain.id],
      }),
    );

    expect([...body.issue.labelIds].sort()).toEqual([plain.id, api.id].sort());
  });

  it('a rolled-back create leaves no row behind', async () => {
    const db = getDb();
    const f = await createWorkspaceFixture(db.orm);
    const t = await freshTeam(db, f, 'RBK');
    const actor = await actorOf(db, f, 'member');
    // Same subscriber twice is fine (deduplicated); an unknown label fails after the issue row is built.
    const error = await refused(
      createIssue(db.orm, actor, {
        teamId: t.team.id,
        title: 'Half',
        subscriberIds: [f.members.admin.id, f.members.admin.id],
        labelIds: ['99999999-9999-4999-8999-999999999999'],
      }),
    );

    expect(error.code).toBe('invalid_reference');
    expect(await issuesOf(db, t.team.id)).toEqual([]);
    expect(
      await db.orm
        .select()
        .from(issueSubscriber)
        .where(eq(issueSubscriber.workspaceId, f.workspaceId)),
    ).toEqual([]);
    expect(await db.orm.select().from(event).where(eq(event.workspaceId, f.workspaceId))).toEqual(
      [],
    );
    expect(await counterOf(db, t.team.id)).toBe(0);
  });
});
