import { document } from '@torch/shared/db/schema';
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
    '[documents/routes.test] SKIPPED the document route tests: DATABASE_URL is not set. ' +
      'Start `docker compose -f docker-compose.dev.yml up -d --wait postgres` and set DATABASE_URL (see .env.example).',
  );
}

type DocumentBody = { id: string; title: string; body?: string; archivedAt: string | null };

describe.skipIf(!databaseUrl)('document routes', () => {
  const getDb = useSharedDatabase();

  async function setup() {
    const db = getDb();
    const f = await createWorkspaceFixture(db.orm);
    const t = createAuthTestApp(db);
    const cookie = async (who: 'owner' | 'admin' | 'member' | 'guest') =>
      (await openSession(db.orm, f.workspaceId, f.members[who].id)).cookie;
    const base = `/api/w/${f.workspaceId}`;
    return {
      db,
      f,
      t,
      member: await cookie('member'),
      guest: await cookie('guest'),
      admin: await cookie('admin'),
      list: `${base}/teams/${f.teams.eng.id}/documents`,
      one: (id: string) => `${base}/documents/${id}`,
    };
  }
  type Setup = Awaited<ReturnType<typeof setup>>;

  async function add(s: Setup, body: object = { title: 'Runbook', body: 'Step one' }) {
    const res = await s.t.post(s.list, body, { cookie: s.member });
    expect(res.status).toBe(201);
    return ((await res.json()) as { document: DocumentBody }).document;
  }

  it('POST creates a document: 201 with the document and a transaction id, never cached', async () => {
    const s = await setup();

    const res = await s.t.post(
      s.list,
      { title: ' Runbook ', body: 'Step one' },
      { cookie: s.member },
    );

    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('idempotent-replayed')).toBeNull();
    const json = (await res.json()) as { document: DocumentBody; txid: number };
    expect(json.document).toMatchObject({ title: 'Runbook', body: 'Step one', archivedAt: null });
    expect(Number.isInteger(json.txid)).toBe(true);
  });

  it('a member who writes more than 60 times in a minute is answered 429 rate_limited; reads and others are not', async () => {
    const s = await setup();
    const doc = await add(s);

    // The create above was the first write; each of these changes nothing and still counts.
    for (let i = 0; i < 59; i++) {
      const res = await s.t.request(
        'PATCH',
        s.one(doc.id),
        { title: 'Runbook' },
        { cookie: s.member },
      );
      expect(res.status).toBe(200);
    }
    const blocked = await s.t.request(
      'PATCH',
      s.one(doc.id),
      { title: 'Runbook' },
      { cookie: s.member },
    );
    const create = await s.t.post(s.list, { title: 'Another' }, { cookie: s.member });
    const archive = await s.t.post(`${s.one(doc.id)}/archive`, undefined, { cookie: s.member });
    const other = await s.t.post(s.list, { title: 'From somebody else' }, { cookie: s.admin });
    const read = await s.t.get(s.one(doc.id), { cookie: s.member });
    s.t.clock.current = new Date(s.t.clock.current.getTime() + 61_000);
    const later = await s.t.request(
      'PATCH',
      s.one(doc.id),
      { title: 'Runbook' },
      { cookie: s.member },
    );

    for (const res of [blocked, create, archive]) {
      expect(res.status).toBe(429);
      expect(await res.json()).toMatchObject({ error: 'rate_limited' });
      expect(Number(res.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    }
    expect(other.status).toBe(201);
    expect(read.status).toBe(200);
    expect(later.status).toBe(200);
  });

  it('Idempotency-Key: the second call replays the answer and says so', async () => {
    const s = await setup();
    const headers = { 'idempotency-key': 'doc-queue-0001' };

    const first = await s.t.post(s.list, { title: 'Once' }, { cookie: s.member, headers });
    const second = await s.t.post(s.list, { title: 'Once' }, { cookie: s.member, headers });
    const other = await s.t.post(s.list, { title: 'Twice' }, { cookie: s.member, headers });
    const rejected = await s.t.post(
      s.list,
      { title: 'x' },
      { cookie: s.member, headers: { 'idempotency-key': '' } },
    );

    expect(second.headers.get('idempotent-replayed')).toBe('true');
    expect(((await second.json()) as { document: DocumentBody }).document.id).toBe(
      ((await first.json()) as { document: DocumentBody }).document.id,
    );
    expect(other.status).toBe(422);
    expect(rejected.status).toBe(400);
    const rows = await s.db.orm
      .select()
      .from(document)
      .where(eq(document.teamId, s.f.teams.eng.id));
    expect(rows).toHaveLength(1);
  });

  it('GET lists the documents of a team without their bodies', async () => {
    const s = await setup();
    const created = await add(s, { title: 'Doc', body: 'a secret body' });

    const res = await s.t.get(s.list, { cookie: s.guest });
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(JSON.parse(text)).toMatchObject({ documents: [{ id: created.id, title: 'Doc' }] });
    expect(text).not.toContain('secret');
  });

  it('GET ?includeArchived=true also lists archived documents', async () => {
    const s = await setup();
    const created = await add(s);
    await s.t.post(`${s.one(created.id)}/archive`, undefined, { cookie: s.member });

    const open = await s.t.get(s.list, { cookie: s.member });
    const all = await s.t.get(`${s.list}?includeArchived=true`, { cookie: s.member });

    expect(((await open.json()) as { documents: unknown[] }).documents).toEqual([]);
    expect(((await all.json()) as { documents: unknown[] }).documents).toHaveLength(1);
  });

  it('GET one returns the body; PATCH changes it and keeps a revision; archive and unarchive answer { txid }', async () => {
    const s = await setup();
    const created = await add(s);
    const id = created.id;

    const edit = await s.t.request('PATCH', s.one(id), { body: 'Step two' }, { cookie: s.admin });
    const read = await s.t.get(s.one(id), { cookie: s.guest });
    const revisions = await s.t.get(`${s.one(id)}/revisions`, { cookie: s.guest });
    const archived = await s.t.post(`${s.one(id)}/archive`, undefined, { cookie: s.member });
    const locked = await s.t.request('PATCH', s.one(id), { body: 'late' }, { cookie: s.member });
    const unarchived = await s.t.post(`${s.one(id)}/unarchive`, undefined, { cookie: s.member });

    expect(edit.status).toBe(200);
    expect(await edit.json()).toEqual({ txid: expect.any(Number) });
    expect(((await read.json()) as { document: DocumentBody }).document.body).toBe('Step two');
    expect(
      ((await revisions.json()) as { revisions: { body: string }[] }).revisions.map((r) => r.body),
    ).toEqual(['Step one']);
    expect(archived.status).toBe(200);
    expect(locked.status).toBe(409);
    expect(await locked.json()).toMatchObject({ error: 'document_archived' });
    expect(unarchived.status).toBe(200);
  });

  it('a guest reads but cannot create, edit or archive: 403', async () => {
    const s = await setup();
    const created = await add(s);

    const create = await s.t.post(s.list, { title: 'x' }, { cookie: s.guest });
    const edit = await s.t.request('PATCH', s.one(created.id), { title: 'x' }, { cookie: s.guest });
    const archive = await s.t.post(`${s.one(created.id)}/archive`, undefined, { cookie: s.guest });

    for (const res of [create, edit, archive]) {
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: 'forbidden' });
    }
  });

  it('answers 400 for 100,001 characters, an empty title, an unknown key and a body that is not JSON', async () => {
    const s = await setup();
    const created = await add(s);

    const answers = [
      await s.t.post(s.list, { title: 'x', body: 'x'.repeat(100_001) }, { cookie: s.member }),
      await s.t.post(s.list, { title: ' ' }, { cookie: s.member }),
      await s.t.post(s.list, { title: 'x', createdBy: s.f.members.owner.id }, { cookie: s.member }),
      await s.t.post(s.list, '{not json', { cookie: s.member }),
      await s.t.request('PATCH', s.one(created.id), {}, { cookie: s.member }),
    ];

    for (const res of answers) {
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'invalid_input' });
    }
  });

  it('takes a body of 100,000 characters and answers 413 above 512 KiB', async () => {
    const s = await setup();

    const large = await s.t.post(
      s.list,
      { title: 'Large', body: 'x'.repeat(100_000) },
      { cookie: s.member },
    );
    const huge = await s.t.post(
      s.list,
      { title: 'Huge', body: 'x'.repeat(513 * 1024) },
      { cookie: s.member },
    );
    const hugePatch = await s.t.request(
      'PATCH',
      s.one('00000000-0000-4000-8000-00000000dead'),
      { body: 'x'.repeat(513 * 1024) },
      { cookie: s.member },
    );

    expect(large.status).toBe(201);
    expect(huge.status).toBe(413);
    expect(hugePatch.status).toBe(413);
  });

  it('answers 401 without a session and 404 for unknown, foreign and malformed ids', async () => {
    const s = await setup();
    const other = await setup();
    const foreign = await add(other);
    const id = '00000000-0000-4000-8000-00000000dead';

    const anonymous = [
      await s.t.get(s.list),
      await s.t.post(s.list, { title: 'x' }),
      await s.t.get(s.one(id)),
      await s.t.request('PATCH', s.one(id), { title: 'x' }),
    ];
    const missing = [
      await s.t.get(s.one(id), { cookie: s.member }),
      await s.t.get(s.one(foreign.id), { cookie: s.member }),
      await s.t.get(s.one('nope'), { cookie: s.member }),
      await s.t.get(`${s.one(foreign.id)}/revisions`, { cookie: s.member }),
      await s.t.get(`/api/w/${s.f.workspaceId}/teams/${other.f.teams.eng.id}/documents`, {
        cookie: s.member,
      }),
    ];

    for (const res of anonymous) expect(res.status).toBe(401);
    for (const res of missing) expect(res.status).toBe(404);
  });
});
