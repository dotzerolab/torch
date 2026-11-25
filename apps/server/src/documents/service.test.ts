import { document, documentRevision, team, teamMember } from '@torch/shared/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { Db } from '../db.ts';
import { createWorkspaceFixture, type WorkspaceFixture } from '../test/fixtures.ts';
import { actorOf, freshTeam, type Who } from '../test/issue-helpers.ts';
import { useSharedDatabase } from '../test/shared-database.ts';
import {
  archiveDocument,
  createDocument,
  getDocument,
  listDocuments,
  listRevisions,
  updateDocument,
} from './service.ts';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.warn(
    '[documents/service.test] SKIPPED: DATABASE_URL is not set. ' +
      'Start `docker compose -f docker-compose.dev.yml up -d --wait postgres` and set DATABASE_URL (see .env.example).',
  );
}

/** The success of a call, or a test failure that names the refusal. */
function got<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) {
    const refused = result as unknown as { status: number; code: string };
    throw new Error(`refused: ${refused.status} ${refused.code}`);
  }
  return result as Extract<T, { ok: true }>;
}

describe.skipIf(!databaseUrl)('document service', () => {
  const getDb = useSharedDatabase();

  async function world(key: string) {
    const db = getDb();
    const f = await createWorkspaceFixture(db.orm);
    const t = await freshTeam(db, f, key);
    const who = (name: Who) => actorOf(db, f, name);
    return {
      db,
      f,
      t,
      teamId: t.team.id,
      owner: await who('owner'),
      admin: await who('admin'),
      member: await who('member'),
      guest: await who('guest'),
    };
  }
  type World = Awaited<ReturnType<typeof world>>;

  async function restrict(
    db: Db,
    f: WorkspaceFixture,
    teamId: string,
    keep: Who[],
    isPrivate: boolean,
  ) {
    await db.orm.update(team).set({ private: isPrivate }).where(eq(team.id, teamId));
    const drop = (['owner', 'admin', 'member', 'guest'] as const)
      .filter((name) => !keep.includes(name))
      .map((name) => f.members[name].id);
    await db.orm
      .delete(teamMember)
      .where(and(eq(teamMember.teamId, teamId), inArray(teamMember.memberId, drop)));
  }

  const create = (
    w: World,
    over: Partial<{ title: string; body: string }> = {},
    actor = w.member,
  ) =>
    createDocument(w.db.orm, actor, {
      teamId: w.teamId,
      title: 'Runbook',
      body: 'Step one',
      ...over,
    });
  const rowOf = async (db: Db, id: string) => {
    const [row] = await db.orm.select().from(document).where(eq(document.id, id));
    if (!row) throw new Error('document vanished');
    return row;
  };
  const revisionsOf = (w: World, id: string) =>
    w.db.orm.select().from(documentRevision).where(eq(documentRevision.documentId, id));

  it('create and list without body', async () => {
    const w = await world('CLS');

    const created = got(await create(w, { title: ' Runbook ', body: 'Secret body text' }));
    const listed = got(
      await listDocuments(w.db.orm, w.guest, w.teamId, { includeArchived: false }),
    );

    expect(created.value).toMatchObject({
      teamId: w.teamId,
      title: 'Runbook',
      body: 'Secret body text',
      createdBy: w.member.memberId,
      updatedBy: w.member.memberId,
      archivedAt: null,
    });
    expect(typeof created.txid).toBe('number');
    expect(listed.value.map((row) => row.id)).toEqual([created.value.id]);
    expect(listed.value[0]).not.toHaveProperty('body');
    expect(JSON.stringify(listed.value)).not.toContain('Secret');
  });

  it('list is newest edit first and hides archived documents unless asked', async () => {
    const w = await world('LST');
    const one = got(await create(w, { title: 'One' }));
    const two = got(await create(w, { title: 'Two' }));
    got(await updateDocument(w.db.orm, w.member, one.value.id, { body: 'touched' }));
    got(await archiveDocument(w.db.orm, w.member, two.value.id, true));

    const open = got(await listDocuments(w.db.orm, w.member, w.teamId, { includeArchived: false }));
    const all = got(await listDocuments(w.db.orm, w.member, w.teamId, { includeArchived: true }));

    expect(open.value.map((row) => row.id)).toEqual([one.value.id]);
    expect(all.value.map((row) => row.id)).toEqual([one.value.id, two.value.id]);
    expect(all.value[1]?.archivedAt).not.toBeNull();
  });

  it('get returns body', async () => {
    const w = await world('GET');
    const created = got(await create(w, { body: 'The whole text' }));

    const read = got(await getDocument(w.db.orm, w.guest, created.value.id));

    expect(read.value).toMatchObject({ id: created.value.id, body: 'The whole text' });
  });

  it('guest reads, cannot create or edit (403)', async () => {
    const w = await world('GST');
    const created = got(await create(w));

    const guestCreate = await create(w, {}, w.guest);
    const guestEdit = await updateDocument(w.db.orm, w.guest, created.value.id, { title: 'Mine' });
    const guestArchive = await archiveDocument(w.db.orm, w.guest, created.value.id, true);
    const guestRead = await getDocument(w.db.orm, w.guest, created.value.id);
    const guestRevisions = await listRevisions(w.db.orm, w.guest, created.value.id);

    for (const result of [guestCreate, guestEdit, guestArchive]) {
      expect(result).toMatchObject({ ok: false, status: 403, code: 'forbidden' });
    }
    expect(guestRead.ok).toBe(true);
    expect(guestRevisions.ok).toBe(true);
    expect((await rowOf(w.db, created.value.id)).title).toBe('Runbook');
  });

  it('private team 404 for non-members and for owner and admin outside it', async () => {
    const w = await world('PRV');
    const created = got(await create(w));
    await restrict(w.db, w.f, w.teamId, ['member'], true);
    const owner = await actorOf(w.db, w.f, 'owner');
    const admin = await actorOf(w.db, w.f, 'admin');
    const guest = await actorOf(w.db, w.f, 'guest');

    for (const actor of [owner, admin, guest]) {
      const answers = [
        await create(w, {}, actor),
        await getDocument(w.db.orm, actor, created.value.id),
        await listDocuments(w.db.orm, actor, w.teamId, { includeArchived: true }),
        await updateDocument(w.db.orm, actor, created.value.id, { title: 'x' }),
        await archiveDocument(w.db.orm, actor, created.value.id, true),
        await listRevisions(w.db.orm, actor, created.value.id),
      ];
      for (const answer of answers) {
        expect(answer).toMatchObject({ ok: false, status: 404, code: 'not_found' });
      }
    }
    expect((await create(w, {}, await actorOf(w.db, w.f, 'member'))).ok).toBe(true);
  });

  it('foreign workspace 404', async () => {
    const w = await world('FWA');
    const other = await world('FWB');
    const foreign = got(await create(other));

    const answers = [
      await getDocument(w.db.orm, w.owner, foreign.value.id),
      await updateDocument(w.db.orm, w.owner, foreign.value.id, { title: 'x' }),
      await archiveDocument(w.db.orm, w.owner, foreign.value.id, true),
      await listRevisions(w.db.orm, w.owner, foreign.value.id),
      await listDocuments(w.db.orm, w.owner, other.teamId, { includeArchived: false }),
      await createDocument(w.db.orm, w.owner, { teamId: other.teamId, title: 'x' }),
      await getDocument(w.db.orm, w.owner, 'nope'),
      await getDocument(w.db.orm, w.owner, '00000000-0000-4000-8000-00000000dead'),
    ];

    for (const answer of answers) {
      expect(answer).toMatchObject({ ok: false, status: 404, code: 'not_found' });
    }
    expect((await rowOf(w.db, foreign.value.id)).title).toBe('Runbook');
  });

  it('edit stores a revision only when title or body changed', async () => {
    const w = await world('REV');
    const created = got(await create(w, { title: 'v1', body: 'one' }));
    const id = created.value.id;
    const first = await rowOf(w.db, id);

    got(await updateDocument(w.db.orm, w.admin, id, { body: 'two' }));
    got(await updateDocument(w.db.orm, w.admin, id, { title: 'v2', body: 'two' }));
    const unchanged = got(
      await updateDocument(w.db.orm, w.admin, id, { title: 'v2', body: 'two' }),
    );
    got(await updateDocument(w.db.orm, w.admin, id, { title: ' v2 ' }));

    const stored = await rowOf(w.db, id);
    expect(stored).toMatchObject({ title: 'v2', body: 'two', updatedBy: w.admin.memberId });
    expect(stored.updatedAt.getTime()).toBeGreaterThan(first.updatedAt.getTime());
    expect(typeof unchanged.txid).toBe('number');
    const revisions = got(await listRevisions(w.db.orm, w.guest, id)).value;
    expect(revisions.map((rev) => [rev.title, rev.body])).toEqual([
      ['v1', 'two'],
      ['v1', 'one'],
    ]);
    expect(revisions.every((rev) => rev.editedBy === w.admin.memberId)).toBe(true);
  });

  it('an edit with no field, an empty title or an oversize body is 400', async () => {
    const w = await world('BAD');
    const created = got(await create(w));
    const id = created.value.id;

    const answers = [
      await updateDocument(w.db.orm, w.member, id, {}),
      await updateDocument(w.db.orm, w.member, id, { title: '  ' }),
      await updateDocument(w.db.orm, w.member, id, { body: 'x'.repeat(100_001) }),
      await updateDocument(w.db.orm, w.member, id, { teamId: w.teamId } as never),
      await create(w, { title: '' }),
      await create(w, { body: 'x'.repeat(100_001) }),
    ];

    for (const answer of answers) {
      expect(answer).toMatchObject({ ok: false, status: 400, code: 'invalid_input' });
    }
    expect(got(await getDocument(w.db.orm, w.member, id)).value.body).toBe('Step one');
  });

  it('a body of 100,000 characters is accepted', async () => {
    const w = await world('MAX');

    const created = got(await create(w, { body: 'x'.repeat(100_000) }));

    expect(got(await getDocument(w.db.orm, w.member, created.value.id)).value.body).toHaveLength(
      100_000,
    );
  });

  it('concurrent edits keep both versions', async () => {
    const w = await world('CON');
    const created = got(await create(w, { title: 'start', body: 'v0' }));
    const id = created.value.id;

    const [a, b] = await Promise.all([
      updateDocument(w.db.orm, w.member, id, { body: 'edit A' }),
      updateDocument(w.db.orm, w.admin, id, { body: 'edit B' }),
    ]);

    expect(a.ok && b.ok).toBe(true);
    const stored = await rowOf(w.db, id);
    expect(['edit A', 'edit B']).toContain(stored.body);
    const loser = stored.body === 'edit A' ? 'edit B' : 'edit A';
    const bodies = (await revisionsOf(w, id)).map((rev) => rev.body).sort();
    expect(bodies).toEqual(['v0', loser].sort());
  });

  it('archive is read-only until unarchive', async () => {
    const w = await world('ARC');
    const created = got(await create(w));
    const id = created.value.id;

    got(await archiveDocument(w.db.orm, w.member, id, true));
    got(await archiveDocument(w.db.orm, w.member, id, true));
    const edit = await updateDocument(w.db.orm, w.member, id, { title: 'late' });
    const read = await getDocument(w.db.orm, w.guest, id);
    got(await archiveDocument(w.db.orm, w.admin, id, false));
    const afterwards = await updateDocument(w.db.orm, w.member, id, { title: 'on time' });

    expect(edit).toMatchObject({ ok: false, status: 409, code: 'document_archived' });
    expect(got(read).value.archivedAt).not.toBeNull();
    expect(afterwards.ok).toBe(true);
    expect((await rowOf(w.db, id)).archivedAt).toBeNull();
  });

  it('revision cap keeps the newest 50', async () => {
    const w = await world('CAP');
    const created = got(await create(w, { body: 'v0' }));
    const id = created.value.id;

    for (let i = 1; i <= 55; i++) {
      got(await updateDocument(w.db.orm, w.member, id, { body: `v${i}` }));
    }

    const revisions = got(await listRevisions(w.db.orm, w.member, id)).value;
    expect(revisions).toHaveLength(50);
    expect(revisions[0]?.body).toBe('v54');
    expect(revisions[49]?.body).toBe('v5');
    expect(await revisionsOf(w, id)).toHaveLength(50);
  });

  it('replay of a create keeps one document', async () => {
    const w = await world('RPL');
    const key = 'doc-create-0001';

    const first = got(
      await createDocument(
        w.db.orm,
        w.member,
        { teamId: w.teamId, title: 'Once' },
        { idempotencyKey: key },
      ),
    );
    const again = got(
      await createDocument(
        w.db.orm,
        w.member,
        { teamId: w.teamId, title: 'Once' },
        { idempotencyKey: key },
      ),
    );
    const changed = await createDocument(
      w.db.orm,
      w.member,
      { teamId: w.teamId, title: 'Twice' },
      { idempotencyKey: key },
    );

    expect(again.value.id).toBe(first.value.id);
    expect(first.replayed).toBe(false);
    expect(again.replayed).toBe(true);
    expect(changed).toMatchObject({ ok: false, status: 422, code: 'idempotency_key_reused' });
    const rows = await w.db.orm.select().from(document).where(eq(document.teamId, w.teamId));
    expect(rows).toHaveLength(1);
  });

  it('a refused create does not keep its idempotency key', async () => {
    const w = await world('RFK');
    const key = 'refused-then-fixed';
    const refused = await createDocument(
      w.db.orm,
      w.guest,
      { teamId: w.teamId, title: 'x' },
      { idempotencyKey: key },
    );

    const retry = await createDocument(
      w.db.orm,
      w.member,
      { teamId: w.teamId, title: 'y' },
      { idempotencyKey: key },
    );

    expect(refused).toMatchObject({ ok: false, status: 403 });
    expect(got(retry).replayed).toBe(false);
  });

  it('revisions are readable by whoever reads the document, not by a stranger', async () => {
    const w = await world('RVR');
    const created = got(await create(w, { body: 'one' }));
    got(await updateDocument(w.db.orm, w.member, created.value.id, { body: 'two' }));
    await restrict(w.db, w.f, w.teamId, ['owner', 'member'], true);
    const guest = await actorOf(w.db, w.f, 'guest');

    const hidden = await listRevisions(w.db.orm, guest, created.value.id);
    const visible = await listRevisions(w.db.orm, w.owner, created.value.id);

    expect(hidden).toMatchObject({ ok: false, status: 404 });
    expect(got(visible).value).toHaveLength(1);
  });
});
