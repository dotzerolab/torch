import type { Brand } from '@torch/shared/brand';
import { issue, member } from '@torch/shared/db/schema';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.ts';
import type { Db } from '../db.ts';
import { loadClientActor } from '../permissions/load-actor.ts';
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
  withTempDatabase,
} from '../test/fixtures.ts';
import {
  headerActorResolver,
  TEST_APP_CONFIG,
  TEST_MEMBER_HEADER,
  TEST_ORIGIN,
} from '../test/header-actor-resolver.ts';
import { updateIssue } from './update-issue.ts';

const databaseUrl = process.env.DATABASE_URL;

// Integration: needs the dev compose Postgres (see db.test.ts). Skipped, loudly, when DATABASE_URL is not set.
if (!databaseUrl) {
  console.warn(
    '[update-issue.test] SKIPPED the issue mutation tests: DATABASE_URL is not set. ' +
      'Start `docker compose -f docker-compose.dev.yml up -d --wait postgres` and set DATABASE_URL (see .env.example).',
  );
}

const brand: Brand = {
  productName: 'Acme Tasks',
  logoLight: '/acme/logo-light.svg',
  logoDark: '/acme/logo-dark.svg',
  favicon: '/acme/favicon.svg',
  accentColor: '#3366ff',
  emailSenderName: 'Acme Tasks',
  emailSenderAddress: 'no-reply@acme.example',
};

const UNKNOWN_UUID = '99999999-9999-4999-8999-999999999999';

const buildApp = (db: Db) =>
  createApp({ brand, db, auth: headerActorResolver(db.orm), config: TEST_APP_CONFIG });

type Body = Record<string, unknown> | string;
function patch(
  app: ReturnType<typeof createApp>,
  workspaceId: string,
  issueId: string,
  body: Body,
  memberId?: string,
) {
  return app.fetch(
    new Request(`http://localhost/api/w/${workspaceId}/issues/${issueId}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        origin: TEST_ORIGIN,
        ...(memberId ? { [TEST_MEMBER_HEADER]: memberId } : {}),
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}

async function row(db: Db, issueId: string) {
  const [found] = await db.orm.select().from(issue).where(eq(issue.id, issueId));
  if (!found) throw new Error('issue vanished');
  return found;
}

const actorOf = (db: Db, f: WorkspaceFixture, who: keyof WorkspaceFixture['members']) =>
  loadClientActor(db.orm, f.workspaceId, f.members[who].id, 'web').then((actor) => {
    if (!actor) throw new Error(`no actor for ${who}`);
    return actor;
  });

describe.skipIf(!databaseUrl)('PATCH /api/w/:workspaceId/issues/:issueId', () => {
  it('member updates a title: 200, positive integer txid, other fields unchanged, updated_at advanced', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const target = f.issues.eng[0];
      if (!target) throw new Error('fixture has no issue');
      const before = await row(db, target.id);

      const res = await patch(
        buildApp(db),
        f.workspaceId,
        target.id,
        { title: '  New title ' },
        f.members.member.id,
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { txid: number };
      expect(Number.isInteger(body.txid) && body.txid > 0).toBe(true);
      const after = await row(db, target.id);
      expect(after.title).toBe('New title');
      expect({ ...after, title: before.title, updatedAt: before.updatedAt }).toEqual(before);
      expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
    });
  });

  it('txid equals the xmin of the written row', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const target = f.issues.eng[0];
      if (!target) throw new Error('fixture has no issue');

      const res = await patch(
        buildApp(db),
        f.workspaceId,
        target.id,
        { priority: 2 },
        f.members.member.id,
      );
      const { txid } = (await res.json()) as { txid: number };

      const { rows } = await db.pool.query<{ xmin: string }>(
        'select xmin::text as xmin from issue where id = $1',
        [target.id],
      );
      expect(String(txid)).toBe(rows[0]?.xmin);
    });
  });

  it('updates state, priority and assignee, and un-assigns with null', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const target = f.issues.ops[0];
      if (!target) throw new Error('fixture has no issue');
      const app = buildApp(db);

      const res = await patch(
        app,
        f.workspaceId,
        target.id,
        { stateId: f.states.ops.started.id, priority: 1, assigneeId: f.members.owner.id },
        f.members.member.id,
      );

      expect(res.status).toBe(200);
      const changed = await row(db, target.id);
      expect(changed.stateId).toBe(f.states.ops.started.id);
      expect(changed.priority).toBe(1);
      expect(changed.assigneeId).toBe(f.members.owner.id);

      const cleared = await patch(
        app,
        f.workspaceId,
        target.id,
        { assigneeId: null },
        f.members.member.id,
      );
      expect(cleared.status).toBe(200);
      expect((await row(db, target.id)).assigneeId).toBeNull();
    });
  });

  it('guest or outsider on an OPS issue -> 404; an actor of another workspace with this issue id -> 404', async () => {
    await withTempDatabase(async (db) => {
      const a = await createWorkspaceFixture(db.orm);
      const b = await createWorkspaceFixture(db.orm);
      const opsIssue = a.issues.ops[0];
      if (!opsIssue) throw new Error('fixture has no issue');
      const app = buildApp(db);
      const before = await row(db, opsIssue.id);

      const attempts: [string, Response][] = [
        ['guest', await patch(app, a.workspaceId, opsIssue.id, { title: 'x' }, a.members.guest.id)],
        [
          'outsider',
          await patch(app, a.workspaceId, opsIssue.id, { title: 'x' }, a.members.outsider.id),
        ],
        // The caller's own workspace in the URL, the other workspace's issue id.
        [
          'other workspace',
          await patch(app, b.workspaceId, opsIssue.id, { title: 'x' }, b.members.owner.id),
        ],
        [
          'unknown id',
          await patch(app, a.workspaceId, UNKNOWN_UUID, { title: 'x' }, a.members.owner.id),
        ],
        [
          'malformed id',
          await patch(app, a.workspaceId, 'not-a-uuid', { title: 'x' }, a.members.owner.id),
        ],
      ];

      const bodies = new Set<string>();
      for (const [who, res] of attempts) {
        expect(res.status, who).toBe(404);
        bodies.add(JSON.stringify(await res.json()));
      }
      // Every refusal looks the same: no signal that the issue exists.
      expect(bodies.size).toBe(1);
      expect(JSON.parse([...bodies][0] ?? '{}').error).toBe('not_found');
      expect(await row(db, opsIssue.id)).toEqual(before);
    });
  });

  it('state of another team -> 400 invalid_state', async () => {
    await withTempDatabase(async (db) => {
      const a = await createWorkspaceFixture(db.orm);
      const b = await createWorkspaceFixture(db.orm);
      const target = a.issues.eng[0];
      if (!target) throw new Error('fixture has no issue');
      const app = buildApp(db);
      const before = await row(db, target.id);

      for (const stateId of [a.states.ops.started.id, b.states.eng.started.id, UNKNOWN_UUID]) {
        const res = await patch(app, a.workspaceId, target.id, { stateId }, a.members.owner.id);
        expect(res.status, stateId).toBe(400);
        expect(await res.json()).toMatchObject({ error: 'invalid_state' });
      }
      expect(await row(db, target.id)).toEqual(before);
    });
  });

  it('outsider or deactivated member as assignee of an OPS issue -> 400 invalid_assignee', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const other = await createWorkspaceFixture(db.orm);
      const target = f.issues.ops[0];
      if (!target) throw new Error('fixture has no issue');
      await db.orm
        .update(member)
        .set({ deactivatedAt: new Date() })
        .where(eq(member.id, f.members.member.id));
      const app = buildApp(db);
      const before = await row(db, target.id);

      const invalid = {
        'member outside OPS': f.members.outsider.id,
        'guest outside OPS': f.members.guest.id,
        'deactivated member of OPS': f.members.member.id,
        'member of another workspace': other.members.owner.id,
        'unknown id': UNKNOWN_UUID,
      };
      for (const [label, assigneeId] of Object.entries(invalid)) {
        const res = await patch(app, f.workspaceId, target.id, { assigneeId }, f.members.owner.id);
        expect(res.status, label).toBe(400);
        expect(await res.json(), label).toMatchObject({ error: 'invalid_assignee' });
      }
      expect(await row(db, target.id)).toEqual(before);

      // A guest of the public ENG team is a valid assignee of an ENG issue.
      const engIssue = f.issues.eng[0];
      if (!engIssue) throw new Error('fixture has no issue');
      const ok = await patch(
        app,
        f.workspaceId,
        engIssue.id,
        { assigneeId: f.members.guest.id },
        f.members.owner.id,
      );
      expect(ok.status).toBe(200);
    });
  });

  it('unknown field or empty body -> 400 invalid_input', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const target = f.issues.eng[0];
      if (!target) throw new Error('fixture has no issue');
      const app = buildApp(db);
      const before = await row(db, target.id);

      const bodies: Body[] = [
        { number: 99 },
        { title: 'ok', creatorId: f.members.owner.id },
        { workspaceId: f.workspaceId },
        { teamId: f.teams.ops.id },
        {},
        { title: '' },
        { priority: 9 },
        { stateId: 'nope' },
        '{not json',
        '[]',
        'null',
        '',
      ];
      for (const body of bodies) {
        const res = await patch(app, f.workspaceId, target.id, body, f.members.member.id);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(await res.json(), JSON.stringify(body)).toMatchObject({ error: 'invalid_input' });
      }
      expect(await row(db, target.id)).toEqual(before);
    });
  });

  it('a body over 512 KB is refused with 413 before anything is read', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const target = f.issues.eng[0];
      if (!target) throw new Error('fixture has no issue');
      const before = await row(db, target.id);

      const res = await patch(
        buildApp(db),
        f.workspaceId,
        target.id,
        { title: 'x'.repeat(600_000) },
        f.members.member.id,
      );

      expect(res.status).toBe(413);
      expect(await res.json()).toMatchObject({ error: 'invalid_input' });
      expect(await row(db, target.id)).toEqual(before);
    });
  });

  it('an upper-case workspace or issue id -> 404, nothing written', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const target = f.issues.eng[0];
      if (!target) throw new Error('fixture has no issue');
      const before = await row(db, target.id);
      const app = buildApp(db);
      const who = f.members.member.id;

      const upperWorkspace = await patch(
        app,
        f.workspaceId.toUpperCase(),
        target.id,
        { title: 'x' },
        who,
      );
      const upperIssue = await patch(
        app,
        f.workspaceId,
        target.id.toUpperCase(),
        { title: 'x' },
        who,
      );

      expect(upperWorkspace.status).toBe(404);
      expect(upperIssue.status).toBe(404);
      expect(await row(db, target.id)).toEqual(before);
    });
  });

  it('no actor -> 401', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const target = f.issues.eng[0];
      if (!target) throw new Error('fixture has no issue');
      const before = await row(db, target.id);

      const res = await patch(buildApp(db), f.workspaceId, target.id, { title: 'x' });

      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: 'unauthenticated' });
      expect(await row(db, target.id)).toEqual(before);
    });
  });

  it('answers 401 for a member who is not in the workspace of the URL, like for no actor', async () => {
    await withTempDatabase(async (db) => {
      const a = await createWorkspaceFixture(db.orm);
      const b = await createWorkspaceFixture(db.orm);
      const target = a.issues.eng[0];
      if (!target) throw new Error('fixture has no issue');

      const res = await patch(
        buildApp(db),
        a.workspaceId,
        target.id,
        { title: 'x' },
        b.members.owner.id,
      );

      expect(res.status).toBe(401);
    });
  });

  it('mounts only when db and auth are present', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const target = f.issues.eng[0];
      if (!target) throw new Error('fixture has no issue');
      // Control: with auth the same request works.
      expect(
        (await patch(buildApp(db), f.workspaceId, target.id, { priority: 3 }, f.members.owner.id))
          .status,
      ).toBe(200);

      const withoutAuth = createApp({ brand, db });

      expect(
        (await patch(withoutAuth, f.workspaceId, target.id, { priority: 4 }, f.members.owner.id))
          .status,
      ).toBe(404);
      expect((await row(db, target.id)).priority).toBe(3);
    });
  });

  it('two concurrent updates of different fields both land', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const target = f.issues.eng[0];
      if (!target) throw new Error('fixture has no issue');
      const app = buildApp(db);
      const who = f.members.member.id;

      for (let round = 0; round < 5; round++) {
        const results = await Promise.all([
          patch(app, f.workspaceId, target.id, { title: `title ${round}` }, who),
          patch(app, f.workspaceId, target.id, { priority: (round % 4) + 1 }, who),
          patch(app, f.workspaceId, target.id, { stateId: f.states.eng.started.id }, who),
          patch(app, f.workspaceId, target.id, { assigneeId: f.members.admin.id }, who),
        ]);

        expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
        const txids = await Promise.all(
          results.map(async (r) => ((await r.json()) as { txid: number }).txid),
        );
        expect(new Set(txids).size).toBe(4);
        const after = await row(db, target.id);
        expect(after.title).toBe(`title ${round}`);
        expect(after.priority).toBe((round % 4) + 1);
        expect(after.stateId).toBe(f.states.eng.started.id);
        expect(after.assigneeId).toBe(f.members.admin.id);
      }
    });
  });

  it('a write that waited for the row lock never gets an older updated_at than the write it waited for', async () => {
    await withTempDatabase(async (db) => {
      const f = await createWorkspaceFixture(db.orm);
      const target = f.issues.eng[0];
      if (!target) throw new Error('fixture has no issue');
      const actor = await actorOf(db, f, 'member');
      const holder = await db.pool.connect();
      try {
        await holder.query('begin');
        await holder.query('select id from issue where id = $1 for update', [target.id]);
        const waiting = updateIssue(db.orm, actor, target.id, { title: 'second' });
        await new Promise((resolve) => setTimeout(resolve, 300));
        const first = await holder.query<{ updated_at: Date }>(
          "update issue set title = 'first', updated_at = clock_timestamp() where id = $1 returning updated_at",
          [target.id],
        );
        await holder.query('commit');

        const result = await waiting;

        expect(result.ok).toBe(true);
        const after = await row(db, target.id);
        expect(after.title).toBe('second');
        const firstAt = first.rows[0]?.updated_at;
        expect(firstAt).toBeDefined();
        expect(after.updatedAt.getTime()).toBeGreaterThanOrEqual((firstAt as Date).getTime());
      } finally {
        holder.release();
      }
    });
  });
});

describe.skipIf(!databaseUrl)('updateIssue (the function REST and MCP reuse)', () => {
  it('returns the txid, or a typed refusal with the HTTP status', async () => {
    await withTempDatabase(async (db) => {
      const a = await createWorkspaceFixture(db.orm);
      const b = await createWorkspaceFixture(db.orm);
      const target = a.issues.eng[0];
      if (!target) throw new Error('fixture has no issue');

      const ok = await updateIssue(db.orm, await actorOf(db, a, 'member'), target.id, {
        priority: 3,
      });
      const foreign = await updateIssue(db.orm, await actorOf(db, b, 'owner'), target.id, {
        priority: 4,
      });
      const malformed = await updateIssue(db.orm, await actorOf(db, a, 'member'), 'not-a-uuid', {
        priority: 4,
      });
      const badState = await updateIssue(db.orm, await actorOf(db, a, 'member'), target.id, {
        stateId: a.states.ops.started.id,
      });

      // Another caller (REST, MCP) may skip the schema: the function still refuses protected columns.
      const smuggled = await updateIssue(db.orm, await actorOf(db, a, 'member'), target.id, {
        title: 'ok',
        number: 99,
      } as never);
      const emptied = await updateIssue(db.orm, await actorOf(db, a, 'member'), target.id, {});

      expect(smuggled).toEqual({ ok: false, code: 'invalid_input', status: 400 });
      expect(emptied).toEqual({ ok: false, code: 'invalid_input', status: 400 });
      expect(ok).toEqual({ ok: true, txid: expect.any(Number) });
      expect(foreign).toEqual({ ok: false, code: 'not_found', status: 404 });
      expect(malformed).toEqual({ ok: false, code: 'not_found', status: 404 });
      expect(badState).toEqual({ ok: false, code: 'invalid_state', status: 400 });
      expect((await row(db, target.id)).priority).toBe(3);
    });
  });
});
