import { createHash, randomBytes } from 'node:crypto';
import {
  auditLog,
  invite,
  inviteTeam,
  member,
  session,
  teamMember,
  workspace,
} from '@torch/shared/db/schema';
import type { InviteCreateInput } from '@torch/shared/mutations/admin';
import type { Actor } from '@torch/shared/permissions';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createSessionsForMembers, listSessionWorkspaces } from '../auth/sessions.ts';
import { generateToken, hashToken } from '../auth/tokens.ts';
import type { Db } from '../db.ts';
import { loadActor } from '../permissions/load-actor.ts';
import { addMember, createWorkspaceFixture } from '../test/fixtures.ts';
import { useSharedDatabase } from '../test/shared-database.ts';
import type { ServiceResult } from '../util/result.ts';
import {
  acceptInvite,
  createInvite,
  listInvites,
  previewInvite,
  resendInvite,
  revokeInvite,
} from './service.ts';

const databaseUrl = process.env.DATABASE_URL;

// Integration: needs the dev compose Postgres (see db.test.ts). Skipped, loudly, when DATABASE_URL is not set.
if (!databaseUrl) {
  console.warn(
    '[invites/service.test] SKIPPED the invite service tests: DATABASE_URL is not set. ' +
      'Start `docker compose -f docker-compose.dev.yml up -d --wait postgres` and set DATABASE_URL (see .env.example).',
  );
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const unique = () => randomBytes(4).toString('hex');

/** The value of an answer that must have succeeded. */
function value<T>(result: ServiceResult<T>): T {
  if (!result.ok) throw new Error(`refused: ${result.code} (${result.status})`);
  return result.value;
}

function refusal<T>(result: ServiceResult<T>) {
  if (result.ok) throw new Error('expected a refusal');
  return { code: result.code, status: result.status };
}

const input = (over: Partial<InviteCreateInput> = {}): InviteCreateInput => ({
  email: `new-${unique()}@example.test`,
  role: 'member',
  teamIds: [],
  ...over,
});

describe.skipIf(!databaseUrl)('invite service (Postgres)', () => {
  const getDb = useSharedDatabase();

  async function setup() {
    const db = getDb();
    const f = await createWorkspaceFixture(db.orm);
    const actorOf = async (role: 'owner' | 'admin' | 'member' | 'guest'): Promise<Actor> => {
      const loaded = await loadActor(db.orm, f.workspaceId, f.members[role].id);
      if (!loaded) throw new Error(`no actor for ${role}`);
      return loaded;
    };
    return {
      db,
      f,
      owner: await actorOf('owner'),
      admin: await actorOf('admin'),
      member: await actorOf('member'),
      guest: await actorOf('guest'),
    };
  }

  async function inviteRow(db: Db, inviteId: string) {
    const [row] = await db.orm.select().from(invite).where(eq(invite.id, inviteId));
    if (!row) throw new Error('invite row missing');
    return row;
  }

  /** Inserts pending (or otherwise shaped) invite rows directly, for the limit tests. */
  async function insertInvites(
    db: Db,
    workspaceId: string,
    invitedBy: string,
    count: number,
    opts: { createdAt: Date; expiresAt: Date },
  ) {
    await db.orm.insert(invite).values(
      Array.from({ length: count }, () => ({
        workspaceId,
        email: `bulk-${unique()}-${unique()}@example.test`,
        role: 'member' as const,
        tokenHash: hashToken(generateToken()),
        invitedBy,
        createdAt: opts.createdAt,
        expiresAt: opts.expiresAt,
      })),
    );
  }

  async function auditRows(db: Db, workspaceId: string, action: string) {
    const rows = await db.orm
      .select()
      .from(auditLog)
      .where(eq(auditLog.workspaceId, workspaceId))
      .orderBy(asc(auditLog.createdAt));
    return rows.filter((row) => row.action === action);
  }

  describe('createInvite', () => {
    it('an owner invites an admin: the row, the audit entry and the hash at rest', async () => {
      const { db, f, owner } = await setup();
      const now = new Date();
      const email = `Ada.Admin-${unique()}@Example.test`;

      const created = value(
        await createInvite(db.orm, owner, input({ email, role: 'admin', locale: 'it' }), { now }),
      );

      expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(created.locale).toBe('it');
      const row = await inviteRow(db, created.inviteId);
      expect(row).toMatchObject({
        workspaceId: f.workspaceId,
        email: email.trim().toLowerCase(),
        role: 'admin',
        locale: 'it',
        invitedBy: f.members.owner.id,
        acceptedAt: null,
        acceptedMemberId: null,
        revokedAt: null,
      });
      expect(row.expiresAt.getTime()).toBe(now.getTime() + 7 * DAY);
      expect(row.createdAt.getTime()).toBe(now.getTime());
      expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.tokenHash).not.toBe(created.token);
      expect(row.tokenHash).toBe(sha256(created.token));

      const [entry, ...rest] = await auditRows(db, f.workspaceId, 'invite.created');
      expect(rest).toHaveLength(0);
      expect(entry).toMatchObject({
        actorMemberId: f.members.owner.id,
        targetType: 'invite',
        targetId: created.inviteId,
        metadata: { role: 'admin', team_count: 0 },
      });
      const logged = JSON.stringify(entry);
      expect(logged).not.toContain(created.token);
      expect(logged).not.toContain(row.tokenHash);
      expect(logged.toLowerCase()).not.toContain('example.test');
    });

    it('the locale defaults to English', async () => {
      const { db, owner } = await setup();

      const created = value(await createInvite(db.orm, owner, input(), { now: new Date() }));

      expect(created.locale).toBe('en');
      expect((await inviteRow(db, created.inviteId)).locale).toBe('en');
    });

    it('an admin invites a member and a guest, with their teams', async () => {
      const { db, f, admin } = await setup();
      const now = new Date();

      const asMember = value(await createInvite(db.orm, admin, input({ role: 'member' }), { now }));
      const asGuest = value(
        await createInvite(db.orm, admin, input({ role: 'guest', teamIds: [f.teams.eng.id] }), {
          now,
        }),
      );

      expect((await inviteRow(db, asMember.inviteId)).role).toBe('member');
      expect((await inviteRow(db, asGuest.inviteId)).role).toBe('guest');
      const teams = await db.orm
        .select({ teamId: inviteTeam.teamId, workspaceId: inviteTeam.workspaceId })
        .from(inviteTeam)
        .where(eq(inviteTeam.inviteId, asGuest.inviteId));
      expect(teams).toEqual([{ teamId: f.teams.eng.id, workspaceId: f.workspaceId }]);
      const guestEntry = (await auditRows(db, f.workspaceId, 'invite.created')).find(
        (row) => row.targetId === asGuest.inviteId,
      );
      expect(guestEntry?.metadata).toEqual({ role: 'guest', team_count: 1 });
    });

    it('an admin cannot invite an admin or an owner (403), an owner can invite an owner', async () => {
      const { db, f, owner, admin } = await setup();
      const now = new Date();

      for (const role of ['admin', 'owner'] as const) {
        const refused = await createInvite(db.orm, admin, input({ role }), { now });
        expect(refusal(refused), role).toEqual({ code: 'forbidden', status: 403 });
      }
      expect(
        value(await createInvite(db.orm, owner, input({ role: 'owner' }), { now })),
      ).toBeDefined();
      const rows = await db.orm.select().from(invite).where(eq(invite.workspaceId, f.workspaceId));
      expect(rows.map((row) => row.role)).toEqual(['owner']);
    });

    it('a member and a guest cannot invite anyone (403)', async () => {
      const { db, f, member: plain, guest } = await setup();

      for (const actor of [plain, guest]) {
        const refused = await createInvite(
          db.orm,
          actor,
          input({ role: 'guest', teamIds: [f.teams.eng.id] }),
          { now: new Date() },
        );
        expect(refusal(refused)).toEqual({ code: 'forbidden', status: 403 });
      }
    });

    it('a guest invite without a team is 400', async () => {
      const { db, owner } = await setup();

      const refused = await createInvite(db.orm, owner, input({ role: 'guest' }), {
        now: new Date(),
      });

      expect(refusal(refused)).toEqual({ code: 'invalid_input', status: 400 });
    });

    it('a team of another workspace or an unknown team is 404, a private team the actor cannot see is 404', async () => {
      const { db, f, owner, admin } = await setup();
      const other = await createWorkspaceFixture(db.orm);
      const now = new Date();
      const unknownTeam = '99999999-9999-4999-8999-999999999999';

      const foreign = await createInvite(
        db.orm,
        owner,
        input({ role: 'guest', teamIds: [other.teams.eng.id] }),
        { now },
      );
      const unknown = await createInvite(
        db.orm,
        owner,
        input({ role: 'guest', teamIds: [unknownTeam] }),
        { now },
      );
      // OPS is private and the admin is not in it: the team does not exist for them.
      const hidden = await createInvite(
        db.orm,
        admin,
        input({ role: 'guest', teamIds: [f.teams.ops.id] }),
        { now },
      );
      // One bad id among good ones refuses the whole call, and nothing is written.
      const mixed = await createInvite(
        db.orm,
        owner,
        input({ role: 'guest', teamIds: [f.teams.eng.id, other.teams.eng.id] }),
        { now },
      );

      for (const refused of [foreign, unknown, hidden, mixed]) {
        expect(refusal(refused)).toEqual({ code: 'not_found', status: 404 });
      }
      const rows = await db.orm.select().from(invite).where(eq(invite.workspaceId, f.workspaceId));
      expect(rows).toHaveLength(0);
    });

    it('a member of a private team can invite into it', async () => {
      const { db, f, owner } = await setup();

      const created = value(
        await createInvite(db.orm, owner, input({ role: 'guest', teamIds: [f.teams.ops.id] }), {
          now: new Date(),
        }),
      );

      const teams = await db.orm
        .select({ teamId: inviteTeam.teamId })
        .from(inviteTeam)
        .where(eq(inviteTeam.inviteId, created.inviteId));
      expect(teams).toEqual([{ teamId: f.teams.ops.id }]);
    });

    it('stores the email lower-cased and trimmed', async () => {
      const { db, owner } = await setup();
      const tag = unique();

      const created = value(
        await createInvite(db.orm, owner, input({ email: `  New.Person-${tag}@Example.TEST ` }), {
          now: new Date(),
        }),
      );

      expect((await inviteRow(db, created.inviteId)).email).toBe(`new.person-${tag}@example.test`);
    });

    it('an active member with that email is 409 already_member, whatever the capitals', async () => {
      const { db, owner, f } = await setup();

      const refused = await createInvite(
        db.orm,
        owner,
        input({ email: f.members.member.email.toUpperCase() }),
        { now: new Date() },
      );

      expect(refusal(refused)).toEqual({ code: 'already_member', status: 409 });
    });

    it('a deactivated member can be invited again', async () => {
      const { db, f, owner } = await setup();
      await db.orm
        .update(member)
        .set({ deactivatedAt: new Date() })
        .where(eq(member.id, f.members.member.id));

      const created = await createInvite(
        db.orm,
        owner,
        input({ email: f.members.member.email, role: 'guest', teamIds: [f.teams.eng.id] }),
        { now: new Date() },
      );

      expect(created.ok).toBe(true);
    });

    it('an admin cannot bring back a deactivated admin or owner through an invite, at any role (403)', async () => {
      const { db, f, admin } = await setup();
      const gone = await addMember(db.orm, f.workspaceId, 'admin');
      const goneOwner = await addMember(db.orm, f.workspaceId, 'owner');
      await db.orm
        .update(member)
        .set({ deactivatedAt: new Date() })
        .where(inArray(member.id, [gone.id, goneOwner.id]));

      for (const target of [gone, goneOwner]) {
        for (const role of ['member', 'guest'] as const) {
          const created = await createInvite(
            db.orm,
            admin,
            input({ email: target.email, role, teamIds: [f.teams.eng.id] }),
            { now: new Date() },
          );
          expect(refusal(created), `${target.role} as ${role}`).toEqual({
            code: 'forbidden',
            status: 403,
          });
        }
      }
      expect(
        await db.orm.select().from(invite).where(eq(invite.workspaceId, f.workspaceId)),
      ).toEqual([]);
    });

    it('an owner can invite a deactivated admin or owner again; an admin can invite a deactivated member or guest', async () => {
      const { db, f, owner, admin } = await setup();
      const goneAdmin = await addMember(db.orm, f.workspaceId, 'admin');
      const goneOwner = await addMember(db.orm, f.workspaceId, 'owner');
      const goneMember = await addMember(db.orm, f.workspaceId, 'member');
      const goneGuest = await addMember(db.orm, f.workspaceId, 'guest');
      await db.orm
        .update(member)
        .set({ deactivatedAt: new Date() })
        .where(inArray(member.id, [goneAdmin.id, goneOwner.id, goneMember.id, goneGuest.id]));
      const now = new Date();

      for (const target of [goneAdmin, goneOwner]) {
        const created = await createInvite(
          db.orm,
          owner,
          input({ email: target.email, role: 'member' }),
          { now },
        );
        expect(created.ok, `owner re-invites ${target.role}`).toBe(true);
      }
      for (const target of [goneMember, goneGuest]) {
        const created = await createInvite(
          db.orm,
          admin,
          input({ email: target.email, role: 'member' }),
          { now },
        );
        expect(created.ok, `admin re-invites ${target.role}`).toBe(true);
      }
    });

    it('a second pending invite for the same email is 409 invite_pending, another workspace is fine', async () => {
      const { db, owner } = await setup();
      const other = await setup();
      const email = `twice-${unique()}@example.test`;
      const now = new Date();
      value(await createInvite(db.orm, owner, input({ email }), { now }));

      const again = await createInvite(db.orm, owner, input({ email: email.toUpperCase() }), {
        now: new Date(now.getTime() + MINUTE),
      });
      const elsewhere = await createInvite(db.orm, other.owner, input({ email }), { now });

      expect(refusal(again)).toEqual({ code: 'invite_pending', status: 409 });
      expect(elsewhere.ok).toBe(true);
    });

    it('an expired pending invite does not block a new one: it is revoked as expired and replaced', async () => {
      const { db, f, owner } = await setup();
      const email = `late-${unique()}@example.test`;
      const longAgo = new Date(Date.now() - 8 * DAY);
      const old = value(await createInvite(db.orm, owner, input({ email }), { now: longAgo }));
      const now = new Date();

      const replacement = value(
        await createInvite(
          db.orm,
          owner,
          input({ email, role: 'guest', teamIds: [f.teams.eng.id] }),
          {
            now,
          },
        ),
      );

      expect(replacement.inviteId).not.toBe(old.inviteId);
      const oldRow = await inviteRow(db, old.inviteId);
      expect(oldRow.revokedAt?.getTime()).toBe(now.getTime());
      expect(oldRow.acceptedAt).toBeNull();
      const revokedEntries = await auditRows(db, f.workspaceId, 'invite.revoked');
      expect(revokedEntries).toHaveLength(1);
      expect(revokedEntries[0]).toMatchObject({
        actorMemberId: f.members.owner.id,
        targetType: 'invite',
        targetId: old.inviteId,
        metadata: { reason: 'expired' },
      });
      // The old link is dead, the new one works.
      expect(await previewInvite(db.orm, old.token, now)).toBeNull();
      expect(await previewInvite(db.orm, replacement.token, now)).not.toBeNull();
      const pending = await db.orm
        .select()
        .from(invite)
        .where(and(eq(invite.workspaceId, f.workspaceId), eq(invite.email, email)));
      expect(
        pending.filter((row) => row.revokedAt === null && row.acceptedAt === null),
      ).toHaveLength(1);
    });

    it('a pending invite that is still valid keeps answering 409 right up to its expiry', async () => {
      const { db, owner } = await setup();
      const email = `live-${unique()}@example.test`;
      const now = new Date();
      value(await createInvite(db.orm, owner, input({ email }), { now }));

      const justBefore = await createInvite(db.orm, owner, input({ email }), {
        now: new Date(now.getTime() + 7 * DAY - 1),
      });
      const atExpiry = await createInvite(db.orm, owner, input({ email }), {
        now: new Date(now.getTime() + 7 * DAY),
      });

      expect(refusal(justBefore)).toEqual({ code: 'invite_pending', status: 409 });
      expect(atExpiry.ok).toBe(true);
    });

    it('two concurrent invites for one email: exactly one is created, the other is invite_pending', async () => {
      const { db, f, owner, admin } = await setup();
      const email = `race-${unique()}@example.test`;
      const now = new Date();

      const results = await Promise.all([
        createInvite(db.orm, owner, input({ email }), { now }),
        createInvite(db.orm, admin, input({ email }), { now }),
      ]);

      expect(results.filter((result) => result.ok)).toHaveLength(1);
      const failed = results.find((result) => !result.ok);
      expect(failed && refusal(failed)).toEqual({ code: 'invite_pending', status: 409 });
      const rows = await db.orm.select().from(invite).where(eq(invite.workspaceId, f.workspaceId));
      expect(rows).toHaveLength(1);
    });

    it('the 31st invite by one actor within an hour is 429, the 30th is fine', async () => {
      const { db, f, owner, admin } = await setup();
      const now = new Date();
      await insertInvites(db, f.workspaceId, f.members.owner.id, 29, {
        createdAt: new Date(now.getTime() - 10 * MINUTE),
        expiresAt: new Date(now.getTime() + 6 * DAY),
      });

      const thirtieth = await createInvite(db.orm, owner, input(), { now });
      const thirtyFirst = await createInvite(db.orm, owner, input(), { now });
      // The limit is per actor: the admin has sent none.
      const otherActor = await createInvite(db.orm, admin, input(), { now });

      expect(thirtieth.ok).toBe(true);
      expect(refusal(thirtyFirst)).toEqual({ code: 'rate_limited', status: 429 });
      expect(otherActor.ok).toBe(true);
    });

    it('invites created more than an hour ago do not count towards the hourly limit', async () => {
      const { db, f, owner } = await setup();
      const now = new Date();
      await insertInvites(db, f.workspaceId, f.members.owner.id, 30, {
        createdAt: new Date(now.getTime() - HOUR - MINUTE),
        expiresAt: new Date(now.getTime() + 6 * DAY),
      });

      const created = await createInvite(db.orm, owner, input(), { now });

      expect(created.ok).toBe(true);
    });

    it('a workspace with 200 pending invites refuses more (429), expired ones do not count', async () => {
      const { db, f, owner, admin } = await setup();
      const now = new Date();
      // Spread over two inviters so the hourly limit (30 per actor) is not what answers.
      const old = new Date(now.getTime() - 3 * HOUR);
      await insertInvites(db, f.workspaceId, f.members.owner.id, 100, {
        createdAt: old,
        expiresAt: new Date(now.getTime() + 4 * DAY),
      });
      await insertInvites(db, f.workspaceId, f.members.admin.id, 99, {
        createdAt: old,
        expiresAt: new Date(now.getTime() + 4 * DAY),
      });
      // Expired rows are not pending.
      await insertInvites(db, f.workspaceId, f.members.owner.id, 50, {
        createdAt: new Date(now.getTime() - 9 * DAY),
        expiresAt: new Date(now.getTime() - 2 * DAY),
      });

      const last = await createInvite(db.orm, admin, input(), { now });
      const over = await createInvite(db.orm, owner, input(), { now });

      expect(last.ok).toBe(true);
      expect(refusal(over)).toEqual({ code: 'rate_limited', status: 429 });
    });
  });

  describe('resendInvite', () => {
    it('gives the same row a new token and a fresh 7 days, and the old link is dead', async () => {
      const { db, f, owner } = await setup();
      const email = `again-${unique()}@example.test`;
      const created = new Date(Date.now() - 5 * DAY);
      const first = value(
        await createInvite(db.orm, owner, input({ email, locale: 'it' }), { now: created }),
      );
      const now = new Date();

      const resent = value(await resendInvite(db.orm, owner, first.inviteId, { now }));

      expect(resent.email).toBe(email);
      expect(resent.locale).toBe('it');
      expect(resent.token).not.toBe(first.token);
      const row = await inviteRow(db, first.inviteId);
      expect(row.tokenHash).toBe(sha256(resent.token));
      expect(row.expiresAt.getTime()).toBe(now.getTime() + 7 * DAY);
      expect(row.createdAt.getTime()).toBe(created.getTime());
      expect(await previewInvite(db.orm, first.token, now)).toBeNull();
      expect(await previewInvite(db.orm, resent.token, now)).not.toBeNull();
      const refused = await acceptInvite(db.orm, {
        token: first.token,
        name: 'Old Link',
        now,
        userAgent: null,
      });
      expect(refusal(refused)).toEqual({ code: 'invite_invalid', status: 400 });
      const [entry] = await auditRows(db, f.workspaceId, 'invite.resent');
      expect(entry).toMatchObject({
        actorMemberId: f.members.owner.id,
        targetType: 'invite',
        targetId: first.inviteId,
      });
      expect(JSON.stringify(entry)).not.toContain(resent.token);
    });

    it('an expired invite can be resent (that is what resend is for)', async () => {
      const { db, owner } = await setup();
      const first = value(
        await createInvite(db.orm, owner, input(), { now: new Date(Date.now() - 9 * DAY) }),
      );
      const now = new Date();

      const resent = value(await resendInvite(db.orm, owner, first.inviteId, { now }));

      expect(await previewInvite(db.orm, resent.token, now)).not.toBeNull();
    });

    it('an accepted, revoked, unknown or foreign invite is 404', async () => {
      const { db, f, owner } = await setup();
      const other = await setup();
      const now = new Date();
      const accepted = value(await createInvite(db.orm, owner, input(), { now }));
      value(
        await acceptInvite(db.orm, {
          token: accepted.token,
          name: 'Done Person',
          now,
          userAgent: null,
        }),
      );
      const revoked = value(await createInvite(db.orm, owner, input(), { now }));
      value(await revokeInvite(db.orm, owner, revoked.inviteId, { now }));
      const foreign = value(await createInvite(db.orm, other.owner, input(), { now }));

      for (const id of [
        accepted.inviteId,
        revoked.inviteId,
        foreign.inviteId,
        '99999999-9999-4999-8999-999999999999',
        'not-a-uuid',
      ]) {
        const refused = await resendInvite(db.orm, owner, id, { now });
        expect(refusal(refused), id).toEqual({ code: 'not_found', status: 404 });
      }
      expect(f.workspaceId).not.toBe(other.f.workspaceId);
    });

    it('a member and a guest cannot resend (403); an admin cannot resend an admin invite (403)', async () => {
      const { db, owner, admin, member: plain, guest } = await setup();
      const now = new Date();
      const forAdmin = value(await createInvite(db.orm, owner, input({ role: 'admin' }), { now }));
      const forMember = value(
        await createInvite(db.orm, owner, input({ role: 'member' }), { now }),
      );

      for (const actor of [plain, guest]) {
        const refused = await resendInvite(db.orm, actor, forMember.inviteId, { now });
        expect(refusal(refused)).toEqual({ code: 'forbidden', status: 403 });
      }
      const adminOnAdmin = await resendInvite(db.orm, admin, forAdmin.inviteId, { now });
      const adminOnMember = await resendInvite(db.orm, admin, forMember.inviteId, { now });

      expect(refusal(adminOnAdmin)).toEqual({ code: 'forbidden', status: 403 });
      expect(adminOnMember.ok).toBe(true);
    });
  });

  describe('revokeInvite', () => {
    it('kills the link for preview and accept, and answers a txid', async () => {
      const { db, f, owner } = await setup();
      const now = new Date();
      const created = value(await createInvite(db.orm, owner, input(), { now }));

      const revoked = value(await revokeInvite(db.orm, owner, created.inviteId, { now }));

      expect(typeof revoked.txid).toBe('number');
      expect((await inviteRow(db, created.inviteId)).revokedAt?.getTime()).toBe(now.getTime());
      expect(await previewInvite(db.orm, created.token, now)).toBeNull();
      const refused = await acceptInvite(db.orm, {
        token: created.token,
        name: 'Too Late',
        now,
        userAgent: null,
      });
      expect(refusal(refused)).toEqual({ code: 'invite_invalid', status: 400 });
      const [entry] = await auditRows(db, f.workspaceId, 'invite.revoked');
      expect(entry).toMatchObject({
        actorMemberId: f.members.owner.id,
        targetType: 'invite',
        targetId: created.inviteId,
      });
    });

    it('revoking twice is a 200 no-op without a second audit entry', async () => {
      const { db, f, owner } = await setup();
      const created = value(await createInvite(db.orm, owner, input(), { now: new Date() }));
      const first = new Date();
      value(await revokeInvite(db.orm, owner, created.inviteId, { now: first }));

      const second = value(
        await revokeInvite(db.orm, owner, created.inviteId, {
          now: new Date(first.getTime() + MINUTE),
        }),
      );

      expect(typeof second.txid).toBe('number');
      expect((await inviteRow(db, created.inviteId)).revokedAt?.getTime()).toBe(first.getTime());
      expect(await auditRows(db, f.workspaceId, 'invite.revoked')).toHaveLength(1);
    });

    it('an unknown, foreign or accepted invite is 404; a member and a guest are 403', async () => {
      const { db, owner, member: plain, guest } = await setup();
      const other = await setup();
      const now = new Date();
      const foreign = value(await createInvite(db.orm, other.owner, input(), { now }));
      const accepted = value(await createInvite(db.orm, owner, input(), { now }));
      value(
        await acceptInvite(db.orm, {
          token: accepted.token,
          name: 'Accepted Person',
          now,
          userAgent: null,
        }),
      );
      const open = value(await createInvite(db.orm, owner, input(), { now }));

      for (const id of [foreign.inviteId, accepted.inviteId, 'not-a-uuid']) {
        const refused = await revokeInvite(db.orm, owner, id, { now });
        expect(refusal(refused), id).toEqual({ code: 'not_found', status: 404 });
      }
      for (const actor of [plain, guest]) {
        const refused = await revokeInvite(db.orm, actor, open.inviteId, { now });
        expect(refusal(refused)).toEqual({ code: 'forbidden', status: 403 });
      }
    });

    it('an admin cannot revoke an admin invite (403) but can revoke a member invite', async () => {
      const { db, owner, admin } = await setup();
      const now = new Date();
      const forAdmin = value(await createInvite(db.orm, owner, input({ role: 'admin' }), { now }));
      const forMember = value(
        await createInvite(db.orm, owner, input({ role: 'member' }), { now }),
      );

      const refused = await revokeInvite(db.orm, admin, forAdmin.inviteId, { now });
      const allowed = await revokeInvite(db.orm, admin, forMember.inviteId, { now });

      expect(refusal(refused)).toEqual({ code: 'forbidden', status: 403 });
      expect(allowed.ok).toBe(true);
    });

    it('a revoked invite frees the email for a new invite', async () => {
      const { db, owner } = await setup();
      const email = `free-${unique()}@example.test`;
      const now = new Date();
      const first = value(await createInvite(db.orm, owner, input({ email }), { now }));
      value(await revokeInvite(db.orm, owner, first.inviteId, { now }));

      const second = await createInvite(db.orm, owner, input({ email }), { now });

      expect(second.ok).toBe(true);
    });
  });

  describe('listInvites', () => {
    it('lists the pending, unexpired invites of the workspace, newest first, with their teams', async () => {
      const { db, f, owner, admin } = await setup();
      const other = await setup();
      const base = new Date();
      const older = value(
        await createInvite(db.orm, owner, input({ role: 'guest', teamIds: [f.teams.eng.id] }), {
          now: new Date(base.getTime() - 2 * MINUTE),
        }),
      );
      const newer = value(
        await createInvite(db.orm, admin, input(), { now: new Date(base.getTime() - MINUTE) }),
      );
      // Not listed: expired, revoked, accepted, and another workspace's.
      value(
        await createInvite(db.orm, owner, input(), { now: new Date(base.getTime() - 9 * DAY) }),
      );
      const revoked = value(await createInvite(db.orm, owner, input(), { now: base }));
      value(await revokeInvite(db.orm, owner, revoked.inviteId, { now: base }));
      const accepted = value(await createInvite(db.orm, owner, input(), { now: base }));
      value(
        await acceptInvite(db.orm, {
          token: accepted.token,
          name: 'Joined Already',
          now: base,
          userAgent: null,
        }),
      );
      value(await createInvite(db.orm, other.owner, input(), { now: base }));

      const listed = value(await listInvites(db.orm, owner, { now: base }));

      expect(listed.map((item) => item.id)).toEqual([newer.inviteId, older.inviteId]);
      const olderRow = await inviteRow(db, older.inviteId);
      expect(listed[1]).toEqual({
        id: older.inviteId,
        email: olderRow.email,
        role: 'guest',
        teamIds: [f.teams.eng.id],
        invitedBy: f.members.owner.id,
        createdAt: olderRow.createdAt.toISOString(),
        expiresAt: olderRow.expiresAt.toISOString(),
      });
      expect(Object.keys(listed[0] ?? {}).sort()).toEqual(
        ['createdAt', 'email', 'expiresAt', 'id', 'invitedBy', 'role', 'teamIds'].sort(),
      );
      expect(JSON.stringify(listed)).not.toContain(olderRow.tokenHash);
      expect(value(await listInvites(db.orm, admin, { now: base }))).toHaveLength(2);
    });

    it('a member and a guest get 403', async () => {
      const { db, member: plain, guest } = await setup();

      for (const actor of [plain, guest]) {
        const refused = await listInvites(db.orm, actor, { now: new Date() });
        expect(refusal(refused)).toEqual({ code: 'forbidden', status: 403 });
      }
    });
  });

  describe('previewInvite', () => {
    it('returns workspace name, email, role and team keys, and changes nothing', async () => {
      const { db, f, owner } = await setup();
      const now = new Date();
      const email = `peek-${unique()}@example.test`;
      const created = value(
        await createInvite(
          db.orm,
          owner,
          input({ email, role: 'guest', teamIds: [f.teams.ops.id, f.teams.eng.id] }),
          { now },
        ),
      );
      const before = await inviteRow(db, created.inviteId);
      const [ws] = await db.orm.select().from(workspace).where(eq(workspace.id, f.workspaceId));

      const preview = await previewInvite(db.orm, created.token, now);

      expect(preview).toEqual({
        workspaceName: ws?.name,
        email,
        role: 'guest',
        teams: [
          { key: f.teams.eng.key, name: f.teams.eng.name },
          { key: f.teams.ops.key, name: f.teams.ops.name },
        ],
      });
      expect(await inviteRow(db, created.inviteId)).toEqual(before);
      expect(await previewInvite(db.orm, created.token, now)).toEqual(preview);
    });

    it('unknown, malformed, expired, revoked and accepted tokens give null', async () => {
      const { db, owner } = await setup();
      const now = new Date();
      const expired = value(
        await createInvite(db.orm, owner, input(), { now: new Date(now.getTime() - 8 * DAY) }),
      );
      const revoked = value(await createInvite(db.orm, owner, input(), { now }));
      value(await revokeInvite(db.orm, owner, revoked.inviteId, { now }));
      const accepted = value(await createInvite(db.orm, owner, input(), { now }));
      value(
        await acceptInvite(db.orm, {
          token: accepted.token,
          name: 'In Already',
          now,
          userAgent: null,
        }),
      );

      for (const token of [
        generateToken(),
        'short',
        '',
        `${accepted.token}x`,
        expired.token,
        revoked.token,
        accepted.token,
      ]) {
        expect(await previewInvite(db.orm, token, now), token).toBeNull();
      }
    });
  });

  describe('acceptInvite', () => {
    async function pendingInvite(
      s: Awaited<ReturnType<typeof setup>>,
      over: Partial<InviteCreateInput> = {},
      now = new Date(),
    ) {
      return value(await createInvite(s.db.orm, s.owner, input(over), { now }));
    }

    it('creates the member with the invite email, role, locale and teams, then audits and opens a session', async () => {
      const s = await setup();
      const { db, f } = s;
      const now = new Date();
      const email = `Joiner-${unique()}@Example.test`;
      const created = await pendingInvite(
        s,
        { email, role: 'guest', teamIds: [f.teams.eng.id, f.teams.ops.id], locale: 'it' },
        now,
      );

      const accepted = value(
        await acceptInvite(db.orm, {
          token: created.token,
          name: '  Ada Lovelace ',
          now,
          userAgent: 'Vitest/1.0',
        }),
      );

      expect(accepted.workspaceId).toBe(f.workspaceId);
      const [row] = await db.orm.select().from(member).where(eq(member.id, accepted.memberId));
      expect(row).toMatchObject({
        workspaceId: f.workspaceId,
        email: email.trim().toLowerCase(),
        name: 'Ada Lovelace',
        handle: 'ada-lovelace',
        role: 'guest',
        locale: 'it',
        deactivatedAt: null,
      });
      const teams = await db.orm
        .select({ teamId: teamMember.teamId })
        .from(teamMember)
        .where(eq(teamMember.memberId, accepted.memberId));
      expect(teams.map((t) => t.teamId).sort()).toEqual([f.teams.eng.id, f.teams.ops.id].sort());
      const stored = await inviteRow(db, created.inviteId);
      expect(stored.acceptedAt?.getTime()).toBe(now.getTime());
      expect(stored.acceptedMemberId).toBe(accepted.memberId);

      const [entry, ...rest] = await auditRows(db, f.workspaceId, 'invite.accepted');
      expect(rest).toHaveLength(0);
      expect(entry).toMatchObject({
        actorMemberId: accepted.memberId,
        targetType: 'invite',
        targetId: created.inviteId,
      });
      const logged = JSON.stringify(entry);
      expect(logged).not.toContain(created.token);
      expect(logged).not.toContain(accepted.sessionToken);
      expect(logged.toLowerCase()).not.toContain('example.test');
      expect(logged).not.toContain('Lovelace');

      const sessions = await db.orm
        .select()
        .from(session)
        .where(eq(session.tokenHash, hashToken(accepted.sessionToken)));
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        workspaceId: f.workspaceId,
        memberId: accepted.memberId,
        userAgent: 'Vitest/1.0',
        revokedAt: null,
      });
      expect(sessions[0]?.expiresAt.getTime()).toBe(now.getTime() + 30 * DAY);
      const workspaces = await listSessionWorkspaces(db.orm, accepted.sessionToken, now);
      expect(workspaces.map((w) => [w.id, w.memberId, w.role])).toEqual([
        [f.workspaceId, accepted.memberId, 'guest'],
      ]);
    });

    it('an invite for no team creates a member in no team', async () => {
      const s = await setup();
      const created = await pendingInvite(s, { role: 'member' });

      const accepted = value(
        await acceptInvite(s.db.orm, {
          token: created.token,
          name: 'Lone Member',
          now: new Date(),
          userAgent: null,
        }),
      );

      const teams = await s.db.orm
        .select()
        .from(teamMember)
        .where(eq(teamMember.memberId, accepted.memberId));
      expect(teams).toHaveLength(0);
    });

    it('two concurrent accepts of one token: exactly one success', async () => {
      const s = await setup();
      const { db, f } = s;
      const email = `race-${unique()}@example.test`;
      const created = await pendingInvite(s, { email, role: 'guest', teamIds: [f.teams.eng.id] });
      const now = new Date();
      const accept = () =>
        acceptInvite(db.orm, { token: created.token, name: 'Racing Person', now, userAgent: null });

      const results = await Promise.all([accept(), accept(), accept()]);

      expect(results.filter((result) => result.ok)).toHaveLength(1);
      for (const failed of results.filter((result) => !result.ok)) {
        expect(refusal(failed)).toEqual({ code: 'invite_invalid', status: 400 });
      }
      const members = await db.orm
        .select()
        .from(member)
        .where(and(eq(member.workspaceId, f.workspaceId), eq(member.email, email)));
      expect(members).toHaveLength(1);
      expect(await auditRows(db, f.workspaceId, 'invite.accepted')).toHaveLength(1);
      const sessions = await db.orm
        .select()
        .from(session)
        .where(eq(session.memberId, members[0]?.id ?? ''));
      expect(sessions).toHaveLength(1);
    });

    it('a second accept of the same token, an expired, a revoked and an unknown token are invite_invalid', async () => {
      const s = await setup();
      const { db, owner } = s;
      const now = new Date();
      const used = await pendingInvite(s);
      value(
        await acceptInvite(db.orm, { token: used.token, name: 'First One', now, userAgent: null }),
      );
      const expired = await pendingInvite(s, {}, new Date(now.getTime() - 8 * DAY));
      const revoked = await pendingInvite(s);
      value(await revokeInvite(db.orm, owner, revoked.inviteId, { now }));

      for (const token of [
        used.token,
        expired.token,
        revoked.token,
        generateToken(),
        'not-a-token',
      ]) {
        const refused = await acceptInvite(db.orm, {
          token,
          name: 'Late Comer',
          now,
          userAgent: null,
        });
        expect(refusal(refused), token).toEqual({ code: 'invite_invalid', status: 400 });
      }
    });

    it('the exact expiry instant is already expired', async () => {
      const s = await setup();
      const now = new Date();
      const created = await pendingInvite(s, {}, now);

      const refused = await acceptInvite(s.db.orm, {
        token: created.token,
        name: 'On The Dot',
        now: new Date(now.getTime() + 7 * DAY),
        userAgent: null,
      });

      expect(refusal(refused)).toEqual({ code: 'invite_invalid', status: 400 });
    });

    it('an empty or too long name is 400 and does not burn the invite', async () => {
      const s = await setup();
      const now = new Date();
      const created = await pendingInvite(s);

      for (const name of ['', '   ', 'x'.repeat(81)]) {
        const refused = await acceptInvite(s.db.orm, {
          token: created.token,
          name,
          now,
          userAgent: null,
        });
        expect(refusal(refused), name).toEqual({ code: 'invalid_input', status: 400 });
      }

      expect((await inviteRow(s.db, created.inviteId)).acceptedAt).toBeNull();
      expect(
        (
          await acceptInvite(s.db.orm, {
            token: created.token,
            name: 'Fine Name',
            now,
            userAgent: null,
          })
        ).ok,
      ).toBe(true);
    });

    it('revokes every session of the previous cookie, in all its workspaces, and leaves the new ones live', async () => {
      const s = await setup();
      const { db, f } = s;
      const other = await createWorkspaceFixture(db.orm);
      const now = new Date();
      const previous = await db.orm.transaction((tx) =>
        createSessionsForMembers(
          tx,
          [
            { workspaceId: f.workspaceId, memberId: f.members.member.id },
            { workspaceId: other.workspaceId, memberId: other.members.member.id },
          ],
          { now, userAgent: null },
        ),
      );
      const created = await pendingInvite(s, {}, now);

      const accepted = value(
        await acceptInvite(db.orm, {
          token: created.token,
          name: 'Fresh Start',
          now,
          userAgent: null,
          revokeSessionToken: previous,
        }),
      );

      const old = await db.orm
        .select()
        .from(session)
        .where(eq(session.tokenHash, hashToken(previous)));
      expect(old).toHaveLength(2);
      for (const row of old) expect(row.revokedAt?.getTime()).toBe(now.getTime());
      const fresh = await db.orm
        .select()
        .from(session)
        .where(eq(session.tokenHash, hashToken(accepted.sessionToken)));
      expect(fresh).toHaveLength(1);
      expect(fresh[0]?.revokedAt).toBeNull();
    });

    it('a refusal after the burn rolls everything back: the previous cookie stays live and the invite stays pending', async () => {
      const s = await setup();
      const { db, f } = s;
      const email = `race-${unique()}@example.test`;
      const now = new Date();
      const previous = await db.orm.transaction((tx) =>
        createSessionsForMembers(
          tx,
          [{ workspaceId: f.workspaceId, memberId: f.members.member.id }],
          { now, userAgent: null },
        ),
      );
      const created = await pendingInvite(s, { email }, now);
      await addMember(db.orm, f.workspaceId, 'member', { email });

      const refused = await acceptInvite(db.orm, {
        token: created.token,
        name: 'Late Comer',
        now,
        userAgent: null,
        revokeSessionToken: previous,
      });

      expect(refusal(refused)).toEqual({ code: 'already_member', status: 409 });
      const old = await db.orm
        .select()
        .from(session)
        .where(eq(session.tokenHash, hashToken(previous)));
      expect(old).toHaveLength(1);
      expect(old[0]?.revokedAt).toBeNull();
      expect((await inviteRow(db, created.inviteId)).acceptedAt).toBeNull();
    });

    it('a link that is not valid leaves the previous cookie live', async () => {
      const s = await setup();
      const { db, f } = s;
      const now = new Date();
      const previous = await db.orm.transaction((tx) =>
        createSessionsForMembers(
          tx,
          [{ workspaceId: f.workspaceId, memberId: f.members.member.id }],
          { now, userAgent: null },
        ),
      );

      const refused = await acceptInvite(db.orm, {
        token: generateToken(),
        name: 'Nobody',
        now,
        userAgent: null,
        revokeSessionToken: previous,
      });

      expect(refusal(refused)).toEqual({ code: 'invite_invalid', status: 400 });
      const old = await db.orm
        .select()
        .from(session)
        .where(eq(session.tokenHash, hashToken(previous)));
      expect(old[0]?.revokedAt).toBeNull();
    });

    it('a deactivated member with that email is reactivated with the invited role, keeps their id, and gets exactly the invited teams', async () => {
      const s = await setup();
      const { db, f } = s;
      const email = `back-${unique()}@example.test`;
      const before = await addMember(db.orm, f.workspaceId, 'member', {
        email,
        name: 'Old Name',
        teamIds: [f.teams.ops.id],
      });
      await db.orm
        .update(member)
        .set({ deactivatedAt: new Date(Date.now() - DAY), locale: 'it' })
        .where(eq(member.id, before.id));
      const now = new Date();
      const created = await pendingInvite(
        s,
        { email, role: 'guest', teamIds: [f.teams.eng.id] },
        now,
      );

      const accepted = value(
        await acceptInvite(db.orm, {
          token: created.token,
          name: 'New Name',
          now,
          userAgent: null,
        }),
      );

      expect(accepted.memberId).toBe(before.id);
      const [row] = await db.orm.select().from(member).where(eq(member.id, before.id));
      expect(row).toMatchObject({
        id: before.id,
        role: 'guest',
        name: 'New Name',
        handle: before.handle,
        locale: 'it',
        deactivatedAt: null,
      });
      // A guest never keeps access the invite did not grant: the old private team is gone.
      const teams = await db.orm
        .select({ teamId: teamMember.teamId })
        .from(teamMember)
        .where(eq(teamMember.memberId, before.id));
      expect(teams).toEqual([{ teamId: f.teams.eng.id }]);
      const members = await db.orm
        .select()
        .from(member)
        .where(and(eq(member.workspaceId, f.workspaceId), eq(member.email, email)));
      expect(members).toHaveLength(1);
      expect(await auditRows(db, f.workspaceId, 'member.reactivated')).toHaveLength(1);
      const [acceptedEntry] = await auditRows(db, f.workspaceId, 'invite.accepted');
      expect(acceptedEntry?.metadata).toMatchObject({ reactivated: true, role: 'guest' });
    });

    it('a deactivated member who is still in ENG accepts an invite for OPS only: active, in OPS only, no error', async () => {
      const s = await setup();
      const { db, f } = s;
      const email = `swap-${unique()}@example.test`;
      const before = await addMember(db.orm, f.workspaceId, 'member', {
        email,
        teamIds: [f.teams.eng.id],
      });
      await db.orm
        .update(member)
        .set({ deactivatedAt: new Date(Date.now() - DAY) })
        .where(eq(member.id, before.id));
      const now = new Date();
      const created = await pendingInvite(
        s,
        { email, role: 'member', teamIds: [f.teams.ops.id] },
        now,
      );

      const accepted = value(
        await acceptInvite(db.orm, {
          token: created.token,
          name: 'Swap Person',
          now,
          userAgent: null,
        }),
      );

      expect(accepted.memberId).toBe(before.id);
      const [row] = await db.orm.select().from(member).where(eq(member.id, before.id));
      expect(row?.deactivatedAt).toBeNull();
      const teams = await db.orm
        .select({ teamId: teamMember.teamId })
        .from(teamMember)
        .where(eq(teamMember.memberId, before.id));
      expect(teams).toEqual([{ teamId: f.teams.ops.id }]);
    });

    it('the replace cannot hit a row that exists: a deactivated member in ENG accepts an invite for ENG and OPS and ends in both, one row each', async () => {
      const s = await setup();
      const { db, f } = s;
      const email = `overlap-${unique()}@example.test`;
      const before = await addMember(db.orm, f.workspaceId, 'member', {
        email,
        teamIds: [f.teams.eng.id],
      });
      await db.orm
        .update(member)
        .set({ deactivatedAt: new Date(Date.now() - DAY) })
        .where(eq(member.id, before.id));
      const now = new Date();
      const created = await pendingInvite(
        s,
        { email, role: 'member', teamIds: [f.teams.eng.id, f.teams.ops.id] },
        now,
      );

      const accepted = value(
        await acceptInvite(db.orm, {
          token: created.token,
          name: 'Overlap Person',
          now,
          userAgent: null,
        }),
      );

      expect(accepted.memberId).toBe(before.id);
      const teams = await db.orm
        .select({ teamId: teamMember.teamId })
        .from(teamMember)
        .where(eq(teamMember.memberId, before.id));
      expect(teams.map((t) => t.teamId).sort()).toEqual([f.teams.eng.id, f.teams.ops.id].sort());
    });

    it('the same email in other workspaces: one cookie token covers every workspace where it is active', async () => {
      const s = await setup();
      const { db, f } = s;
      const email = `multi-${unique()}@example.test`;
      const second = await createWorkspaceFixture(db.orm, { email: { owner: email } });
      const third = await createWorkspaceFixture(db.orm);
      const gone = await addMember(db.orm, third.workspaceId, 'member', { email });
      await db.orm.update(member).set({ deactivatedAt: new Date() }).where(eq(member.id, gone.id));
      const now = new Date();
      const created = await pendingInvite(s, { email }, now);

      const accepted = value(
        await acceptInvite(db.orm, {
          token: created.token,
          name: 'Many Places',
          now,
          userAgent: null,
        }),
      );

      const workspaces = await listSessionWorkspaces(db.orm, accepted.sessionToken, now);
      expect(workspaces.map((w) => w.id).sort()).toEqual(
        [f.workspaceId, second.workspaceId].sort(),
      );
      const rows = await db.orm
        .select()
        .from(session)
        .where(eq(session.tokenHash, hashToken(accepted.sessionToken)));
      expect(rows).toHaveLength(2);
    });

    it('a handle that is taken gets -2, -3; concurrent accepts of one name get distinct handles', async () => {
      const s = await setup();
      const { db, f } = s;
      await db.orm
        .update(member)
        .set({ handle: 'ada-lovelace' })
        .where(eq(member.id, f.members.outsider.id));
      const now = new Date();
      const invites = await Promise.all([pendingInvite(s), pendingInvite(s), pendingInvite(s)]);

      const results = await Promise.all(
        invites.map((created) =>
          acceptInvite(db.orm, {
            token: created.token,
            name: 'Ada Lovelace',
            now,
            userAgent: null,
          }),
        ),
      );

      const handles = (
        await Promise.all(
          results.map(async (result) => {
            const [row] = await db.orm
              .select({ handle: member.handle })
              .from(member)
              .where(eq(member.id, value(result).memberId));
            return row?.handle;
          }),
        )
      ).sort();
      expect(handles).toEqual(['ada-lovelace-2', 'ada-lovelace-3', 'ada-lovelace-4']);
    });

    it('an email that became an active member after the invite was made answers already_member and leaves the invite pending', async () => {
      const s = await setup();
      const { db, f } = s;
      const email = `late-${unique()}@example.test`;
      const created = await pendingInvite(s, { email });
      await addMember(db.orm, f.workspaceId, 'member', { email });

      const refused = await acceptInvite(db.orm, {
        token: created.token,
        name: 'Too Many',
        now: new Date(),
        userAgent: null,
      });

      expect(refusal(refused)).toEqual({ code: 'already_member', status: 409 });
      expect((await inviteRow(db, created.inviteId)).acceptedAt).toBeNull();
      const sessions = await db.orm.select().from(session);
      expect(sessions.filter((row) => row.workspaceId === f.workspaceId)).toHaveLength(0);
    });

    it('an invite from someone who was deactivated or lost the right to grant that role since is not accepted', async () => {
      const s = await setup();
      const { db, f, admin } = s;
      const now = new Date();
      const fromGone = value(await createInvite(db.orm, admin, input(), { now }));
      const fromDemoted = value(await createInvite(db.orm, admin, input(), { now }));
      await db.orm
        .update(member)
        .set({ deactivatedAt: new Date() })
        .where(eq(member.id, f.members.admin.id));

      const gone = await acceptInvite(db.orm, {
        token: fromGone.token,
        name: 'Orphan One',
        now,
        userAgent: null,
      });
      await db.orm
        .update(member)
        .set({ deactivatedAt: null, role: 'guest' })
        .where(eq(member.id, f.members.admin.id));
      const demoted = await acceptInvite(db.orm, {
        token: fromDemoted.token,
        name: 'Orphan Two',
        now,
        userAgent: null,
      });

      expect(refusal(gone)).toEqual({ code: 'invite_invalid', status: 400 });
      expect(refusal(demoted)).toEqual({ code: 'invite_invalid', status: 400 });
      expect((await inviteRow(db, fromGone.inviteId)).acceptedAt).toBeNull();
    });

    it('an admin-made invite is not accepted once its target is a deactivated admin; an owner-made one is', async () => {
      const s = await setup();
      const { db, f, admin, owner } = s;
      const email = `rank-${unique()}@example.test`;
      const before = await addMember(db.orm, f.workspaceId, 'member', { email });
      await db.orm
        .update(member)
        .set({ deactivatedAt: new Date() })
        .where(eq(member.id, before.id));
      const now = new Date();
      // Made while the person is a deactivated plain member, which an admin may do.
      const fromAdmin = value(await createInvite(db.orm, admin, input({ email }), { now }));
      // Then an owner makes the deactivated member an admin.
      await db.orm.update(member).set({ role: 'admin' }).where(eq(member.id, before.id));

      const refused = await acceptInvite(db.orm, {
        token: fromAdmin.token,
        name: 'Back',
        now,
        userAgent: null,
      });

      expect(refusal(refused)).toEqual({ code: 'invite_invalid', status: 400 });
      expect(await previewInvite(db.orm, fromAdmin.token, now)).toBeNull();
      // Nothing changed: still a deactivated admin, the invite still pending, nothing audited.
      const [stillGone] = await db.orm.select().from(member).where(eq(member.id, before.id));
      expect(stillGone?.deactivatedAt).not.toBeNull();
      expect(stillGone?.role).toBe('admin');
      expect((await inviteRow(db, fromAdmin.inviteId)).acceptedAt).toBeNull();
      expect(await auditRows(db, f.workspaceId, 'member.reactivated')).toHaveLength(0);

      // The same person invited by an owner comes back with the invited role.
      await db.orm.update(invite).set({ revokedAt: now }).where(eq(invite.id, fromAdmin.inviteId));
      const fromOwner = value(await createInvite(db.orm, owner, input({ email }), { now }));
      const accepted = value(
        await acceptInvite(db.orm, { token: fromOwner.token, name: 'Back', now, userAgent: null }),
      );
      expect(accepted.memberId).toBe(before.id);
      const [back] = await db.orm.select().from(member).where(eq(member.id, before.id));
      expect(back).toMatchObject({ role: 'member', deactivatedAt: null });
    });

    it('an invite for the owner role made by an owner is accepted', async () => {
      const s = await setup();
      const created = await pendingInvite(s, { role: 'owner' });

      const accepted = await acceptInvite(s.db.orm, {
        token: created.token,
        name: 'Co Owner',
        now: new Date(),
        userAgent: null,
      });

      expect(accepted.ok).toBe(true);
    });
  });
});
