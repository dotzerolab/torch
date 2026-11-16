import { event, issue, issueActivity, issueLink, issueRelation } from '@torch/shared/db/schema';
import { asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { Db } from '../db.ts';
import { createWorkspaceFixture } from '../test/fixtures.ts';
import { actorOf, freshTeam, makeIssue } from '../test/issue-helpers.ts';
import { useSharedDatabase } from '../test/shared-database.ts';
import { archiveIssue } from './archive.ts';
import { addLink, removeLink } from './links.ts';
import { addRelation, listRelations, removeRelation } from './relations.ts';
import { addSubscriber, removeSubscriber } from './subscribers.ts';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.warn(
    '[issues/join-rows.test] SKIPPED: DATABASE_URL is not set. ' +
      'Start `docker compose -f docker-compose.dev.yml up -d --wait postgres` and set DATABASE_URL (see .env.example).',
  );
}

describe.skipIf(!databaseUrl)('issue relations, subscribers and links', () => {
  const getDb = useSharedDatabase();

  const activityOf = (db: Db, id: string) =>
    db.orm
      .select()
      .from(issueActivity)
      .where(eq(issueActivity.issueId, id))
      .orderBy(asc(issueActivity.createdAt));
  const eventsOf = (db: Db, id: string) =>
    db.orm.select().from(event).where(eq(event.subjectId, id)).orderBy(asc(event.occurredAt));
  const updatedAtOf = async (db: Db, id: string) => {
    const [row] = await db.orm.select().from(issue).where(eq(issue.id, id));
    if (!row) throw new Error('issue vanished');
    return row.updatedAt.getTime();
  };

  async function world(key: string) {
    const db = getDb();
    const f = await createWorkspaceFixture(db.orm);
    const t = await freshTeam(db, f, key);
    return {
      db,
      f,
      t,
      owner: await actorOf(db, f, 'owner'),
      admin: await actorOf(db, f, 'admin'),
      member: await actorOf(db, f, 'member'),
      guest: await actorOf(db, f, 'guest'),
      a: await makeIssue(db, f, t.team.id, 'First'),
      b: await makeIssue(db, f, t.team.id, 'Second'),
    };
  }

  describe('relations', () => {
    it('blocked_by is stored as blocks from the other end, and read back as blocked_by', async () => {
      const w = await world('RLB');
      const added = await addRelation(w.db.orm, w.member, w.a.id, {
        relatedIssueId: w.b.id,
        type: 'blocked_by',
      });
      expect(added.ok).toBe(true);
      if (!added.ok) return;
      expect(added.value).toMatchObject({ type: 'blocked_by', issueId: w.b.id });

      const [row] = await w.db.orm
        .select()
        .from(issueRelation)
        .where(eq(issueRelation.id, added.value.id));
      expect(row).toMatchObject({
        issueId: w.b.id,
        relatedIssueId: w.a.id,
        type: 'blocks',
        teamId: w.t.team.id,
        relatedTeamId: w.t.team.id,
      });

      const fromA = await listRelations(w.db.orm, w.member, w.a.id);
      const fromB = await listRelations(w.db.orm, w.member, w.b.id);
      expect(fromA.ok && fromA.relations).toMatchObject([{ type: 'blocked_by', issueId: w.b.id }]);
      expect(fromB.ok && fromB.relations).toMatchObject([{ type: 'blocks', issueId: w.a.id }]);
    });

    it('a repeated relation is 409 relation_exists; related and duplicate also count from the other end', async () => {
      const w = await world('RLD');
      const first = await addRelation(w.db.orm, w.member, w.a.id, {
        relatedIssueId: w.b.id,
        type: 'blocks',
      });
      expect(first.ok).toBe(true);
      const again = await addRelation(w.db.orm, w.member, w.a.id, {
        relatedIssueId: w.b.id,
        type: 'blocks',
      });
      expect(again).toMatchObject({ ok: false, status: 409, code: 'relation_exists' });
      // The same pair as blocked_by from the other end is the same row.
      const sameRow = await addRelation(w.db.orm, w.member, w.b.id, {
        relatedIssueId: w.a.id,
        type: 'blocked_by',
      });
      expect(sameRow).toMatchObject({ ok: false, status: 409, code: 'relation_exists' });

      for (const type of ['related', 'duplicate'] as const) {
        const one = await addRelation(w.db.orm, w.member, w.a.id, {
          relatedIssueId: w.b.id,
          type,
        });
        expect(one.ok, type).toBe(true);
        const reversed = await addRelation(w.db.orm, w.member, w.b.id, {
          relatedIssueId: w.a.id,
          type,
        });
        expect(reversed, type).toMatchObject({ ok: false, status: 409, code: 'relation_exists' });
      }
    });

    it('related is stored once with the lower id first, whichever end it was added from', async () => {
      const w = await world('RLO');
      const [low, high] = [w.a.id, w.b.id].sort();
      if (!low || !high) throw new Error('two issues expected');
      // Added from the higher id: still stored as low -> high; the same pair from the lower id is the same row.
      const added = await addRelation(w.db.orm, w.member, high, {
        relatedIssueId: low,
        type: 'related',
      });
      expect(added.ok).toBe(true);
      if (!added.ok) return;
      const [row] = await w.db.orm
        .select()
        .from(issueRelation)
        .where(eq(issueRelation.id, added.value.id));
      expect(row).toMatchObject({ issueId: low, relatedIssueId: high, type: 'related' });
      const again = await addRelation(w.db.orm, w.member, low, {
        relatedIssueId: high,
        type: 'related',
      });
      expect(again).toMatchObject({ ok: false, status: 409, code: 'relation_exists' });
      // Both ends read it back as `related`, pointing at the other one.
      expect((await listRelations(w.db.orm, w.member, high)).ok).toBe(true);
      const fromHigh = await listRelations(w.db.orm, w.member, high);
      const fromLow = await listRelations(w.db.orm, w.member, low);
      if (!fromHigh.ok || !fromLow.ok) throw new Error('relations expected');
      expect(fromHigh.relations).toMatchObject([{ type: 'related', issueId: low }]);
      expect(fromLow.relations).toMatchObject([{ type: 'related', issueId: high }]);
    });

    it('an issue related to itself is 422 invalid_reference; a missing or hidden other issue is 404', async () => {
      const w = await world('RLS');
      const self = await addRelation(w.db.orm, w.member, w.a.id, {
        relatedIssueId: w.a.id,
        type: 'related',
      });
      expect(self).toMatchObject({
        ok: false,
        status: 422,
        code: 'invalid_reference',
        details: { field: 'relatedIssueId' },
      });

      const unknown = await addRelation(w.db.orm, w.member, w.a.id, {
        relatedIssueId: crypto.randomUUID(),
        type: 'related',
      });
      expect(unknown).toMatchObject({ ok: false, status: 404 });

      const hidden = w.f.issues.ops[0];
      if (!hidden) throw new Error('no OPS issue');
      // The guest is in neither the private team nor allowed to see it.
      const refused = await addRelation(w.db.orm, w.guest, w.a.id, {
        relatedIssueId: hidden.id,
        type: 'related',
      });
      expect(refused).toMatchObject({ ok: false, status: 404 });
      const rows = await w.db.orm.select().from(issueRelation);
      expect(rows.filter((row) => row.issueId === w.a.id)).toHaveLength(0);
    });

    it('a hidden end is an id only: no identifier, no title', async () => {
      const w = await world('RLH');
      const hidden = w.f.issues.ops[0];
      if (!hidden) throw new Error('no OPS issue');
      // The owner can see both teams and relates the two issues.
      const added = await addRelation(w.db.orm, w.owner, w.a.id, {
        relatedIssueId: hidden.id,
        type: 'related',
      });
      expect(added.ok).toBe(true);

      const asAdmin = await listRelations(w.db.orm, w.admin, w.a.id);
      expect(asAdmin.ok).toBe(true);
      if (!asAdmin.ok) return;
      expect(asAdmin.relations).toHaveLength(1);
      const seen = asAdmin.relations[0];
      expect(seen).toMatchObject({ issueId: hidden.id, type: 'related' });
      expect(seen && 'issue' in seen).toBe(false);
      expect(JSON.stringify(asAdmin.relations)).not.toContain(hidden.title);

      const asOwner = await listRelations(w.db.orm, w.owner, w.a.id);
      expect(asOwner.ok && asOwner.relations[0]?.issue).toEqual({
        identifier: `OPS-${hidden.number}`,
        title: hidden.title,
      });
    });

    it('records activity and one issue.updated event on the path issue only, and moves updated_at', async () => {
      const w = await world('RLA');
      const before = await updatedAtOf(w.db, w.a.id);
      const added = await addRelation(w.db.orm, w.member, w.a.id, {
        relatedIssueId: w.b.id,
        type: 'blocks',
      });
      expect(added.ok).toBe(true);
      if (!added.ok) return;
      expect(await updatedAtOf(w.db, w.a.id)).toBeGreaterThan(before);

      const activity = (await activityOf(w.db, w.a.id)).filter((row) =>
        row.type.startsWith('issue.relation_'),
      );
      expect(activity).toHaveLength(1);
      expect(activity[0]).toMatchObject({
        type: 'issue.relation_added',
        field: 'relations',
        actorId: w.member.memberId,
        client: 'web',
      });
      const events = (await eventsOf(w.db, w.a.id)).filter((row) => row.type === 'issue.updated');
      expect(events).toHaveLength(1);
      expect(
        (await activityOf(w.db, w.b.id)).filter((r) => r.type.startsWith('issue.relation')),
      ).toHaveLength(0);

      const removed = await removeRelation(w.db.orm, w.member, w.a.id, added.value.id);
      expect(removed.ok).toBe(true);
      const after = (await activityOf(w.db, w.a.id)).filter((row) =>
        row.type.startsWith('issue.relation_'),
      );
      expect(after.map((row) => row.type)).toEqual([
        'issue.relation_added',
        'issue.relation_removed',
      ]);
      const gone = await removeRelation(w.db.orm, w.member, w.a.id, added.value.id);
      expect(gone).toMatchObject({ ok: false, status: 404 });
    });

    it('an archived issue refuses relation changes with 409 issue_archived', async () => {
      const w = await world('RLX');
      await archiveIssue(w.db.orm, w.owner, w.a.id);
      const result = await addRelation(w.db.orm, w.member, w.a.id, {
        relatedIssueId: w.b.id,
        type: 'related',
      });
      expect(result).toMatchObject({ ok: false, status: 409, code: 'issue_archived' });
    });
  });

  describe('subscribers', () => {
    it('a member subscribes themselves and doing it twice records nothing more', async () => {
      const w = await world('SBS');
      const first = await addSubscriber(w.db.orm, w.member, w.a.id, w.member.memberId);
      expect(first.ok).toBe(true);
      const afterFirst = await updatedAtOf(w.db, w.a.id);
      const second = await addSubscriber(w.db.orm, w.member, w.a.id, w.member.memberId);
      expect(second.ok).toBe(true);
      expect(await updatedAtOf(w.db, w.a.id)).toBe(afterFirst);

      const rows = (await activityOf(w.db, w.a.id)).filter(
        (row) => row.type === 'issue.subscriber_added',
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ toValue: { memberId: w.member.memberId } });
      const events = (await eventsOf(w.db, w.a.id)).filter(
        (row) => row.type === 'issue.updated' && JSON.stringify(row.data).includes('subscribers'),
      );
      expect(events).toHaveLength(1);
    });

    it('unsubscribing records once; removing a non-subscriber is a no-op', async () => {
      const w = await world('SBU');
      await addSubscriber(w.db.orm, w.member, w.a.id, w.member.memberId);
      const removed = await removeSubscriber(w.db.orm, w.member, w.a.id, w.member.memberId);
      expect(removed.ok).toBe(true);
      const again = await removeSubscriber(w.db.orm, w.member, w.a.id, w.member.memberId);
      expect(again.ok).toBe(true);
      const types = (await activityOf(w.db, w.a.id))
        .map((row) => row.type)
        .filter((type) => type.startsWith('issue.subscriber_'));
      expect(types).toEqual(['issue.subscriber_added', 'issue.subscriber_removed']);
    });

    it('adding another member needs the right to edit the issue and a member who can see it', async () => {
      const w = await world('SBO');
      const added = await addSubscriber(w.db.orm, w.member, w.a.id, w.admin.memberId);
      expect(added.ok).toBe(true);
      // A member of no team cannot open a private team's issue, so cannot follow it.
      const opsIssue = w.f.issues.ops[0];
      if (!opsIssue) throw new Error('no OPS issue');
      const outsider = await actorOf(w.db, w.f, 'outsider');
      const hiddenFor = await addSubscriber(w.db.orm, w.owner, opsIssue.id, outsider.memberId);
      expect(hiddenFor).toMatchObject({
        ok: false,
        status: 422,
        code: 'invalid_reference',
        details: { field: 'memberId' },
      });
    });

    it('a member id that does not exist in the workspace is 404', async () => {
      const w = await world('SBN');
      const unknown = await addSubscriber(w.db.orm, w.member, w.a.id, crypto.randomUUID());
      expect(unknown).toMatchObject({ ok: false, status: 404, code: 'not_found' });
      const gone = await removeSubscriber(w.db.orm, w.member, w.a.id, crypto.randomUUID());
      expect(gone).toMatchObject({ ok: false, status: 404, code: 'not_found' });
    });

    it('a guest cannot subscribe a member they share no team with', async () => {
      const w = await world('SBG');
      const outsider = await actorOf(w.db, w.f, 'outsider');
      const refused = await addSubscriber(w.db.orm, w.guest, w.a.id, outsider.memberId);
      expect(refused).toMatchObject({
        ok: false,
        status: 422,
        code: 'invalid_reference',
        details: { field: 'memberId' },
      });
      // A co-member is fine, and the guest can follow the issue themself.
      expect((await addSubscriber(w.db.orm, w.guest, w.a.id, w.member.memberId)).ok).toBe(true);
      expect((await addSubscriber(w.db.orm, w.guest, w.a.id, w.guest.memberId)).ok).toBe(true);
    });

    it('a subscription on an unseen issue is 404 and on an archived issue 409', async () => {
      const w = await world('SBX');
      const opsIssue = w.f.issues.ops[0];
      if (!opsIssue) throw new Error('no OPS issue');
      const unseen = await addSubscriber(w.db.orm, w.guest, opsIssue.id, w.guest.memberId);
      expect(unseen).toMatchObject({ ok: false, status: 404 });
      await archiveIssue(w.db.orm, w.owner, w.a.id);
      const archived = await addSubscriber(w.db.orm, w.member, w.a.id, w.member.memberId);
      expect(archived).toMatchObject({ ok: false, status: 409, code: 'issue_archived' });
    });
  });

  describe('links', () => {
    it('adds and removes an https link with activity and an event each', async () => {
      const w = await world('LNK');
      const added = await addLink(w.db.orm, w.member, w.a.id, {
        url: 'https://example.test/pull/1',
        title: 'Change',
      });
      expect(added.ok).toBe(true);
      if (!added.ok) return;
      expect(added.value).toMatchObject({ url: 'https://example.test/pull/1', title: 'Change' });
      const removed = await removeLink(w.db.orm, w.member, w.a.id, added.value.id);
      expect(removed.ok).toBe(true);
      expect(await w.db.orm.select().from(issueLink).where(eq(issueLink.issueId, w.a.id))).toEqual(
        [],
      );

      const types = (await activityOf(w.db, w.a.id))
        .map((row) => row.type)
        .filter((type) => type.startsWith('issue.link_'));
      expect(types).toEqual(['issue.link_added', 'issue.link_removed']);
      const events = (await eventsOf(w.db, w.a.id)).filter((row) =>
        JSON.stringify(row.data).includes('"links"'),
      );
      expect(events).toHaveLength(2);
      expect(await removeLink(w.db.orm, w.member, w.a.id, added.value.id)).toMatchObject({
        ok: false,
        status: 404,
      });
    });

    it('only http and https are accepted: javascript:, data: and ftp: are 400 invalid_input', async () => {
      const w = await world('LNS');
      for (const url of ['javascript:alert(1)', 'data:text/html,hi', 'ftp://example.test/file']) {
        const result = await addLink(w.db.orm, w.member, w.a.id, { url });
        expect(result, url).toMatchObject({ ok: false, status: 400, code: 'invalid_input' });
      }
      expect(await w.db.orm.select().from(issueLink).where(eq(issueLink.issueId, w.a.id))).toEqual(
        [],
      );
    });

    it('a link on an archived issue is 409', async () => {
      const w = await world('LNA');
      await archiveIssue(w.db.orm, w.owner, w.a.id);
      const result = await addLink(w.db.orm, w.member, w.a.id, { url: 'https://example.test/x' });
      expect(result).toMatchObject({ ok: false, status: 409, code: 'issue_archived' });
    });
  });
});
