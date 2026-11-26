import { attachment } from '@torch/shared/db/schema';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { openSession } from '../test/admin-helpers.ts';
import { createAuthTestApp } from '../test/auth-app.ts';
import { createWorkspaceFixture } from '../test/fixtures.ts';
import { useSharedDatabase } from '../test/shared-database.ts';
import { createFakeStorage } from './fake-storage.ts';

const databaseUrl = process.env.DATABASE_URL;

// Integration: needs the dev compose Postgres (see db.test.ts). Skipped, loudly, when DATABASE_URL is not set.
if (!databaseUrl) {
  console.warn(
    '[files/routes.test] SKIPPED the attachment route tests: DATABASE_URL is not set. ' +
      'Start `docker compose -f docker-compose.dev.yml up -d --wait postgres` and set DATABASE_URL (see .env.example).',
  );
}

type Started = {
  attachment: { id: string; fileName: string; status: string };
  upload: { url: string; method: string; fields: Record<string, string> };
};

const png = (size: number) => {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
};

describe.skipIf(!databaseUrl)('attachment routes', () => {
  const getDb = useSharedDatabase();

  async function setup(opts: { storage?: boolean } = {}) {
    const db = getDb();
    const f = await createWorkspaceFixture(db.orm);
    const files = opts.storage === false ? undefined : createFakeStorage();
    const t = createAuthTestApp(db, { files });
    const first = f.issues.eng[0];
    if (!first) throw new Error('fixture has no ENG issue');
    const cookie = async (who: 'owner' | 'admin' | 'member' | 'guest') =>
      (await openSession(db.orm, f.workspaceId, f.members[who].id)).cookie;
    const base = `/api/w/${f.workspaceId}`;
    return {
      db,
      f,
      t,
      files,
      issueId: first.id,
      member: await cookie('member'),
      guest: await cookie('guest'),
      admin: await cookie('admin'),
      list: `${base}/issues/${first.id}/attachments`,
      one: (id: string) => `${base}/attachments/${id}`,
    };
  }
  type Setup = Awaited<ReturnType<typeof setup>>;

  async function start(
    s: Setup,
    body: object = { fileName: 'shot.png', contentType: 'image/png', size: 64 },
  ) {
    const res = await s.t.post(s.list, body, { cookie: s.member });
    expect(res.status).toBe(201);
    return (await res.json()) as Started;
  }
  async function readyFile(s: Setup, fileName = 'shot.png') {
    const started = await start(s, { fileName, contentType: 'image/png', size: 64 });
    s.files?.put(started.upload.fields.key ?? '', png(64), 'image/png');
    const done = await s.t.post(`${s.one(started.attachment.id)}/complete`, undefined, {
      cookie: s.member,
    });
    expect(done.status).toBe(200);
    return started.attachment.id;
  }

  it('POST starts an upload: 201 with the pending file and the presigned request, never cached', async () => {
    const s = await setup();

    const res = await s.t.post(
      s.list,
      { fileName: 'shot.png', contentType: 'image/png', size: 64 },
      { cookie: s.member },
    );

    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const json = (await res.json()) as Started;
    expect(json.attachment).toMatchObject({ fileName: 'shot.png', status: 'pending' });
    expect(json.upload).toMatchObject({ method: 'POST' });
    expect(JSON.stringify(json.attachment)).not.toContain('workspaces/');
  });

  it('POST answers 400 for a malformed body, 415 for a type off the list, 413 for a file over the limit', async () => {
    const s = await setup();
    const post = (body: unknown) => s.t.post(s.list, body, { cookie: s.member });

    const malformed = await post('{nope');
    const array = await post([]);
    const noName = await post({ fileName: '', contentType: 'image/png', size: 5 });
    const html = await post({ fileName: 'a.html', contentType: 'text/html', size: 5 });
    const huge = await post({ fileName: 'a.png', contentType: 'image/png', size: 30_000_000 });

    expect(malformed.status).toBe(400);
    expect(array.status).toBe(400);
    expect(noName.status).toBe(400);
    expect(html.status).toBe(415);
    expect(await html.json()).toMatchObject({ error: 'file_type_not_allowed' });
    expect(huge.status).toBe(413);
    expect(await huge.json()).toMatchObject({ error: 'file_too_large' });
  });

  it('POST refuses a body over 16 KiB with 413', async () => {
    const s = await setup();

    const res = await s.t.post(
      s.list,
      { fileName: 'x'.repeat(20 * 1024), contentType: 'image/png', size: 5 },
      { cookie: s.member },
    );

    expect(res.status).toBe(413);
  });

  it('complete publishes the file: { attachment, txid }; GET lists it', async () => {
    const s = await setup();
    const started = await start(s);
    s.files?.put(started.upload.fields.key ?? '', png(64), 'image/png');

    const done = await s.t.post(`${s.one(started.attachment.id)}/complete`, undefined, {
      cookie: s.member,
    });
    const listed = await s.t.get(s.list, { cookie: s.guest });

    expect(done.status).toBe(200);
    const body = (await done.json()) as { attachment: { status: string }; txid: number };
    expect(body.attachment.status).toBe('ready');
    expect(Number.isInteger(body.txid)).toBe(true);
    expect(listed.status).toBe(200);
    expect(
      ((await listed.json()) as { attachments: { id: string }[] }).attachments.map((a) => a.id),
    ).toEqual([started.attachment.id]);
  });

  it('complete answers 422 file_rejected for a file that is not what it said, and 403 for another person', async () => {
    const s = await setup();
    const started = await start(s);
    const other = await s.t.post(`${s.one(started.attachment.id)}/complete`, undefined, {
      cookie: s.admin,
    });
    s.files?.put(
      started.upload.fields.key ?? '',
      new TextEncoder().encode('<html>'.padEnd(64)),
      'image/png',
    );

    const rejected = await s.t.post(`${s.one(started.attachment.id)}/complete`, undefined, {
      cookie: s.member,
    });

    expect(other.status).toBe(403);
    expect(rejected.status).toBe(422);
    expect(await rejected.json()).toMatchObject({ error: 'file_rejected' });
  });

  it('GET file redirects to the signed URL: 302, no-store, no-referrer, the URL only in Location', async () => {
    const s = await setup();
    const id = await readyFile(s);

    const res = await s.t.get(`${s.one(id)}/file`, { cookie: s.guest });

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(s.files?.urlsMinted[0]);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(await res.text()).toBe('');
    expect(new URL(res.headers.get('location') ?? '').searchParams.get('disposition')).toBe(
      'attachment',
    );
  });

  it('GET file?inline=1 is inline for a raster image only', async () => {
    const s = await setup();
    const image = await readyFile(s, 'photo.png');

    const inline = await s.t.get(`${s.one(image)}/file?inline=1`, { cookie: s.member });
    const other = await s.t.get(`${s.one(image)}/file?inline=yes`, { cookie: s.member });

    expect(new URL(inline.headers.get('location') ?? '').searchParams.get('disposition')).toBe(
      'inline',
    );
    expect(new URL(other.headers.get('location') ?? '').searchParams.get('disposition')).toBe(
      'attachment',
    );
  });

  it('GET file of a pending file, an unknown id and another workspace is 404', async () => {
    const s = await setup();
    const started = await start(s);
    const other = await setup();
    const foreign = await readyFile(other);

    const pending = await s.t.get(`${s.one(started.attachment.id)}/file`, { cookie: s.member });
    const unknown = await s.t.get(`${s.one('00000000-0000-4000-8000-00000000dead')}/file`, {
      cookie: s.member,
    });
    const across = await s.t.get(`${s.one(foreign)}/file`, { cookie: s.member });

    for (const res of [pending, unknown, across]) {
      expect(res.status).toBe(404);
      expect(res.headers.get('location')).toBeNull();
    }
  });

  it('DELETE removes a file: { txid }; the list is empty and the object is gone', async () => {
    const s = await setup();
    const id = await readyFile(s);

    const res = await s.t.request('DELETE', s.one(id), undefined, { cookie: s.guest });
    const guestOnMember = res.status;
    const removed = await s.t.request('DELETE', s.one(id), undefined, { cookie: s.admin });
    const listed = await s.t.get(s.list, { cookie: s.member });

    expect(guestOnMember).toBe(403);
    expect(removed.status).toBe(200);
    expect(Number.isInteger(((await removed.json()) as { txid: number }).txid)).toBe(true);
    expect(((await listed.json()) as { attachments: unknown[] }).attachments).toEqual([]);
    expect(s.files?.keys()).toEqual([]);
    expect(await s.db.orm.select().from(attachment).where(eq(attachment.id, id))).toEqual([]);
  });

  it('answers 401 without a session, for every call', async () => {
    const s = await setup();
    const id = '00000000-0000-4000-8000-00000000dead';

    const answers = [
      await s.t.get(s.list),
      await s.t.post(s.list, { fileName: 'a.png', contentType: 'image/png', size: 5 }),
      await s.t.post(`${s.one(id)}/complete`, undefined),
      await s.t.get(`${s.one(id)}/file`),
      await s.t.request('DELETE', s.one(id), undefined),
    ];

    for (const res of answers) expect(res.status).toBe(401);
  });

  it('without storage the calls that need it answer 503 storage_unavailable, and listing still works', async () => {
    const s = await setup({ storage: false });
    const id = '00000000-0000-4000-8000-00000000dead';

    const answers = [
      await s.t.post(
        s.list,
        { fileName: 'a.png', contentType: 'image/png', size: 5 },
        { cookie: s.member },
      ),
      await s.t.post(`${s.one(id)}/complete`, undefined, { cookie: s.member }),
      await s.t.get(`${s.one(id)}/file`, { cookie: s.member }),
      await s.t.request('DELETE', s.one(id), undefined, { cookie: s.member }),
    ];
    const listed = await s.t.get(s.list, { cookie: s.member });

    for (const res of answers) {
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ error: 'storage_unavailable' });
    }
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ attachments: [] });
  });
});
