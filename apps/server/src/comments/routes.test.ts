import { comment, event } from '@torch/shared/db/schema';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { openSession } from '../test/admin-helpers.ts';
import { createAuthTestApp } from '../test/auth-app.ts';
import { createWorkspaceFixture } from '../test/fixtures.ts';
import { useSharedDatabase } from '../test/shared-database.ts';

const databaseUrl = process.env.DATABASE_URL;

// Integration: needs the dev compose Postgres (see db.test.ts). Skipped, loudly, when DATABASE_URL is not set.
if (!databaseUrl) {
  console.warn(
    '[comments/routes.test] SKIPPED the comment route tests: DATABASE_URL is not set. ' +
      'Start `docker compose -f docker-compose.dev.yml up -d --wait postgres` and set DATABASE_URL (see .env.example).',
  );
}

type CommentBody = { id: string; body: string; parentId: string | null; deleted: boolean };

describe.skipIf(!databaseUrl)('comment routes', () => {
  const getDb = useSharedDatabase();

  async function setup() {
    const db = getDb();
    const f = await createWorkspaceFixture(db.orm);
    const t = createAuthTestApp(db);
    const first = f.issues.eng[0];
    if (!first) throw new Error('fixture has no ENG issue');
    const cookie = async (who: 'owner' | 'admin' | 'member' | 'guest') =>
      (await openSession(db.orm, f.workspaceId, f.members[who].id)).cookie;
    const base = `/api/w/${f.workspaceId}`;
    return {
      db,
      f,
      t,
      issueId: first.id,
      member: await cookie('member'),
      admin: await cookie('admin'),
      guest: await cookie('guest'),
      list: `${base}/issues/${first.id}/comments`,
      one: (id: string) => `${base}/comments/${id}`,
    };
  }

  async function add(s: Awaited<ReturnType<typeof setup>>, body: string, parentId?: string) {
    const res = await s.t.post(
      s.list,
      { body, ...(parentId ? { parentId } : {}) },
      { cookie: s.member },
    );
    expect(res.status).toBe(201);
    return ((await res.json()) as { comment: CommentBody }).comment;
  }

  it('POST creates a comment: 201 with the comment and a transaction id, never cached', async () => {
    const s = await setup();

    const res = await s.t.post(s.list, { body: 'Over HTTP' }, { cookie: s.member });

    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('idempotent-replayed')).toBeNull();
    const json = (await res.json()) as { comment: CommentBody; txid: number };
    expect(json.comment).toMatchObject({ body: 'Over HTTP', parentId: null, deleted: false });
    expect(Number.isInteger(json.txid)).toBe(true);
  });

  it('GET lists the comments of the issue, oldest first, as { comments }', async () => {
    const s = await setup();
    const one = await add(s, 'one');
    const two = await add(s, 'two', one.id);

    const res = await s.t.get(s.list, { cookie: s.guest });

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const json = (await res.json()) as { comments: CommentBody[] };
    expect(json.comments.map((row) => row.id)).toEqual([one.id, two.id]);
  });

  it('Idempotency-Key: the second call replays the answer and says so', async () => {
    const s = await setup();
    const headers = { 'idempotency-key': 'queue-0001' };

    const first = await s.t.post(s.list, { body: 'Once' }, { cookie: s.member, headers });
    const second = await s.t.post(s.list, { body: 'Once' }, { cookie: s.member, headers });
    const other = await s.t.post(s.list, { body: 'Twice' }, { cookie: s.member, headers });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers.get('idempotent-replayed')).toBe('true');
    expect(((await second.json()) as { comment: CommentBody }).comment.id).toBe(
      ((await first.json()) as { comment: CommentBody }).comment.id,
    );
    expect(other.status).toBe(422);
    expect(await other.json()).toMatchObject({ error: 'idempotency_key_reused' });
    const rows = await s.db.orm.select().from(comment).where(eq(comment.issueId, s.issueId));
    expect(rows).toHaveLength(1);
    const events = await s.db.orm
      .select()
      .from(event)
      .where(eq(event.subjectId, rows[0]?.id ?? ''));
    expect(events).toHaveLength(1);
  });

  it.each(['', 'x'.repeat(129)])(
    'an Idempotency-Key of %s characters is 400 invalid_input',
    async (key) => {
      const s = await setup();

      const res = await s.t.post(
        s.list,
        { body: 'Keyed' },
        { cookie: s.member, headers: { 'idempotency-key': key } },
      );

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'invalid_input' });
    },
  );

  it('answers 400 for 20,001 characters, an empty body, an unknown key and a body that is not JSON', async () => {
    const s = await setup();
    const post = (body: unknown) => s.t.post(s.list, body, { cookie: s.member });

    for (const res of [
      await post({ body: 'x'.repeat(20_001) }),
      await post({ body: '  ' }),
      await post({ body: 'ok', authorId: s.f.members.owner.id }),
      await post('{not json'),
    ]) {
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'invalid_input' });
    }
  });

  it('answers 413 above 128 KiB and takes 100 KiB to the validation', async () => {
    const s = await setup();

    const huge = await s.t.post(s.list, { body: 'x'.repeat(129 * 1024) }, { cookie: s.member });
    const large = await s.t.post(s.list, { body: 'x'.repeat(100 * 1024) }, { cookie: s.member });

    expect(huge.status).toBe(413);
    expect(large.status).toBe(400);
  });

  it('answers 401 without a session and 404 for an issue the caller cannot see', async () => {
    const s = await setup();
    const other = await createWorkspaceFixture(s.db.orm);
    const foreign = other.issues.eng[0];
    if (!foreign) throw new Error('fixture has no ENG issue');

    const anonymous = await s.t.post(s.list, { body: 'who am I' });
    const across = await s.t.get(`/api/w/${s.f.workspaceId}/issues/${foreign.id}/comments`, {
      cookie: s.member,
    });

    expect(anonymous.status).toBe(401);
    expect(across.status).toBe(404);
  });

  it('PATCH edits, GET history lists the earlier version, DELETE leaves a tombstone', async () => {
    const s = await setup();
    const created = await add(s, 'first version');

    const edit = await s.t.request(
      'PATCH',
      s.one(created.id),
      { body: 'second version' },
      { cookie: s.member },
    );
    const history = await s.t.get(`${s.one(created.id)}/history`, { cookie: s.guest });
    const forbidden = await s.t.request(
      'PATCH',
      s.one(created.id),
      { body: 'hijack' },
      { cookie: s.admin },
    );
    const removed = await s.t.request('DELETE', s.one(created.id), undefined, { cookie: s.admin });
    const after = await s.t.get(s.list, { cookie: s.member });

    expect(edit.status).toBe(200);
    expect(Number.isInteger(((await edit.json()) as { txid: number }).txid)).toBe(true);
    expect(history.status).toBe(200);
    expect(
      ((await history.json()) as { edits: { body: string }[] }).edits.map((e) => e.body),
    ).toEqual(['first version']);
    expect(forbidden.status).toBe(403);
    expect(removed.status).toBe(200);
    expect(((await after.json()) as { comments: CommentBody[] }).comments).toMatchObject([
      { id: created.id, deleted: true, body: '' },
    ]);
  });

  it('resolve and unresolve answer { txid }; resolving a reply is 422', async () => {
    const s = await setup();
    const root = await add(s, 'question');
    const reply = await add(s, 'answer', root.id);

    const resolved = await s.t.post(`${s.one(root.id)}/resolve`, undefined, { cookie: s.guest });
    const reopened = await s.t.post(`${s.one(root.id)}/unresolve`, undefined, { cookie: s.guest });
    const refused = await s.t.post(`${s.one(reply.id)}/resolve`, undefined, { cookie: s.guest });

    expect(resolved.status).toBe(200);
    expect(await resolved.json()).toEqual({ txid: expect.any(Number) });
    expect(reopened.status).toBe(200);
    expect(refused.status).toBe(422);
  });

  it('reactions: PUT and DELETE take the emoji URL-encoded; an unknown emoji is 400', async () => {
    const s = await setup();
    const created = await add(s, 'react to me');
    const heart = encodeURIComponent('❤️');
    const path = (emoji: string) => `${s.one(created.id)}/reactions/${emoji}`;

    const on = await s.t.request('PUT', path(heart), undefined, { cookie: s.guest });
    const mid = await s.t.get(s.list, { cookie: s.member });
    const off = await s.t.request('DELETE', path(heart), undefined, { cookie: s.guest });
    const end = await s.t.get(s.list, { cookie: s.member });
    const unknown = await s.t.request('PUT', path(encodeURIComponent('🔥')), undefined, {
      cookie: s.guest,
    });

    expect(on.status).toBe(200);
    expect(
      ((await mid.json()) as { comments: { reactions: Record<string, string[]> }[] }).comments[0]
        ?.reactions,
    ).toEqual({
      '❤️': [s.f.members.guest.id],
    });
    expect(off.status).toBe(200);
    expect(
      ((await end.json()) as { comments: { reactions: object }[] }).comments[0]?.reactions,
    ).toEqual({});
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ error: 'invalid_input' });
  });

  it('answers 404 for a malformed comment id and an unknown one', async () => {
    const s = await setup();

    const malformed = await s.t.request(
      'PATCH',
      s.one('nope'),
      { body: 'x' },
      { cookie: s.member },
    );
    const unknown = await s.t.get(`${s.one('00000000-0000-4000-8000-00000000dead')}/history`, {
      cookie: s.member,
    });

    expect(malformed.status).toBe(404);
    expect(unknown.status).toBe(404);
  });
});
