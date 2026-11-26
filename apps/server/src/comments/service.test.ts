import {
  comment,
  commentEdit,
  event,
  issue,
  issueActivity,
  team,
  teamMember,
} from '@torch/shared/db/schema';
import { REACTION_EMOJI } from '@torch/shared/mutations/comment';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../db.ts';
import { archiveIssue } from '../issues/archive.ts';
import { loadClientActor } from '../permissions/load-actor.ts';
import { addMember, createWorkspaceFixture, type WorkspaceFixture } from '../test/fixtures.ts';
import { actorOf, freshTeam, makeIssue, type Who } from '../test/issue-helpers.ts';
import { useSharedDatabase } from '../test/shared-database.ts';

// Failure injection for the outbox write only: one test makes it throw to prove that a comment, its event and the
// issue's `updated_at` roll back together. Everything else in this file runs the real code.
const fault = vi.hoisted(() => ({ failEvents: false }));
vi.mock('./events.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./events.ts')>();
  return {
    ...actual,
    recordCommentCreated: async (...args: Parameters<typeof actual.recordCommentCreated>) => {
      if (fault.failEvents) throw new Error('outbox is down');
      return actual.recordCommentCreated(...args);
    },
  };
});

import {
  createComment,
  deleteComment,
  editComment,
  listComments,
  listEdits,
  setReaction,
  setResolved,
} from './service.ts';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.warn(
    '[comments/service.test] SKIPPED: DATABASE_URL is not set. ' +
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

describe.skipIf(!databaseUrl)('comment service', () => {
  const getDb = useSharedDatabase();

  async function world(key: string) {
    const db = getDb();
    const f = await createWorkspaceFixture(db.orm);
    const t = await freshTeam(db, f, key);
    const target = await makeIssue(db, f, t.team.id, 'Discuss this');
    const who = async (name: Who) => actorOf(db, f, name);
    return {
      db,
      f,
      t,
      issue: target,
      owner: await who('owner'),
      admin: await who('admin'),
      member: await who('member'),
      guest: await who('guest'),
    };
  }

  /** Makes the team private and keeps only the listed roles in it. */
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
    if (drop.length > 0) {
      await db.orm
        .delete(teamMember)
        .where(and(eq(teamMember.teamId, teamId), inArray(teamMember.memberId, drop)));
    }
  }

  const updatedAtOf = async (db: Db, id: string) => {
    const [row] = await db.orm.select().from(issue).where(eq(issue.id, id));
    if (!row) throw new Error('issue vanished');
    return row.updatedAt.getTime();
  };
  const rowOf = async (db: Db, id: string) => {
    const [row] = await db.orm.select().from(comment).where(eq(comment.id, id));
    if (!row) throw new Error('comment vanished');
    return row;
  };

  describe('create', () => {
    it('create top-level and reply', async () => {
      const w = await world('CRT');

      const root = got(
        await createComment(w.db.orm, w.member, w.issue.id, { body: ' First thought ' }),
      );
      const reply = got(
        await createComment(w.db.orm, w.admin, w.issue.id, {
          body: 'A reply',
          parentId: root.value.id,
        }),
      );

      expect(root.value).toMatchObject({
        issueId: w.issue.id,
        parentId: null,
        authorId: w.member.memberId,
        body: 'First thought',
        reactions: {},
        editedAt: null,
        resolvedAt: null,
        resolvedBy: null,
        deleted: false,
      });
      expect(reply.value).toMatchObject({ parentId: root.value.id, authorId: w.admin.memberId });
      expect(typeof root.txid).toBe('number');
      expect(root.replayed).toBe(false);
      const stored = await w.db.orm.select().from(comment).where(eq(comment.issueId, w.issue.id));
      expect(stored).toHaveLength(2);
      expect(stored.every((row) => row.teamId === w.t.team.id)).toBe(true);
    });

    it('reply to a reply refused', async () => {
      const w = await world('RTR');
      const root = got(await createComment(w.db.orm, w.member, w.issue.id, { body: 'root' }));
      const reply = got(
        await createComment(w.db.orm, w.member, w.issue.id, {
          body: 'reply',
          parentId: root.value.id,
        }),
      );

      const result = await createComment(w.db.orm, w.member, w.issue.id, {
        body: 'too deep',
        parentId: reply.value.id,
      });

      expect(result).toMatchObject({
        ok: false,
        status: 422,
        code: 'invalid_reference',
        details: { field: 'parentId' },
      });
      expect(
        await w.db.orm.select().from(comment).where(eq(comment.issueId, w.issue.id)),
      ).toHaveLength(2);
    });

    it('reply parent of another issue refused', async () => {
      const w = await world('RPO');
      const other = await makeIssue(w.db, w.f, w.t.team.id, 'Another issue');
      const root = got(await createComment(w.db.orm, w.member, other.id, { body: 'elsewhere' }));

      const result = await createComment(w.db.orm, w.member, w.issue.id, {
        body: 'wrong thread',
        parentId: root.value.id,
      });
      const unknown = await createComment(w.db.orm, w.member, w.issue.id, {
        body: 'no such parent',
        parentId: '00000000-0000-4000-8000-00000000dead',
      });

      expect(result).toMatchObject({ ok: false, status: 422, details: { field: 'parentId' } });
      expect(unknown).toMatchObject({ ok: false, status: 422, details: { field: 'parentId' } });
    });

    it('reply to a deleted comment refused', async () => {
      const w = await world('RDC');
      const root = got(await createComment(w.db.orm, w.member, w.issue.id, { body: 'soon gone' }));
      got(await deleteComment(w.db.orm, w.member, root.value.id));

      const result = await createComment(w.db.orm, w.member, w.issue.id, {
        body: 'late reply',
        parentId: root.value.id,
      });

      expect(result).toMatchObject({ ok: false, status: 409, code: 'comment_deleted' });
    });

    it('guest comments in own team', async () => {
      const w = await world('GCO');

      const result = await createComment(w.db.orm, w.guest, w.issue.id, { body: 'From a guest' });

      expect(got(result).value.authorId).toBe(w.guest.memberId);
    });

    it('guest outside team 404', async () => {
      const w = await world('GOT');
      await restrict(w.db, w.f, w.t.team.id, ['owner', 'admin', 'member'], false);
      const guest = await actorOf(w.db, w.f, 'guest');

      const result = await createComment(w.db.orm, guest, w.issue.id, { body: 'can I?' });

      expect(result).toMatchObject({ ok: false, status: 404, code: 'not_found' });
      expect(
        await w.db.orm.select().from(comment).where(eq(comment.issueId, w.issue.id)),
      ).toHaveLength(0);
    });

    it('private team not visible 404', async () => {
      const w = await world('PTN');
      await restrict(w.db, w.f, w.t.team.id, ['owner', 'member'], true);
      const admin = await actorOf(w.db, w.f, 'admin');
      const memberActor = await actorOf(w.db, w.f, 'member');

      const hidden = await createComment(w.db.orm, admin, w.issue.id, { body: 'peek' });
      const visible = await createComment(w.db.orm, memberActor, w.issue.id, { body: 'inside' });

      expect(hidden).toMatchObject({ ok: false, status: 404, code: 'not_found' });
      expect(visible.ok).toBe(true);
    });

    it('foreign workspace issue 404', async () => {
      const w = await world('FWI');
      const other = await world('FWJ');

      const result = await createComment(w.db.orm, w.member, other.issue.id, { body: 'across' });
      const malformed = await createComment(w.db.orm, w.member, 'not-an-id', { body: 'bad id' });

      expect(result).toMatchObject({ ok: false, status: 404, code: 'not_found' });
      expect(malformed).toMatchObject({ ok: false, status: 404, code: 'not_found' });
      expect(
        await w.db.orm.select().from(comment).where(eq(comment.issueId, other.issue.id)),
      ).toHaveLength(0);
    });

    it('archived issue 409', async () => {
      const w = await world('ARC');
      const root = got(await createComment(w.db.orm, w.member, w.issue.id, { body: 'before' }));
      got(await archiveIssue(w.db.orm, w.member, w.issue.id));

      const create = await createComment(w.db.orm, w.member, w.issue.id, { body: 'after' });
      const edit = await editComment(w.db.orm, w.member, root.value.id, { body: 'edited' });
      const remove = await deleteComment(w.db.orm, w.member, root.value.id);
      const resolve = await setResolved(w.db.orm, w.member, root.value.id, true);
      const react = await setReaction(w.db.orm, w.member, root.value.id, '👍', true);

      for (const result of [create, edit, remove, resolve, react]) {
        expect(result).toMatchObject({ ok: false, status: 409, code: 'issue_archived' });
      }
      // Reading stays open.
      expect(got(await listComments(w.db.orm, w.member, w.issue.id)).value.comments).toHaveLength(
        1,
      );
    });

    it('empty and oversize body 400', async () => {
      const w = await world('EOB');

      const empty = await createComment(w.db.orm, w.member, w.issue.id, { body: '   ' });
      const huge = await createComment(w.db.orm, w.member, w.issue.id, {
        body: 'x'.repeat(20_001),
      });
      const extra = await createComment(w.db.orm, w.member, w.issue.id, {
        body: 'ok',
        authorId: w.owner.memberId,
      } as never);

      for (const result of [empty, huge, extra]) {
        expect(result).toMatchObject({ ok: false, status: 400, code: 'invalid_input' });
      }
    });

    it('replay keeps one comment', async () => {
      const w = await world('RPL');
      const key = 'offline-queue-0001';

      const first = got(
        await createComment(
          w.db.orm,
          w.member,
          w.issue.id,
          { body: 'Sent twice' },
          { idempotencyKey: key },
        ),
      );
      const again = got(
        await createComment(
          w.db.orm,
          w.member,
          w.issue.id,
          { body: 'Sent twice' },
          { idempotencyKey: key },
        ),
      );
      const changed = await createComment(
        w.db.orm,
        w.member,
        w.issue.id,
        { body: 'Another text' },
        { idempotencyKey: key },
      );

      expect(again.replayed).toBe(true);
      expect(again.value.id).toBe(first.value.id);
      expect(again.txid).toBe(first.txid);
      expect(changed).toMatchObject({ ok: false, status: 422, code: 'idempotency_key_reused' });
      expect(
        await w.db.orm.select().from(comment).where(eq(comment.issueId, w.issue.id)),
      ).toHaveLength(1);
      const events = await w.db.orm.select().from(event).where(eq(event.type, 'comment.created'));
      expect(events.filter((row) => row.workspaceId === w.f.workspaceId)).toHaveLength(1);
    });

    it('a refused create does not keep its idempotency key', async () => {
      const w = await world('RFK');
      const key = 'refused-then-fixed';
      const refused = await createComment(
        w.db.orm,
        w.member,
        w.issue.id,
        { body: 'bad parent', parentId: '00000000-0000-4000-8000-00000000dead' },
        { idempotencyKey: key },
      );

      const retry = await createComment(
        w.db.orm,
        w.member,
        w.issue.id,
        { body: 'bad parent' },
        { idempotencyKey: key },
      );

      expect(refused.ok).toBe(false);
      expect(got(retry).replayed).toBe(false);
    });

    it('rollback leaves no comment and no event', async () => {
      const w = await world('RBK');
      const before = await updatedAtOf(w.db, w.issue.id);
      fault.failEvents = true;
      try {
        await expect(
          createComment(w.db.orm, w.member, w.issue.id, { body: 'never stored' }),
        ).rejects.toThrow('outbox is down');
      } finally {
        fault.failEvents = false;
      }

      expect(
        await w.db.orm.select().from(comment).where(eq(comment.issueId, w.issue.id)),
      ).toHaveLength(0);
      const events = await w.db.orm
        .select()
        .from(event)
        .where(eq(event.workspaceId, w.f.workspaceId));
      expect(events.filter((row) => row.type === 'comment.created')).toHaveLength(0);
      expect(await updatedAtOf(w.db, w.issue.id)).toBe(before);
    });

    it('event carries no text', async () => {
      const w = await world('EVT');
      const root = got(
        await createComment(w.db.orm, w.member, w.issue.id, { body: 'the secret plan' }),
      );
      const reply = got(
        await createComment(w.db.orm, w.admin, w.issue.id, {
          body: 'another secret',
          parentId: root.value.id,
        }),
      );

      const events = await w.db.orm
        .select()
        .from(event)
        .where(and(eq(event.workspaceId, w.f.workspaceId), eq(event.type, 'comment.created')))
        .orderBy(asc(event.occurredAt));

      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        version: 1,
        subjectType: 'comment',
        subjectId: root.value.id,
        teamId: w.t.team.id,
        actorId: w.member.memberId,
        client: 'web',
        data: {
          issueId: w.issue.id,
          identifier: `EVT-${w.issue.number}`,
          commentId: root.value.id,
          parentId: null,
        },
      });
      expect(events[1]?.data).toMatchObject({ commentId: reply.value.id, parentId: root.value.id });
      expect(JSON.stringify(events)).not.toContain('secret');
      const activity = await w.db.orm
        .select()
        .from(issueActivity)
        .where(eq(issueActivity.issueId, w.issue.id));
      expect(JSON.stringify(activity)).not.toContain('secret');
    });
  });

  describe('edit', () => {
    it('edit by author stores the previous body', async () => {
      const w = await world('EDA');
      const created = got(await createComment(w.db.orm, w.member, w.issue.id, { body: 'v1' }));
      const id = created.value.id;

      got(await editComment(w.db.orm, w.member, id, { body: 'v2' }));
      got(await editComment(w.db.orm, w.member, id, { body: ' v3 ' }));
      const unchanged = got(await editComment(w.db.orm, w.member, id, { body: 'v3' }));

      const stored = await rowOf(w.db, id);
      expect(stored.body).toBe('v3');
      expect(stored.editedAt).not.toBeNull();
      const edits = got(await listEdits(w.db.orm, w.admin, id));
      expect(edits.value.map((edit) => edit.body)).toEqual(['v1', 'v2']);
      expect(edits.value.every((edit) => edit.editedBy === w.member.memberId)).toBe(true);
      expect(typeof unchanged.txid).toBe('number');
      expect(
        await w.db.orm.select().from(commentEdit).where(eq(commentEdit.commentId, id)),
      ).toHaveLength(2);
    });

    it('a no-op edit stores nothing and leaves edited_at alone', async () => {
      const w = await world('EDN');
      const created = got(await createComment(w.db.orm, w.member, w.issue.id, { body: 'same' }));

      got(await editComment(w.db.orm, w.member, created.value.id, { body: 'same' }));

      expect((await rowOf(w.db, created.value.id)).editedAt).toBeNull();
      expect(
        await w.db.orm
          .select()
          .from(commentEdit)
          .where(eq(commentEdit.commentId, created.value.id)),
      ).toHaveLength(0);
    });

    it('edit by another person 403', async () => {
      const w = await world('EDO');
      const created = got(await createComment(w.db.orm, w.member, w.issue.id, { body: 'mine' }));

      const byAdmin = await editComment(w.db.orm, w.admin, created.value.id, { body: 'hijack' });
      const byOwner = await editComment(w.db.orm, w.owner, created.value.id, { body: 'hijack' });

      expect(byAdmin).toMatchObject({ ok: false, status: 403, code: 'forbidden' });
      expect(byOwner).toMatchObject({ ok: false, status: 403, code: 'forbidden' });
      expect((await rowOf(w.db, created.value.id)).body).toBe('mine');
    });

    it('edit refuses an empty body and a comment that does not exist', async () => {
      const w = await world('EDX');
      const created = got(await createComment(w.db.orm, w.member, w.issue.id, { body: 'keep' }));

      const empty = await editComment(w.db.orm, w.member, created.value.id, { body: ' ' });
      const unknown = await editComment(
        w.db.orm,
        w.member,
        '00000000-0000-4000-8000-00000000dead',
        {
          body: 'x',
        },
      );
      const malformed = await editComment(w.db.orm, w.member, 'nope', { body: 'x' });

      expect(empty).toMatchObject({ ok: false, status: 400 });
      expect(unknown).toMatchObject({ ok: false, status: 404 });
      expect(malformed).toMatchObject({ ok: false, status: 404 });
    });

    it('concurrent edits keep both', async () => {
      const w = await world('EDC');
      const created = got(await createComment(w.db.orm, w.member, w.issue.id, { body: 'v0' }));
      const id = created.value.id;

      const [a, b] = await Promise.all([
        editComment(w.db.orm, w.member, id, { body: 'edit A' }),
        editComment(w.db.orm, w.member, id, { body: 'edit B' }),
      ]);

      expect(a.ok && b.ok).toBe(true);
      const stored = await rowOf(w.db, id);
      expect(['edit A', 'edit B']).toContain(stored.body);
      const history = got(await listEdits(w.db.orm, w.member, id)).value.map((edit) => edit.body);
      const loser = stored.body === 'edit A' ? 'edit B' : 'edit A';
      expect(history).toEqual(['v0', loser]);
    });

    it('a deleted comment cannot be edited, reacted to or resolved: 409', async () => {
      const w = await world('EDD');
      const created = got(
        await createComment(w.db.orm, w.member, w.issue.id, { body: 'gone soon' }),
      );
      got(await deleteComment(w.db.orm, w.member, created.value.id));

      const edit = await editComment(w.db.orm, w.member, created.value.id, { body: 'revive' });
      const react = await setReaction(w.db.orm, w.admin, created.value.id, '👍', true);
      const resolve = await setResolved(w.db.orm, w.admin, created.value.id, true);

      for (const result of [edit, react, resolve]) {
        expect(result).toMatchObject({ ok: false, status: 409, code: 'comment_deleted' });
      }
    });
  });

  describe('resolve and react', () => {
    it('resolve and unresolve thread root', async () => {
      const w = await world('RSV');
      const root = got(await createComment(w.db.orm, w.member, w.issue.id, { body: 'question' }));

      got(await setResolved(w.db.orm, w.guest, root.value.id, true));
      const resolved = await rowOf(w.db, root.value.id);
      got(await setResolved(w.db.orm, w.guest, root.value.id, true));
      got(await setResolved(w.db.orm, w.admin, root.value.id, false));
      const reopened = await rowOf(w.db, root.value.id);

      expect(resolved.resolvedAt).not.toBeNull();
      expect(resolved.resolvedBy).toBe(w.guest.memberId);
      expect(reopened.resolvedAt).toBeNull();
      expect(reopened.resolvedBy).toBeNull();
    });

    it('resolve a reply refused', async () => {
      const w = await world('RSR');
      const root = got(await createComment(w.db.orm, w.member, w.issue.id, { body: 'question' }));
      const reply = got(
        await createComment(w.db.orm, w.member, w.issue.id, {
          body: 'answer',
          parentId: root.value.id,
        }),
      );

      const result = await setResolved(w.db.orm, w.member, reply.value.id, true);

      expect(result).toMatchObject({ ok: false, status: 422 });
      expect((await rowOf(w.db, reply.value.id)).resolvedAt).toBeNull();
    });

    it('react toggles per person', async () => {
      const w = await world('RCT');
      const created = got(await createComment(w.db.orm, w.member, w.issue.id, { body: 'nice' }));
      const id = created.value.id;

      got(await setReaction(w.db.orm, w.member, id, '🎉', true));
      got(await setReaction(w.db.orm, w.member, id, '🎉', true));
      expect((await rowOf(w.db, id)).reactions).toEqual({ '🎉': [w.member.memberId] });
      got(await setReaction(w.db.orm, w.guest, id, '🎉', true));
      got(await setReaction(w.db.orm, w.guest, id, '👀', true));
      const both = (await rowOf(w.db, id)).reactions;
      got(await setReaction(w.db.orm, w.member, id, '🎉', false));
      got(await setReaction(w.db.orm, w.member, id, '🎉', false));
      got(await setReaction(w.db.orm, w.guest, id, '🎉', false));
      const after = (await rowOf(w.db, id)).reactions;

      expect([...(both['🎉'] ?? [])].sort()).toEqual([w.guest.memberId, w.member.memberId].sort());
      expect(both['👀']).toEqual([w.guest.memberId]);
      expect(after).toEqual({ '👀': [w.guest.memberId] });
      const outside = await setReaction(w.db.orm, w.member, id, '🔥', true);
      expect(outside).toMatchObject({ ok: false, status: 400, code: 'invalid_input' });
    });

    it('parallel reactions of 20 people all land', async () => {
      const w = await world('PAR');
      const created = got(
        await createComment(w.db.orm, w.member, w.issue.id, { body: 'react please' }),
      );
      const people = [w.owner, w.admin, w.member, w.guest];
      for (let i = 0; i < 16; i++) {
        const added = await addMember(w.db.orm, w.f.workspaceId, 'member', {
          teamIds: [w.t.team.id],
        });
        const actor = await loadClientActor(w.db.orm, w.f.workspaceId, added.id, 'web');
        if (!actor) throw new Error('no actor for the new member');
        people.push(actor);
      }
      expect(people).toHaveLength(20);

      const results = await Promise.all(
        people.map((person, index) =>
          setReaction(w.db.orm, person, created.value.id, REACTION_EMOJI[index % 2] ?? '👍', true),
        ),
      );

      expect(results.every((result) => result.ok)).toBe(true);
      const reactions = (await rowOf(w.db, created.value.id)).reactions;
      const landed = Object.values(reactions).flat();
      expect(landed).toHaveLength(20);
      expect(new Set(landed).size).toBe(20);
    });
  });

  describe('delete', () => {
    it('delete tombstone', async () => {
      const w = await world('DEL');
      const root = got(
        await createComment(w.db.orm, w.member, w.issue.id, { body: 'my private token 123' }),
      );
      const reply = got(
        await createComment(w.db.orm, w.admin, w.issue.id, {
          body: 'a reply that stays',
          parentId: root.value.id,
        }),
      );
      got(await editComment(w.db.orm, w.member, root.value.id, { body: 'my private token 456' }));
      got(await setReaction(w.db.orm, w.admin, root.value.id, '👍', true));

      got(await deleteComment(w.db.orm, w.member, root.value.id));
      got(await deleteComment(w.db.orm, w.member, root.value.id));

      const stored = await rowOf(w.db, root.value.id);
      expect(stored.body).toBe('');
      expect(stored.deletedAt).not.toBeNull();
      expect(stored.reactions).toEqual({});
      expect(
        await w.db.orm.select().from(commentEdit).where(eq(commentEdit.commentId, root.value.id)),
      ).toHaveLength(0);
      expect((await rowOf(w.db, reply.value.id)).body).toBe('a reply that stays');
      const listed = got(await listComments(w.db.orm, w.guest, w.issue.id)).value.comments;
      expect(listed.map((row) => [row.id, row.deleted, row.body])).toEqual([
        [root.value.id, true, ''],
        [reply.value.id, false, 'a reply that stays'],
      ]);
      expect(got(await listEdits(w.db.orm, w.guest, root.value.id)).value).toEqual([]);
      const events = await w.db.orm
        .select()
        .from(event)
        .where(eq(event.workspaceId, w.f.workspaceId));
      const activity = await w.db.orm
        .select()
        .from(issueActivity)
        .where(eq(issueActivity.issueId, w.issue.id));
      expect(JSON.stringify([events, activity])).not.toContain('private token');
    });

    it('delete by admin, refused for another member', async () => {
      const w = await world('DAM');
      const created = got(
        await createComment(w.db.orm, w.member, w.issue.id, { body: 'delete me' }),
      );
      const other = got(await createComment(w.db.orm, w.guest, w.issue.id, { body: 'not yours' }));

      const refused = await deleteComment(w.db.orm, w.member, other.value.id);
      const byGuest = await deleteComment(w.db.orm, w.guest, created.value.id);
      const byAdmin = await deleteComment(w.db.orm, w.admin, created.value.id);
      const byOwner = await deleteComment(w.db.orm, w.owner, other.value.id);

      expect(refused).toMatchObject({ ok: false, status: 403, code: 'forbidden' });
      expect(byGuest).toMatchObject({ ok: false, status: 403, code: 'forbidden' });
      expect(byAdmin.ok).toBe(true);
      expect(byOwner.ok).toBe(true);
      expect((await rowOf(w.db, created.value.id)).deletedAt).not.toBeNull();
    });

    it('an admin outside a private team cannot delete there: 404', async () => {
      const w = await world('DPT');
      const created = got(await createComment(w.db.orm, w.member, w.issue.id, { body: 'inside' }));
      await restrict(w.db, w.f, w.t.team.id, ['owner', 'member'], true);
      const admin = await actorOf(w.db, w.f, 'admin');

      const result = await deleteComment(w.db.orm, admin, created.value.id);

      expect(result).toMatchObject({ ok: false, status: 404 });
      expect((await rowOf(w.db, created.value.id)).deletedAt).toBeNull();
    });
  });

  describe('read', () => {
    it('list order and tombstones', async () => {
      const w = await world('LST');
      const first = got(await createComment(w.db.orm, w.member, w.issue.id, { body: 'one' }));
      const second = got(await createComment(w.db.orm, w.guest, w.issue.id, { body: 'two' }));
      const third = got(
        await createComment(w.db.orm, w.admin, w.issue.id, {
          body: 'three',
          parentId: first.value.id,
        }),
      );
      got(await deleteComment(w.db.orm, w.guest, second.value.id));

      const listed = got(await listComments(w.db.orm, w.owner, w.issue.id)).value.comments;

      expect(listed.map((row) => row.id)).toEqual([
        first.value.id,
        second.value.id,
        third.value.id,
      ]);
      expect(listed[1]).toMatchObject({ deleted: true, body: '' });
      expect(listed[2]).toMatchObject({ parentId: first.value.id, deleted: false });
    });

    it('history cap keeps the newest 50', async () => {
      const w = await world('CAP');
      const created = got(await createComment(w.db.orm, w.member, w.issue.id, { body: 'v0' }));
      const id = created.value.id;

      for (let i = 1; i <= 55; i++) {
        got(await editComment(w.db.orm, w.member, id, { body: `v${i}` }));
      }

      // Edit i stores the text it replaced (v(i-1)): the newest 50 of 55 are v5 to v54, oldest first.
      const history = got(await listEdits(w.db.orm, w.member, id)).value;
      expect(history).toHaveLength(50);
      expect(history[0]?.body).toBe('v5');
      expect(history[49]?.body).toBe('v54');
      expect(
        await w.db.orm.select().from(commentEdit).where(eq(commentEdit.commentId, id)),
      ).toHaveLength(50);
    });

    it('the history read is capped at 50 even when more rows are stored', async () => {
      const w = await world('HRC');
      const created = got(await createComment(w.db.orm, w.member, w.issue.id, { body: 'now' }));
      const id = created.value.id;
      const base = Date.now() - 100_000;
      await w.db.orm.insert(commentEdit).values(
        Array.from({ length: 70 }, (_, i) => ({
          workspaceId: w.f.workspaceId,
          teamId: w.t.team.id,
          issueId: w.issue.id,
          commentId: id,
          body: `old ${i}`,
          editedBy: w.member.memberId,
          createdAt: new Date(base + i * 1000),
        })),
      );

      const history = got(await listEdits(w.db.orm, w.owner, id)).value;

      expect(history).toHaveLength(50);
      expect(history[0]?.body).toBe('old 20');
      expect(history[49]?.body).toBe('old 69');
    });

    it('the cap is per comment: another comment keeps its own history', async () => {
      const w = await world('CAQ');
      const a = got(await createComment(w.db.orm, w.member, w.issue.id, { body: 'a0' }));
      const b = got(await createComment(w.db.orm, w.member, w.issue.id, { body: 'b0' }));
      got(await editComment(w.db.orm, w.member, b.value.id, { body: 'b1' }));

      for (let i = 1; i <= 52; i++) {
        got(await editComment(w.db.orm, w.member, a.value.id, { body: `a${i}` }));
      }

      expect(got(await listEdits(w.db.orm, w.member, a.value.id)).value).toHaveLength(50);
      expect(
        got(await listEdits(w.db.orm, w.member, b.value.id)).value.map((edit) => edit.body),
      ).toEqual(['b0']);
    });

    it('the list pages with limit and cursor, in order, and the last page has no cursor', async () => {
      const w = await world('PGE');
      const ids: string[] = [];
      for (let i = 0; i < 7; i++) {
        const made = got(await createComment(w.db.orm, w.member, w.issue.id, { body: `c${i}` }));
        ids.push(made.value.id);
      }

      const seen: string[] = [];
      const sizes: number[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 5; page++) {
        const result = got(
          await listComments(w.db.orm, w.guest, w.issue.id, { limit: 3, cursor }),
        ).value;
        seen.push(...result.comments.map((row) => row.id));
        sizes.push(result.comments.length);
        if (!result.nextCursor) break;
        cursor = result.nextCursor;
      }

      expect(seen).toEqual(ids);
      expect(sizes).toEqual([3, 3, 1]);
    });

    it('without a limit the list holds the first 50, with a cursor for the rest', async () => {
      const w = await world('PG5');
      const base = Date.now() - 200_000;
      await w.db.orm.insert(comment).values(
        Array.from({ length: 60 }, (_, i) => ({
          workspaceId: w.f.workspaceId,
          teamId: w.t.team.id,
          issueId: w.issue.id,
          authorId: w.member.memberId,
          body: `bulk ${i}`,
          createdAt: new Date(base + i * 1000),
        })),
      );

      const first = got(await listComments(w.db.orm, w.member, w.issue.id)).value;
      const second = got(
        await listComments(w.db.orm, w.member, w.issue.id, { cursor: first.nextCursor ?? '' }),
      ).value;

      expect(first.comments).toHaveLength(50);
      expect(first.comments[0]?.body).toBe('bulk 0');
      expect(first.nextCursor).not.toBeNull();
      expect(second.comments.map((row) => row.body)).toEqual(
        Array.from({ length: 10 }, (_, i) => `bulk ${50 + i}`),
      );
      expect(second.nextCursor).toBeNull();
    });

    it('a limit outside 1 to 100 and a cursor that is not ours answer 400', async () => {
      const w = await world('PGB');

      for (const limit of [0, 101, -1, 1.5, Number.NaN]) {
        const result = await listComments(w.db.orm, w.member, w.issue.id, { limit });
        expect(result, String(limit)).toMatchObject({
          ok: false,
          status: 400,
          code: 'invalid_input',
        });
      }
      for (const cursor of [
        'nope!',
        'aGVsbG8',
        Buffer.from('2026-01-01|x').toString('base64url'),
      ]) {
        const result = await listComments(w.db.orm, w.member, w.issue.id, { cursor });
        expect(result, cursor).toMatchObject({ ok: false, status: 400, code: 'invalid_input' });
      }
    });

    it('history needs sight of the issue', async () => {
      const w = await world('HIS');
      const created = got(await createComment(w.db.orm, w.member, w.issue.id, { body: 'v1' }));
      got(await editComment(w.db.orm, w.member, created.value.id, { body: 'v2' }));
      await restrict(w.db, w.f, w.t.team.id, ['owner', 'member'], true);
      const admin = await actorOf(w.db, w.f, 'admin');
      const guest = await actorOf(w.db, w.f, 'guest');
      const stranger = await world('HI2');

      const hidden = await listEdits(w.db.orm, admin, created.value.id);
      const hiddenList = await listComments(w.db.orm, guest, w.issue.id);
      const foreign = await listEdits(stranger.db.orm, stranger.member, created.value.id);
      const unknown = await listEdits(w.db.orm, w.member, '00000000-0000-4000-8000-00000000dead');

      for (const result of [hidden, hiddenList, foreign, unknown]) {
        expect(result).toMatchObject({ ok: false, status: 404, code: 'not_found' });
      }
      expect(got(await listEdits(w.db.orm, w.owner, created.value.id)).value).toHaveLength(1);
    });
  });

  describe('the issue moves with every write', () => {
    it('add, edit, resolve, react and delete bump the issue updated_at in the same transaction', async () => {
      const w = await world('BMP');
      const stamps = [await updatedAtOf(w.db, w.issue.id)];
      const record = async () => {
        stamps.push(await updatedAtOf(w.db, w.issue.id));
      };

      const root = got(await createComment(w.db.orm, w.member, w.issue.id, { body: 'one' }));
      await record();
      got(
        await createComment(w.db.orm, w.member, w.issue.id, {
          body: 'two',
          parentId: root.value.id,
        }),
      );
      await record();
      got(await editComment(w.db.orm, w.member, root.value.id, { body: 'one, edited' }));
      await record();
      got(await setResolved(w.db.orm, w.admin, root.value.id, true));
      await record();
      got(await setReaction(w.db.orm, w.guest, root.value.id, '👍', true));
      await record();
      got(await deleteComment(w.db.orm, w.member, root.value.id));
      await record();

      for (let i = 1; i < stamps.length; i++) {
        expect(stamps[i], `step ${i}`).toBeGreaterThan(stamps[i - 1] ?? 0);
      }
    });

    it('a call that changes nothing leaves updated_at alone', async () => {
      const w = await world('NOP');
      const root = got(await createComment(w.db.orm, w.member, w.issue.id, { body: 'same' }));
      got(await setReaction(w.db.orm, w.guest, root.value.id, '👍', true));
      const before = await updatedAtOf(w.db, w.issue.id);

      got(await editComment(w.db.orm, w.member, root.value.id, { body: 'same' }));
      got(await setReaction(w.db.orm, w.guest, root.value.id, '👍', true));
      got(await setResolved(w.db.orm, w.admin, root.value.id, false));

      expect(await updatedAtOf(w.db, w.issue.id)).toBe(before);
    });

    it('a refused write leaves updated_at alone', async () => {
      const w = await world('REF');
      const root = got(await createComment(w.db.orm, w.member, w.issue.id, { body: 'mine' }));
      const before = await updatedAtOf(w.db, w.issue.id);

      await editComment(w.db.orm, w.admin, root.value.id, { body: 'hijack' });
      await createComment(w.db.orm, w.member, w.issue.id, {
        body: 'x',
        parentId: '00000000-0000-4000-8000-00000000dead',
      });

      expect(await updatedAtOf(w.db, w.issue.id)).toBe(before);
    });
  });
});
