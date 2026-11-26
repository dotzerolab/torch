import {
  attachment,
  event,
  issue,
  issueActivity,
  member,
  team,
  teamMember,
} from '@torch/shared/db/schema';
import { MAX_ATTACHMENTS_PER_ISSUE } from '@torch/shared/mutations/attachment';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { cleanupExpiredRows } from '../db/cleanup.ts';
import type { Db } from '../db.ts';
import { archiveIssue } from '../issues/archive.ts';
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
  withTempDatabase,
} from '../test/fixtures.ts';
import { actorOf, freshTeam, makeIssue, type Who } from '../test/issue-helpers.ts';
import { useSharedDatabase } from '../test/shared-database.ts';
import {
  completeAttachment,
  initAttachment,
  listAttachments,
  readAttachmentUrl,
  removeAttachment,
} from './attachments.ts';
import { createFakeStorage } from './fake-storage.ts';
import { finalKeyOf, stagingKeyOf } from './keys.ts';
import type { FileStorage } from './storage.ts';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.warn(
    '[files/attachments.test] SKIPPED: DATABASE_URL is not set. ' +
      'Start `docker compose -f docker-compose.dev.yml up -d --wait postgres` and set DATABASE_URL (see .env.example).',
  );
}

const text = (value: string) => new TextEncoder().encode(value);
/** A file that starts like a PNG and is `size` bytes long. */
const png = (size: number) => {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
};

/** The success of a call, or a test failure that names the refusal. */
function got<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) {
    const refused = result as unknown as { status: number; code: string };
    throw new Error(`refused: ${refused.status} ${refused.code}`);
  }
  return result as Extract<T, { ok: true }>;
}

describe.skipIf(!databaseUrl)('attachments', () => {
  const getDb = useSharedDatabase();

  async function world(key: string, db: Db = getDb()) {
    const f = await createWorkspaceFixture(db.orm);
    const t = await freshTeam(db, f, key);
    const target = await makeIssue(db, f, t.team.id, 'Attach here');
    const storage = createFakeStorage();
    const who = (name: Who) => actorOf(db, f, name);
    return {
      db,
      f,
      t,
      storage,
      issue: target,
      owner: await who('owner'),
      admin: await who('admin'),
      member: await who('member'),
      guest: await who('guest'),
    };
  }
  type World = Awaited<ReturnType<typeof world>>;

  const init = (
    w: World,
    actor: World['member'],
    over: Partial<{ fileName: string; contentType: string; size: number }> = {},
    issueId = w.issue.id,
  ) =>
    initAttachment(w.db.orm, w.storage, actor, issueId, {
      fileName: 'shot.png',
      contentType: 'image/png',
      size: 100,
      ...over,
    });

  /** Starts an upload and puts an object where the browser would. */
  async function uploaded(
    w: World,
    actor: World['member'],
    over: Partial<{ fileName: string; contentType: string; size: number }> = {},
    object: { bytes?: Uint8Array; contentType?: string } = {},
  ) {
    const started = got(await init(w, actor, over));
    // `key` is where the browser puts the file (the staging key); `finalKey` is where a verified file ends up.
    const key = started.value.upload.fields?.key ?? '';
    const size = over.size ?? 100;
    w.storage.put(
      key,
      object.bytes ?? png(size),
      object.contentType ?? over.contentType ?? 'image/png',
    );
    const id = started.value.attachment.id;
    return { id, key, finalKey: finalKeyOf(w.f.workspaceId, id) };
  }

  /** Whether the issue row can be locked right now by somebody else (it cannot while a transaction holds it). */
  const issueLockFree = (w: World) =>
    w.db.orm
      .transaction(async (tx) => {
        await tx.execute(sql`select id from issue where id = ${w.issue.id} for update nowait`);
        return true;
      })
      .catch(() => false);

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

  const rowsOf = (w: World) =>
    w.db.orm.select().from(attachment).where(eq(attachment.workspaceId, w.f.workspaceId));
  const rowOf = async (db: Db, id: string) => {
    const [row] = await db.orm.select().from(attachment).where(eq(attachment.id, id));
    return row;
  };
  const updatedAtOf = async (db: Db, id: string) => {
    const [row] = await db.orm.select().from(issue).where(eq(issue.id, id));
    if (!row) throw new Error('issue vanished');
    return row.updatedAt.getTime();
  };
  const activityOf = (db: Db, issueId: string) =>
    db.orm
      .select()
      .from(issueActivity)
      .where(eq(issueActivity.issueId, issueId))
      .orderBy(asc(issueActivity.createdAt));

  describe('init', () => {
    it('init stores a pending row and returns an upload request', async () => {
      const w = await world('INI');

      const started = got(await init(w, w.member));

      expect(started.value.attachment).toMatchObject({
        issueId: w.issue.id,
        fileName: 'shot.png',
        contentType: 'image/png',
        size: 100,
        uploaderId: w.member.memberId,
        status: 'pending',
      });
      expect(started.value.upload.method).toBe('POST');
      const stored = await rowOf(w.db, started.value.attachment.id);
      expect(stored).toMatchObject({ status: 'pending', teamId: w.t.team.id, readyAt: null });
      expect(stored?.storageKey).toBe(
        `workspaces/${w.f.workspaceId}/attachments/${started.value.attachment.id}`,
      );
      // The browser sends the file to a staging key; the row's own key is never writable by the browser.
      expect(started.value.upload.fields?.key).toBe(
        stagingKeyOf(w.f.workspaceId, started.value.attachment.id),
      );
      expect(started.value.upload.fields?.key).not.toBe(stored?.storageKey);
      expect(started.value.upload.fields?.key).toMatch(/^uploads\//);
      // The row's key is never part of what the client reads about the file.
      expect(JSON.stringify(started.value.attachment)).not.toContain('workspaces/');
    });

    it('html never allowed', async () => {
      const w = await world('HTM');

      for (const contentType of [
        'text/html',
        'image/svg+xml',
        'application/xhtml+xml',
        'text/xml',
      ]) {
        const refused = await init(w, w.member, { contentType, fileName: 'page' });
        expect(refused, contentType).toMatchObject({
          ok: false,
          status: 415,
          code: 'file_type_not_allowed',
        });
      }
      expect(await rowsOf(w)).toHaveLength(0);
    });

    it('a png named x.html is still a png, kept and served as an attachment', async () => {
      const w = await world('XHT');
      const file = await uploaded(w, w.member, { fileName: 'x.html' });
      got(await completeAttachment(w.db.orm, w.storage, w.member, file.id));

      const url = got(
        await readAttachmentUrl(w.db.orm, w.storage, w.member, file.id, { inline: true }),
      ).value;

      expect(new URL(url).searchParams.get('disposition')).toBe('attachment');
      expect(new URL(url).searchParams.get('type')).toBe('image/png');
    });

    it('size over the limit 413 file_too_large', async () => {
      const w = await world('BIG');
      const small = createFakeStorage({ maxBytes: 1000 });

      const over = await init(w, w.member, { size: 26_214_401 });
      const overConfigured = await initAttachment(w.db.orm, small, w.member, w.issue.id, {
        fileName: 'a.png',
        contentType: 'image/png',
        size: 1001,
      });
      const atLimit = await initAttachment(w.db.orm, small, w.member, w.issue.id, {
        fileName: 'a.png',
        contentType: 'image/png',
        size: 1000,
      });

      expect(over).toMatchObject({ ok: false, status: 413, code: 'file_too_large' });
      expect(overConfigured).toMatchObject({ ok: false, status: 413, code: 'file_too_large' });
      expect(atLimit.ok).toBe(true);
    });

    it('type not on the list 415, size 0 and a missing name 400', async () => {
      const w = await world('TYP');

      const type = await init(w, w.member, { contentType: 'application/octet-stream' });
      const video = await init(w, w.member, { contentType: 'video/mp4' });
      const zero = await init(w, w.member, { size: 0 });
      const fractional = await init(w, w.member, { size: 10.5 });
      const noName = await init(w, w.member, { fileName: '' });

      expect(type).toMatchObject({ ok: false, status: 415, code: 'file_type_not_allowed' });
      expect(video).toMatchObject({ ok: false, status: 415 });
      for (const result of [zero, fractional, noName]) {
        expect(result).toMatchObject({ ok: false, status: 400, code: 'invalid_input' });
      }
    });

    it('file name is sanitised', async () => {
      const w = await world('NAM');

      const traversal = got(
        await init(w, w.member, { fileName: '../../etc/passwd.txt', contentType: 'text/plain' }),
      );
      const quoted = got(await init(w, w.member, { fileName: 'a"b\r\nc.png' }));
      const long = got(await init(w, w.member, { fileName: `${'x'.repeat(400)}.png` }));

      expect(traversal.value.attachment.fileName).toBe('passwd.txt');
      expect(quoted.value.attachment.fileName).not.toMatch(/["\r\n]/);
      expect(long.value.attachment.fileName).toHaveLength(200);
      expect(long.value.attachment.fileName.endsWith('.png')).toBe(true);
    });

    it('51st file 409 too_many_attachments', async () => {
      const w = await world('MAX');
      const base = {
        workspaceId: w.f.workspaceId,
        teamId: w.t.team.id,
        issueId: w.issue.id,
        uploaderId: w.member.memberId,
        fileName: 'f.png',
        contentType: 'image/png',
        sizeBytes: 10,
      };
      await w.db.orm.insert(attachment).values(
        Array.from({ length: MAX_ATTACHMENTS_PER_ISSUE - 1 }, (_, index) => ({
          ...base,
          storageKey: `k/${w.issue.id}/${index}`,
          status: 'ready' as const,
          readyAt: new Date(),
        })),
      );

      const fiftieth = await init(w, w.admin);
      const fiftyFirst = await init(w, w.guest);

      expect(fiftieth.ok).toBe(true);
      expect(fiftyFirst).toMatchObject({ ok: false, status: 409, code: 'too_many_attachments' });
    });

    it('pending uploads count towards the 50, and expired ones do not', async () => {
      const w = await world('MXP');
      const base = {
        workspaceId: w.f.workspaceId,
        teamId: w.t.team.id,
        issueId: w.issue.id,
        uploaderId: w.admin.memberId,
        fileName: 'f.png',
        contentType: 'image/png',
        sizeBytes: 10,
        status: 'pending' as const,
      };
      await w.db.orm.insert(attachment).values(
        Array.from({ length: MAX_ATTACHMENTS_PER_ISSUE }, (_, index) => ({
          ...base,
          storageKey: `p/${w.issue.id}/${index}`,
          createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
        })),
      );

      const result = await init(w, w.member);

      expect(result.ok).toBe(true);
    });

    it('11th pending upload 429 rate_limited, per person', async () => {
      const w = await world('RTE');
      for (let i = 0; i < 10; i++) got(await init(w, w.member));

      const eleventh = await init(w, w.member);
      const someoneElse = await init(w, w.admin);

      expect(eleventh).toMatchObject({ ok: false, status: 429, code: 'rate_limited' });
      expect(someoneElse.ok).toBe(true);
    });

    it('guest uploads in own team, not elsewhere 404', async () => {
      const w = await world('GST');
      const inTeam = await init(w, w.guest);
      await restrict(w.db, w.f, w.t.team.id, ['owner', 'admin', 'member'], false);
      const guest = await actorOf(w.db, w.f, 'guest');

      const outside = await init(w, guest);

      expect(inTeam.ok).toBe(true);
      expect(outside).toMatchObject({ ok: false, status: 404, code: 'not_found' });
    });

    it('private team and foreign workspace answer 404', async () => {
      const w = await world('PRV');
      const other = await world('PRW');
      await restrict(w.db, w.f, w.t.team.id, ['owner', 'member'], true);
      const admin = await actorOf(w.db, w.f, 'admin');

      const hidden = await init(w, admin);
      const foreign = await init(w, w.member, {}, other.issue.id);
      const malformed = await init(w, w.member, {}, 'nope');

      for (const result of [hidden, foreign, malformed]) {
        expect(result).toMatchObject({ ok: false, status: 404, code: 'not_found' });
      }
    });

    it('archived issue 409', async () => {
      const w = await world('ARC');
      got(await archiveIssue(w.db.orm, w.member, w.issue.id));

      const result = await init(w, w.member);

      expect(result).toMatchObject({ ok: false, status: 409, code: 'issue_archived' });
    });

    it('a storage that cannot presign answers 503 and leaves no row', async () => {
      const w = await world('PRE');
      w.storage.faults.presign = true;

      const result = await init(w, w.member);

      expect(result).toMatchObject({ ok: false, status: 503, code: 'storage_unavailable' });
      expect(await rowsOf(w)).toHaveLength(0);
    });

    it('init does not move the issue: a pending row is invisible', async () => {
      const w = await world('INU');
      const before = await updatedAtOf(w.db, w.issue.id);

      got(await init(w, w.member));

      expect(await updatedAtOf(w.db, w.issue.id)).toBe(before);
    });
  });

  describe('complete', () => {
    it('complete publishes and writes activity and an event', async () => {
      const w = await world('CMP');
      const file = await uploaded(w, w.member, { fileName: 'proof.png', size: 64 });
      const before = await updatedAtOf(w.db, w.issue.id);

      const done = got(await completeAttachment(w.db.orm, w.storage, w.member, file.id));

      expect(done.value).toMatchObject({ id: file.id, status: 'ready', size: 64 });
      const stored = await rowOf(w.db, file.id);
      expect(stored?.status).toBe('ready');
      expect(stored?.readyAt).not.toBeNull();
      const activity = (await activityOf(w.db, w.issue.id)).filter(
        (row) => row.type === 'issue.attachment_added',
      );
      expect(activity).toHaveLength(1);
      expect(activity[0]?.toValue).toEqual({
        attachmentId: file.id,
        fileName: 'proof.png',
        size: 64,
        contentType: 'image/png',
      });
      const events = await w.db.orm
        .select()
        .from(event)
        .where(and(eq(event.workspaceId, w.f.workspaceId), eq(event.subjectId, w.issue.id)));
      expect(events.filter((row) => JSON.stringify(row.data).includes('attachments'))).toHaveLength(
        1,
      );
      expect(JSON.stringify([activity, events])).not.toContain(file.key);
      expect(JSON.stringify([activity, events])).not.toContain(file.finalKey);
      // The file was copied to its own key and the staged copy is gone.
      expect(w.storage.keys()).toEqual([file.finalKey]);
      expect(stored?.storageKey).toBe(file.finalKey);
      // The issue moves, so the web refreshes its snapshot read of the files.
      expect(await updatedAtOf(w.db, w.issue.id)).toBeGreaterThan(before);
    });

    it('size mismatch removes the object and the row', async () => {
      const w = await world('SZM');
      const file = await uploaded(w, w.member, { size: 100 }, { bytes: png(5000) });

      const result = await completeAttachment(w.db.orm, w.storage, w.member, file.id);

      expect(result).toMatchObject({ ok: false, status: 422, code: 'file_rejected' });
      expect(w.storage.keys()).toEqual([]);
      expect(await rowOf(w.db, file.id)).toBeUndefined();
    });

    it('type mismatch removes both', async () => {
      const w = await world('TYM');
      const file = await uploaded(w, w.member, {}, { contentType: 'text/html' });

      const result = await completeAttachment(w.db.orm, w.storage, w.member, file.id);

      expect(result).toMatchObject({ ok: false, status: 422, code: 'file_rejected' });
      expect(w.storage.keys()).toEqual([]);
      expect(await rowOf(w.db, file.id)).toBeUndefined();
    });

    it('bytes do not match png signature removes both', async () => {
      const w = await world('SIG');
      const file = await uploaded(w, w.member, {}, { bytes: text('<html>'.padEnd(100, ' ')) });

      const result = await completeAttachment(w.db.orm, w.storage, w.member, file.id);

      expect(result).toMatchObject({ ok: false, status: 422, code: 'file_rejected' });
      expect(w.storage.keys()).toEqual([]);
      expect(await rowOf(w.db, file.id)).toBeUndefined();
    });

    it('text with a NUL byte refused', async () => {
      const w = await world('NUL');
      const bytes = text('hello world'.padEnd(40, '.'));
      bytes[5] = 0;
      const file = await uploaded(
        w,
        w.member,
        { contentType: 'text/plain', fileName: 'notes.txt', size: 40 },
        { bytes },
      );

      const result = await completeAttachment(w.db.orm, w.storage, w.member, file.id);

      expect(result).toMatchObject({ ok: false, status: 422, code: 'file_rejected' });
    });

    it('a rejected file whose object cannot be removed is queued for the cleanup job', async () => {
      await withTempDatabase(async (db) => {
        const w = await world('RQU', db);
        const file = await uploaded(w, w.member, {}, { bytes: text('x'.repeat(100)) });
        w.storage.faults.remove = true;

        const result = await completeAttachment(w.db.orm, w.storage, w.member, file.id);
        w.storage.faults.remove = false;

        expect(result).toMatchObject({ ok: false, status: 422, code: 'file_rejected' });
        expect((await rowOf(w.db, file.id))?.status).toBe('pending');
        expect(await listAttachments(w.db.orm, w.member, w.issue.id)).toMatchObject({ value: [] });
        const counts = await cleanupExpiredRows(w.db.orm, new Date(), w.storage);
        expect(counts.pendingAttachments).toBe(1);
        expect(w.storage.keys()).toEqual([]);
        expect(await rowOf(w.db, file.id)).toBeUndefined();
      });
    });

    it('the file is read, copied and checked with no lock on the issue held, so a slow storage blocks nothing', async () => {
      const w = await world('LCK');
      const file = await uploaded(w, w.member);
      const probes: { call: string; free: boolean }[] = [];
      const base = w.storage;
      const watched: FileStorage = {
        ...base,
        head: async (key) => {
          probes.push({ call: 'head', free: await issueLockFree(w) });
          return base.head(key);
        },
        readStart: async (key, bytes) => {
          probes.push({ call: 'readStart', free: await issueLockFree(w) });
          return base.readStart(key, bytes);
        },
        copy: async (from, to) => {
          probes.push({ call: 'copy', free: await issueLockFree(w) });
          return base.copy(from, to);
        },
        remove: async (key) => {
          probes.push({ call: 'remove', free: await issueLockFree(w) });
          return base.remove(key);
        },
      };

      got(await completeAttachment(w.db.orm, watched, w.member, file.id));

      expect(probes.map((probe) => probe.call)).toEqual(
        expect.arrayContaining(['copy', 'head', 'readStart', 'remove']),
      );
      expect(probes.filter((probe) => !probe.free)).toEqual([]);
    });

    it('a copy that does not hold the declared bytes is removed with its row, staged copy included', async () => {
      const w = await world('BAD');
      const file = await uploaded(w, w.member, {}, { bytes: text('<html>'.padEnd(100, ' ')) });

      const result = await completeAttachment(w.db.orm, w.storage, w.member, file.id);

      expect(result).toMatchObject({ ok: false, status: 422, code: 'file_rejected' });
      expect(w.storage.keys()).toEqual([]);
      expect(await rowOf(w.db, file.id)).toBeUndefined();
    });

    it('bytes posted to the staging key again after complete never reach the published file', async () => {
      const w = await world('RPO');
      const file = await uploaded(w, w.member, { size: 64 });
      got(await completeAttachment(w.db.orm, w.storage, w.member, file.id));

      // The signed upload request is a policy and works until it expires: somebody sends again.
      w.storage.put(file.key, text('<html>other</html>'), 'image/png');
      const again = got(await completeAttachment(w.db.orm, w.storage, w.member, file.id));

      expect(again.value.status).toBe('ready');
      expect(await w.storage.head(file.finalKey)).toEqual({ size: 64, contentType: 'image/png' });
      expect([...(await w.storage.readStart(file.finalKey, 8))]).toEqual([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]);
    });

    it('a storage that cannot copy answers 503, writes nothing and lets the upload be completed later', async () => {
      const w = await world('CPF');
      const file = await uploaded(w, w.member);
      w.storage.faults.copy = true;

      const down = await completeAttachment(w.db.orm, w.storage, w.member, file.id);
      w.storage.faults.copy = false;
      const retry = await completeAttachment(w.db.orm, w.storage, w.member, file.id);

      expect(down).toMatchObject({ ok: false, status: 503, code: 'storage_unavailable' });
      expect(retry.ok).toBe(true);
      expect(w.storage.keys()).toEqual([file.finalKey]);
    });

    it('a second complete that overwrites the published file with bytes that fail the check removes the file', async () => {
      const w = await world('RAC');
      const file = await uploaded(w, w.member, { size: 64 });
      const base = w.storage;
      let raced = false;
      const racing: FileStorage = {
        ...base,
        copy: async (from, to) => {
          if (!raced) {
            raced = true;
            // The other complete runs to its end while this one is in flight, then the staged bytes change.
            got(await completeAttachment(w.db.orm, base, w.member, file.id));
            base.put(from, text('<html>swapped</html>'.padEnd(64, ' ')), 'image/png');
          }
          return base.copy(from, to);
        },
      };

      const result = await completeAttachment(w.db.orm, racing, w.member, file.id);

      expect(result).toMatchObject({ ok: false, status: 422, code: 'file_rejected' });
      expect(await rowOf(w.db, file.id)).toBeUndefined();
      expect(w.storage.keys()).toEqual([]);
      expect(got(await listAttachments(w.db.orm, w.member, w.issue.id)).value).toEqual([]);
      const kinds = (await activityOf(w.db, w.issue.id))
        .map((row) => row.type)
        .filter((type) => type.startsWith('issue.attachment'));
      expect(kinds).toEqual(['issue.attachment_added', 'issue.attachment_removed']);
    });

    it('a removal that wins while the copy is in flight leaves no object behind', async () => {
      const w = await world('RWN');
      const file = await uploaded(w, w.member);
      const base = w.storage;
      const racing: FileStorage = {
        ...base,
        copy: async (from, to) => {
          const copied = await base.copy(from, to);
          got(await removeAttachment(w.db.orm, base, w.member, file.id));
          // the in-flight copy lands after the removal finished
          if (copied) base.put(to, png(100), 'image/png');
          return copied;
        },
      };

      const result = await completeAttachment(w.db.orm, racing, w.member, file.id);

      expect(result).toMatchObject({ ok: false, status: 404 });
      expect(await rowOf(w.db, file.id)).toBeUndefined();
      expect(w.storage.keys()).toEqual([]);
    });

    it('complete twice is one activity row', async () => {
      const w = await world('TWI');
      const file = await uploaded(w, w.member);

      got(await completeAttachment(w.db.orm, w.storage, w.member, file.id));
      const again = got(await completeAttachment(w.db.orm, w.storage, w.member, file.id));

      expect(again.value.status).toBe('ready');
      const added = (await activityOf(w.db, w.issue.id)).filter(
        (row) => row.type === 'issue.attachment_added',
      );
      expect(added).toHaveLength(1);
    });

    it('complete by another person 403', async () => {
      const w = await world('OTH');
      const file = await uploaded(w, w.member);

      const result = await completeAttachment(w.db.orm, w.storage, w.admin, file.id);

      expect(result).toMatchObject({ ok: false, status: 403, code: 'forbidden' });
      expect((await rowOf(w.db, file.id))?.status).toBe('pending');
    });

    it('complete without an uploaded object 422 and the row stays pending', async () => {
      const w = await world('NOO');
      const started = got(await init(w, w.member));

      const result = await completeAttachment(
        w.db.orm,
        w.storage,
        w.member,
        started.value.attachment.id,
      );

      expect(result).toMatchObject({ ok: false, status: 422, code: 'file_rejected' });
      expect((await rowOf(w.db, started.value.attachment.id))?.status).toBe('pending');
    });

    it('a storage outage on complete answers 503 and keeps the row pending', async () => {
      const w = await world('OUT');
      const file = await uploaded(w, w.member);
      w.storage.faults.head = true;

      const result = await completeAttachment(w.db.orm, w.storage, w.member, file.id);
      w.storage.faults.head = false;
      const retry = await completeAttachment(w.db.orm, w.storage, w.member, file.id);

      expect(result).toMatchObject({ ok: false, status: 503, code: 'storage_unavailable' });
      expect(retry.ok).toBe(true);
    });

    it('an issue archived since the upload began is read-only: 409 and the row stays pending', async () => {
      const w = await world('CAR');
      const file = await uploaded(w, w.member);
      got(await archiveIssue(w.db.orm, w.member, w.issue.id));

      const result = await completeAttachment(w.db.orm, w.storage, w.member, file.id);

      expect(result).toMatchObject({ ok: false, status: 409, code: 'issue_archived' });
      expect((await rowOf(w.db, file.id))?.status).toBe('pending');
    });

    it('an upload pending for over 24 hours cannot be completed any more', async () => {
      const w = await world('OLD');
      const file = await uploaded(w, w.member);
      await w.db.orm
        .update(attachment)
        .set({ createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })
        .where(eq(attachment.id, file.id));

      const result = await completeAttachment(w.db.orm, w.storage, w.member, file.id);

      expect(result).toMatchObject({ ok: false, status: 404, code: 'not_found' });
    });

    it('unknown, foreign and malformed ids answer 404', async () => {
      const w = await world('CNF');
      const other = await world('CNG');
      const foreignFile = await uploaded(other, other.member);

      for (const id of ['00000000-0000-4000-8000-00000000dead', foreignFile.id, 'nope']) {
        const result = await completeAttachment(w.db.orm, w.storage, w.member, id);
        expect(result).toMatchObject({ ok: false, status: 404, code: 'not_found' });
      }
    });
  });

  describe('read', () => {
    async function readyFile(
      w: World,
      actor = w.member,
      over: Parameters<typeof uploaded>[2] = {},
    ) {
      const file = await uploaded(w, actor, over);
      got(await completeAttachment(w.db.orm, w.storage, actor, file.id));
      return file;
    }

    it('read mints a 60 s url and never stores it', async () => {
      const w = await world('RDM');
      const file = await readyFile(w);

      const result = got(
        await readAttachmentUrl(w.db.orm, w.storage, w.guest, file.id, { inline: false }),
      );

      expect(w.storage.urlsMinted).toEqual([result.value]);
      expect(new URL(result.value).searchParams.get('expires')).toBe('60');
      const stored = JSON.stringify(await w.db.orm.select().from(attachment));
      expect(stored).not.toContain('https://');
    });

    it('read a pending file 404', async () => {
      const w = await world('RDP');
      const file = await uploaded(w, w.member);

      const result = await readAttachmentUrl(w.db.orm, w.storage, w.member, file.id, {
        inline: false,
      });

      expect(result).toMatchObject({ ok: false, status: 404, code: 'not_found' });
      expect(w.storage.urlsMinted).toEqual([]);
    });

    it('read after removal from the team 404, even with the old actor in hand', async () => {
      const w = await world('RDR');
      const file = await readyFile(w);
      await restrict(w.db, w.f, w.t.team.id, ['owner', 'member'], true);
      const freshGuest = await actorOf(w.db, w.f, 'guest');

      const fresh = await readAttachmentUrl(w.db.orm, w.storage, freshGuest, file.id, {
        inline: false,
      });
      const stale = await readAttachmentUrl(w.db.orm, w.storage, w.guest, file.id, {
        inline: false,
      });
      const admin = await readAttachmentUrl(
        w.db.orm,
        w.storage,
        await actorOf(w.db, w.f, 'admin'),
        file.id,
        { inline: false },
      );

      for (const result of [fresh, stale, admin]) {
        expect(result).toMatchObject({ ok: false, status: 404, code: 'not_found' });
      }
      expect(w.storage.urlsMinted).toEqual([]);
    });

    it('read by a deactivated member 401', async () => {
      const w = await world('RDD');
      const file = await readyFile(w);
      await w.db.orm
        .update(member)
        .set({ deactivatedAt: new Date() })
        .where(eq(member.id, w.guest.memberId));

      const result = await readAttachmentUrl(w.db.orm, w.storage, w.guest, file.id, {
        inline: false,
      });

      expect(result).toMatchObject({ ok: false, status: 401, code: 'unauthenticated' });
      expect(w.storage.urlsMinted).toEqual([]);
    });

    it('foreign workspace read 404, the same answer as an unknown id', async () => {
      const w = await world('RDF');
      const other = await world('RDG');
      const foreign = await readyFile(other);

      const ofForeign = await readAttachmentUrl(w.db.orm, w.storage, w.owner, foreign.id, {
        inline: false,
      });
      const ofNowhere = await readAttachmentUrl(
        w.db.orm,
        w.storage,
        w.owner,
        '00000000-0000-4000-8000-00000000dead',
        { inline: false },
      );

      expect(ofForeign).toEqual(ofNowhere);
      expect(ofForeign).toMatchObject({ ok: false, status: 404, code: 'not_found' });
      expect(other.storage.urlsMinted).toEqual([]);
    });

    it('inline only for raster images', async () => {
      const w = await world('INL');
      const image = await readyFile(w, w.member, { fileName: 'a.png' });
      const pdf = await uploaded(
        w,
        w.member,
        { fileName: 'a.pdf', contentType: 'application/pdf', size: 50 },
        { bytes: text('%PDF-1.7'.padEnd(50, ' ')) },
      );
      got(await completeAttachment(w.db.orm, w.storage, w.member, pdf.id));
      const disposition = async (id: string, inline: boolean) =>
        new URL(
          got(await readAttachmentUrl(w.db.orm, w.storage, w.member, id, { inline })).value,
        ).searchParams.get('disposition');

      expect(await disposition(image.id, true)).toBe('inline');
      expect(await disposition(image.id, false)).toBe('attachment');
      expect(await disposition(pdf.id, true)).toBe('attachment');
    });

    it('a storage that cannot sign answers 503', async () => {
      const w = await world('RDS');
      const file = await readyFile(w);
      w.storage.faults.presign = true;

      const result = await readAttachmentUrl(w.db.orm, w.storage, w.member, file.id, {
        inline: false,
      });

      expect(result).toMatchObject({ ok: false, status: 503, code: 'storage_unavailable' });
    });
  });

  describe('list and remove', () => {
    async function readyFile(
      w: World,
      actor: World['member'],
      over: Parameters<typeof uploaded>[2] = {},
    ) {
      const file = await uploaded(w, actor, over);
      got(await completeAttachment(w.db.orm, w.storage, actor, file.id));
      return file;
    }

    it('list shows ready files only, oldest first, never the key', async () => {
      const w = await world('LST');
      const first = await readyFile(w, w.member, { fileName: 'one.png' });
      await uploaded(w, w.member, { fileName: 'pending.png' });
      const second = await readyFile(w, w.guest, { fileName: 'two.png' });

      const listed = got(await listAttachments(w.db.orm, w.admin, w.issue.id)).value;

      expect(listed.map((file) => file.id)).toEqual([first.id, second.id]);
      expect(JSON.stringify(listed)).not.toContain('workspaces/');
    });

    it('list needs sight of the issue', async () => {
      const w = await world('LSV');
      await restrict(w.db, w.f, w.t.team.id, ['owner', 'member'], true);
      const admin = await actorOf(w.db, w.f, 'admin');

      const result = await listAttachments(w.db.orm, admin, w.issue.id);

      expect(result).toMatchObject({ ok: false, status: 404 });
    });

    it('remove by uploader and by any non-guest, refused for another guest 403', async () => {
      const w = await world('RMV');
      const byGuest = await readyFile(w, w.guest, { fileName: 'g.png' });
      const byMember = await readyFile(w, w.member, { fileName: 'm.png' });
      const another = await readyFile(w, w.member, { fileName: 'm2.png' });
      const guestUploader = await actorOf(w.db, w.f, 'guest');

      const guestOnMember = await removeAttachment(w.db.orm, w.storage, guestUploader, byMember.id);
      const guestOwn = await removeAttachment(w.db.orm, w.storage, guestUploader, byGuest.id);
      const adminOnMember = await removeAttachment(w.db.orm, w.storage, w.admin, byMember.id);
      const memberOnMember = await removeAttachment(w.db.orm, w.storage, w.member, another.id);

      expect(guestOnMember).toMatchObject({ ok: false, status: 403, code: 'forbidden' });
      expect(guestOwn.ok).toBe(true);
      expect(adminOnMember.ok).toBe(true);
      expect(memberOnMember.ok).toBe(true);
      expect(got(await listAttachments(w.db.orm, w.owner, w.issue.id)).value).toEqual([]);
    });

    it('remove deletes the object and records activity', async () => {
      const w = await world('RMA');
      const file = await readyFile(w, w.member, { fileName: 'gone.png' });
      const before = await updatedAtOf(w.db, w.issue.id);

      got(await removeAttachment(w.db.orm, w.storage, w.member, file.id));

      expect(w.storage.keys()).toEqual([]);
      expect(await rowOf(w.db, file.id)).toBeUndefined();
      const removed = (await activityOf(w.db, w.issue.id)).filter(
        (row) => row.type === 'issue.attachment_removed',
      );
      expect(removed).toHaveLength(1);
      expect(removed[0]?.fromValue).toMatchObject({ attachmentId: file.id, fileName: 'gone.png' });
      expect(await updatedAtOf(w.db, w.issue.id)).toBeGreaterThan(before);
      const again = await removeAttachment(w.db.orm, w.storage, w.member, file.id);
      expect(again).toMatchObject({ ok: false, status: 404 });
    });

    it('a failed object delete does not roll the row back and is retried by cleanup', async () => {
      await withTempDatabase(async (db) => {
        const w = await world('RMF', db);
        const file = await readyFile(w, w.member);
        w.storage.faults.remove = true;

        const result = await removeAttachment(w.db.orm, w.storage, w.member, file.id);
        w.storage.faults.remove = false;

        expect(result.ok).toBe(true);
        expect(got(await listAttachments(w.db.orm, w.member, w.issue.id)).value).toEqual([]);
        expect(
          await readAttachmentUrl(w.db.orm, w.storage, w.member, file.id, { inline: false }),
        ).toMatchObject({
          ok: false,
          status: 404,
        });
        expect(w.storage.keys()).toContain(file.finalKey);
        // Not even its uploader can bring it back.
        expect(await completeAttachment(w.db.orm, w.storage, w.member, file.id)).toMatchObject({
          ok: false,
          status: 404,
        });

        const counts = await cleanupExpiredRows(w.db.orm, new Date(), w.storage);

        expect(counts.pendingAttachments).toBe(1);
        expect(w.storage.keys()).toEqual([]);
        expect(await rowOf(w.db, file.id)).toBeUndefined();
      });
    });

    it('the uploader cancels a pending upload; another person cannot see it', async () => {
      const w = await world('RMP');
      const file = await uploaded(w, w.member);

      const other = await removeAttachment(w.db.orm, w.storage, w.admin, file.id);
      const own = await removeAttachment(w.db.orm, w.storage, w.member, file.id);

      expect(other).toMatchObject({ ok: false, status: 404 });
      expect(own.ok).toBe(true);
      expect(w.storage.keys()).toEqual([]);
      expect(await rowOf(w.db, file.id)).toBeUndefined();
      expect(
        (await activityOf(w.db, w.issue.id)).filter((row) =>
          row.type.startsWith('issue.attachment'),
        ),
      ).toEqual([]);
    });

    it('remove on an archived issue 409; on a hidden team 404; on a foreign id 404', async () => {
      const w = await world('RMX');
      const other = await world('RMY');
      const file = await readyFile(w, w.member);
      const foreign = await readyFile(other, other.member);
      const foreignAttempt = await removeAttachment(w.db.orm, w.storage, w.owner, foreign.id);
      got(await archiveIssue(w.db.orm, w.member, w.issue.id));

      const archived = await removeAttachment(w.db.orm, w.storage, w.member, file.id);

      expect(archived).toMatchObject({ ok: false, status: 409, code: 'issue_archived' });
      expect(foreignAttempt).toMatchObject({ ok: false, status: 404 });
      expect(w.storage.keys()).toContain(file.finalKey);
    });
  });

  describe('what no log line may hold', () => {
    it('no log line holds a url or key', async () => {
      const w = await world('LOG');
      const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
        vi.spyOn(console, method).mockImplementation(() => {}),
      );
      try {
        const file = await uploaded(w, w.member);
        got(await completeAttachment(w.db.orm, w.storage, w.member, file.id));
        got(await readAttachmentUrl(w.db.orm, w.storage, w.member, file.id, { inline: true }));
        w.storage.faults.remove = true;
        await removeAttachment(w.db.orm, w.storage, w.member, file.id);
        w.storage.faults.presign = true;
        await readAttachmentUrl(w.db.orm, w.storage, w.member, file.id, { inline: true });
        w.storage.faults.presign = false;
        const bad = await uploaded(w, w.guest, {}, { bytes: text('x'.repeat(100)) });
        await completeAttachment(w.db.orm, w.storage, w.guest, bad.id);
      } finally {
        for (const spy of spies) spy.mockRestore();
      }

      const logged = spies.flatMap((spy) => spy.mock.calls.flat()).join(' ');
      expect(logged).not.toContain('https://');
      expect(logged).not.toContain('workspaces/');
    });
  });
});
