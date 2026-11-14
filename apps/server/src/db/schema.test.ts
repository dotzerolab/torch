import {
  auditLog,
  invite,
  inviteTeam,
  issue,
  loginToken,
  member,
  session,
  team,
  teamMember,
  workspace,
} from '@torch/shared/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createWorkspaceFixture, pgErrorCode, withTempDatabase } from '../test/fixtures.ts';
import { runMigrations } from './migrate.ts';

const databaseUrl = process.env.DATABASE_URL;

// Integration: needs the dev compose Postgres (see db.test.ts). Skipped, loudly, when DATABASE_URL is not set.
if (!databaseUrl) {
  console.warn(
    '[schema.test] SKIPPED the schema integration tests: DATABASE_URL is not set. ' +
      'Start `docker compose -f docker-compose.dev.yml up -d --wait postgres` and set DATABASE_URL (see .env.example).',
  );
}

const TABLES = [
  'workspace',
  'member',
  'team',
  'team_member',
  'workflow_state',
  'issue',
  'login_token',
  'session',
  'invite',
  'invite_team',
  'audit_log',
];

describe.skipIf(!databaseUrl)('schema (Postgres)', () => {
  it('migrations apply to an empty database and a second run is a no-op', async () => {
    await withTempDatabase(async (db, url) => {
      const tables = await db.pool.query<{ table_name: string }>(
        "select table_name from information_schema.tables where table_schema = 'public'",
      );
      expect(tables.rows.map((row) => row.table_name).sort()).toEqual([...TABLES].sort());
      const before = await db.pool.query('select id, hash from drizzle.__drizzle_migrations');
      expect(before.rowCount).toBeGreaterThan(0);

      await runMigrations(url);

      const after = await db.pool.query('select id, hash from drizzle.__drizzle_migrations');
      expect(after.rows).toEqual(before.rows);
    });
  });

  it('an issue cannot reference a team of another workspace', async () => {
    await withTempDatabase(async (db) => {
      const a = await createWorkspaceFixture(db.orm);
      const b = await createWorkspaceFixture(db.orm);

      const insertion = db.orm.insert(issue).values({
        workspaceId: a.workspaceId,
        teamId: b.teams.eng.id,
        number: 99,
        title: 'Cross-workspace team',
        stateId: b.states.eng.backlog.id,
        creatorId: a.members.owner.id,
      });

      await expect(insertion.then(() => 'inserted').catch(pgErrorCode)).resolves.toBe('23503');
    });
  });

  it('an issue cannot use a workflow state of another team', async () => {
    await withTempDatabase(async (db) => {
      const a = await createWorkspaceFixture(db.orm);

      const insertion = db.orm.insert(issue).values({
        workspaceId: a.workspaceId,
        teamId: a.teams.eng.id,
        number: 99,
        title: 'State of the other team',
        stateId: a.states.ops.backlog.id,
        creatorId: a.members.owner.id,
      });

      await expect(insertion.then(() => 'inserted').catch(pgErrorCode)).resolves.toBe('23503');
    });
  });

  it('an issue cannot be assigned to a member of another workspace', async () => {
    await withTempDatabase(async (db) => {
      const a = await createWorkspaceFixture(db.orm);
      const b = await createWorkspaceFixture(db.orm);

      const insertion = db.orm.insert(issue).values({
        workspaceId: a.workspaceId,
        teamId: a.teams.eng.id,
        number: 99,
        title: 'Assignee of the other workspace',
        stateId: a.states.eng.backlog.id,
        creatorId: a.members.owner.id,
        assigneeId: b.members.member.id,
      });

      await expect(insertion.then(() => 'inserted').catch(pgErrorCode)).resolves.toBe('23503');
    });
  });

  it('a member email must be stored lower-case and trimmed', async () => {
    await withTempDatabase(async (db) => {
      const a = await createWorkspaceFixture(db.orm);
      const base = { workspaceId: a.workspaceId, name: 'Extra', role: 'member' as const };

      const padded = db.orm
        .insert(member)
        .values({ ...base, email: ' padded@example.test ', handle: 'padded' });
      const capitals = db.orm
        .insert(member)
        .values({ ...base, email: 'Capitals@Example.test', handle: 'capitals' });
      const clean = db.orm
        .insert(member)
        .values({ ...base, email: 'clean@example.test', handle: 'clean' });

      await expect(padded.then(() => 'inserted').catch(pgErrorCode)).resolves.toBe('23514');
      await expect(capitals.then(() => 'inserted').catch(pgErrorCode)).resolves.toBe('23514');
      await expect(clean.then(() => 'inserted')).resolves.toBe('inserted');
    });
  });

  it('team keys are unique per workspace and reusable across workspaces', async () => {
    await withTempDatabase(async (db) => {
      const a = await createWorkspaceFixture(db.orm);
      const b = await createWorkspaceFixture(db.orm);

      // Both workspaces already hold an ENG team: the key is reusable across workspaces.
      expect(a.teams.eng.key).toBe('ENG');
      expect(b.teams.eng.key).toBe('ENG');
      expect(a.teams.eng.id).not.toBe(b.teams.eng.id);

      const duplicate = db.orm
        .insert(team)
        .values({ workspaceId: a.workspaceId, key: 'ENG', name: 'Engineering again' });

      await expect(duplicate.then(() => 'inserted').catch(pgErrorCode)).resolves.toBe('23505');
    });
  });

  it('a team key must be 1-7 upper-case letters or digits starting with a letter', async () => {
    await withTempDatabase(async (db) => {
      const a = await createWorkspaceFixture(db.orm);
      const insertKey = (key: string) =>
        db.orm
          .insert(team)
          .values({ workspaceId: a.workspaceId, key, name: `Team ${key}` })
          .then(() => 'inserted')
          .catch(pgErrorCode);

      await expect(insertKey('eng2')).resolves.toBe('23514');
      await expect(insertKey('1ENG')).resolves.toBe('23514');
      await expect(insertKey('TOOLONG8')).resolves.toBe('23514');
      await expect(insertKey('OK')).resolves.toBe('inserted');
      await expect(insertKey('SEVEN07')).resolves.toBe('inserted');
    });
  });

  it('issue priority must be between 0 and 4 and numbers are unique per team', async () => {
    await withTempDatabase(async (db) => {
      const a = await createWorkspaceFixture(db.orm);
      const insertIssue = (number: number, priority: number) =>
        db.orm
          .insert(issue)
          .values({
            workspaceId: a.workspaceId,
            teamId: a.teams.eng.id,
            number,
            title: `Issue ${number}`,
            stateId: a.states.eng.backlog.id,
            creatorId: a.members.owner.id,
            priority,
          })
          .then(() => 'inserted')
          .catch(pgErrorCode);

      await expect(insertIssue(10, 5)).resolves.toBe('23514');
      await expect(insertIssue(10, -1)).resolves.toBe('23514');
      await expect(insertIssue(10, 4)).resolves.toBe('inserted');
      // Number 10 is now taken in ENG; the fixture already holds 1..3.
      await expect(insertIssue(10, 0)).resolves.toBe('23505');
      await expect(insertIssue(1, 0)).resolves.toBe('23505');
    });
  });

  it('a session or sign-in token cannot point at a member of another workspace', async () => {
    await withTempDatabase(async (db) => {
      const a = await createWorkspaceFixture(db.orm);
      const b = await createWorkspaceFixture(db.orm);
      const expiresAt = new Date(Date.now() + 60_000);

      const tokenInsertion = db.orm.insert(loginToken).values({
        workspaceId: a.workspaceId,
        memberId: b.members.owner.id,
        tokenHash: 'a'.repeat(64),
        expiresAt,
      });
      const sessionInsertion = db.orm.insert(session).values({
        workspaceId: a.workspaceId,
        memberId: b.members.owner.id,
        tokenHash: 'b'.repeat(64),
        expiresAt,
      });

      await expect(tokenInsertion.then(() => 'inserted').catch(pgErrorCode)).resolves.toBe('23503');
      await expect(sessionInsertion.then(() => 'inserted').catch(pgErrorCode)).resolves.toBe(
        '23503',
      );
    });
  });

  it('deleting a member removes their team memberships, sign-in tokens and sessions', async () => {
    await withTempDatabase(async (db) => {
      const a = await createWorkspaceFixture(db.orm);
      const guest = a.members.guest;
      const expiresAt = new Date(Date.now() + 60_000);
      await db.orm.insert(loginToken).values({
        workspaceId: a.workspaceId,
        memberId: guest.id,
        tokenHash: 'c'.repeat(64),
        expiresAt,
      });
      await db.orm.insert(session).values({
        workspaceId: a.workspaceId,
        memberId: guest.id,
        tokenHash: 'd'.repeat(64),
        expiresAt,
      });

      await db.orm.delete(member).where(eq(member.id, guest.id));

      const count = async (table: typeof teamMember | typeof loginToken | typeof session) => {
        const rows = await db.orm
          .select({ n: sql<number>`count(*)::int` })
          .from(table)
          .where(eq(table.memberId, guest.id));
        return rows[0]?.n;
      };
      expect(await count(teamMember)).toBe(0);
      expect(await count(loginToken)).toBe(0);
      expect(await count(session)).toBe(0);
    });
  });

  it('createWorkspaceFixture builds two independent workspaces', async () => {
    await withTempDatabase(async (db) => {
      const a = await createWorkspaceFixture(db.orm);
      const b = await createWorkspaceFixture(db.orm);

      const idsOf = (f: typeof a) => [
        f.workspaceId,
        ...Object.values(f.members).map((row) => row.id),
        ...Object.values(f.teams).map((row) => row.id),
        ...Object.values(f.states.eng).map((row) => row.id),
        ...Object.values(f.states.ops).map((row) => row.id),
        ...f.issues.eng.map((row) => row.id),
        ...f.issues.ops.map((row) => row.id),
      ];
      const idsA = idsOf(a);
      expect(new Set(idsA).size).toBe(idsA.length);
      expect(idsOf(b).filter((id) => idsA.includes(id))).toEqual([]);

      expect(a.teams.eng.private).toBe(false);
      expect(a.teams.ops.private).toBe(true);
      expect(a.members.guest.role).toBe('guest');
      expect(a.members.outsider.role).toBe('member');
      for (const row of Object.values(a.members)) {
        expect(row.email).toMatch(/^[a-z]+-[a-z0-9]+@example\.test$/);
        expect(row.workspaceId).toBe(a.workspaceId);
      }

      const memberIdsOf = async (teamId: string) => {
        const rows = await db.orm
          .select({ memberId: teamMember.memberId })
          .from(teamMember)
          .where(and(eq(teamMember.teamId, teamId), eq(teamMember.workspaceId, a.workspaceId)));
        return rows.map((row) => row.memberId).sort();
      };
      const sorted = (...ids: string[]) => ids.sort();
      expect(await memberIdsOf(a.teams.eng.id)).toEqual(
        sorted(a.members.owner.id, a.members.admin.id, a.members.member.id, a.members.guest.id),
      );
      expect(await memberIdsOf(a.teams.ops.id)).toEqual(
        sorted(a.members.owner.id, a.members.member.id),
      );

      for (const key of ['eng', 'ops'] as const) {
        expect(a.issues[key]).toHaveLength(3);
        expect(a.issues[key].map((row) => row.number)).toEqual([1, 2, 3]);
        expect(a.teams[key].issueCounter).toBe(3);
        expect(Object.keys(a.states[key]).sort()).toEqual(
          ['backlog', 'canceled', 'completed', 'started', 'triage', 'unstarted'].sort(),
        );
      }

      const slugs = await db.orm.select({ slug: workspace.slug }).from(workspace);
      expect(new Set(slugs.map((row) => row.slug)).size).toBe(2);
    });
  });

  describe('invites and the audit log', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const hash = (n: number) => String(n).padStart(64, '0');
    const inviteRow = (
      workspaceId: string,
      invitedBy: string,
      over: Partial<typeof invite.$inferInsert> = {},
    ): typeof invite.$inferInsert => ({
      workspaceId,
      email: 'invitee@example.test',
      role: 'member',
      tokenHash: hash(1),
      invitedBy,
      expiresAt: new Date(Date.now() + 7 * DAY),
      ...over,
    });

    it('an invite email must be stored lower-case and trimmed', async () => {
      await withTempDatabase(async (db) => {
        const a = await createWorkspaceFixture(db.orm);
        const insertEmail = (email: string) =>
          db.orm
            .insert(invite)
            .values(inviteRow(a.workspaceId, a.members.owner.id, { email }))
            .then(() => 'inserted')
            .catch(pgErrorCode);

        await expect(insertEmail(' padded@example.test ')).resolves.toBe('23514');
        await expect(insertEmail('Capitals@Example.test')).resolves.toBe('23514');
        await expect(insertEmail('clean@example.test')).resolves.toBe('inserted');
      });
    });

    it('one pending invite per email per workspace; a revoked or accepted one does not block a new one', async () => {
      await withTempDatabase(async (db) => {
        const a = await createWorkspaceFixture(db.orm);
        const b = await createWorkspaceFixture(db.orm);
        const owner = a.members.owner.id;
        const insertInvite = (n: number, workspace = a) =>
          db.orm
            .insert(invite)
            .values(
              inviteRow(workspace.workspaceId, workspace.members.owner.id, { tokenHash: hash(n) }),
            )
            .returning({ id: invite.id })
            .then((rows) => rows[0]?.id ?? 'no row')
            .catch((error) => pgErrorCode(error) ?? 'unknown error');

        const first = await insertInvite(1);
        expect(first).toMatch(/^[0-9a-f-]{36}$/);
        // Same email, still pending: refused.
        await expect(insertInvite(2)).resolves.toBe('23505');
        // The same email in another workspace is a different invite.
        await expect(insertInvite(3, b)).resolves.toMatch(/^[0-9a-f-]{36}$/);

        // Revoked: a new invite for the same email is allowed again.
        await db.orm.update(invite).set({ revokedAt: new Date() }).where(eq(invite.id, first));
        const second = await insertInvite(4);
        expect(second).toMatch(/^[0-9a-f-]{36}$/);
        await expect(insertInvite(5)).resolves.toBe('23505');

        // Accepted: same.
        await db.orm
          .update(invite)
          .set({ acceptedAt: new Date(), acceptedMemberId: owner })
          .where(eq(invite.id, second));
        await expect(insertInvite(6)).resolves.toMatch(/^[0-9a-f-]{36}$/);
      });
    });

    it('an invite cannot name an inviter or an accepted member of another workspace', async () => {
      await withTempDatabase(async (db) => {
        const a = await createWorkspaceFixture(db.orm);
        const b = await createWorkspaceFixture(db.orm);
        const attempt = (
          over: Partial<typeof invite.$inferInsert>,
          invitedBy = a.members.owner.id,
        ) =>
          db.orm
            .insert(invite)
            .values(inviteRow(a.workspaceId, invitedBy, over))
            .then(() => 'inserted')
            .catch(pgErrorCode);

        await expect(attempt({}, b.members.owner.id)).resolves.toBe('23503');
        await expect(
          attempt({ acceptedAt: new Date(), acceptedMemberId: b.members.owner.id }),
        ).resolves.toBe('23503');
        await expect(
          attempt({ acceptedAt: new Date(), acceptedMemberId: a.members.member.id }),
        ).resolves.toBe('inserted');
      });
    });

    it('an invite_team row cannot point at a team of another workspace', async () => {
      await withTempDatabase(async (db) => {
        const a = await createWorkspaceFixture(db.orm);
        const b = await createWorkspaceFixture(db.orm);
        const [created] = await db.orm
          .insert(invite)
          .values(inviteRow(a.workspaceId, a.members.owner.id))
          .returning();
        if (!created) throw new Error('invite insert returned no row');
        const link = (workspaceId: string, teamId: string, inviteId = created.id) =>
          db.orm
            .insert(inviteTeam)
            .values({ workspaceId, inviteId, teamId })
            .then(() => 'inserted')
            .catch(pgErrorCode);

        await expect(link(a.workspaceId, b.teams.eng.id)).resolves.toBe('23503');
        // The invite itself belongs to workspace A: naming workspace B for the row does not work either.
        await expect(link(b.workspaceId, b.teams.eng.id)).resolves.toBe('23503');
        await expect(link(a.workspaceId, a.teams.eng.id)).resolves.toBe('inserted');
        // One team once per invite.
        await expect(link(a.workspaceId, a.teams.eng.id)).resolves.toBe('23505');
      });
    });

    it('deleting an invite removes its team links', async () => {
      await withTempDatabase(async (db) => {
        const a = await createWorkspaceFixture(db.orm);
        const [created] = await db.orm
          .insert(invite)
          .values(inviteRow(a.workspaceId, a.members.owner.id))
          .returning();
        if (!created) throw new Error('invite insert returned no row');
        await db.orm
          .insert(inviteTeam)
          .values({ workspaceId: a.workspaceId, inviteId: created.id, teamId: a.teams.eng.id });

        await db.orm.delete(invite).where(eq(invite.id, created.id));

        const rows = await db.orm
          .select()
          .from(inviteTeam)
          .where(eq(inviteTeam.inviteId, created.id));
        expect(rows).toEqual([]);
      });
    });

    it('an audit row cannot name an actor of another workspace', async () => {
      await withTempDatabase(async (db) => {
        const a = await createWorkspaceFixture(db.orm);
        const b = await createWorkspaceFixture(db.orm);
        const record = (actorMemberId: string | null, workspaceId = a.workspaceId) =>
          db.orm
            .insert(auditLog)
            .values({
              workspaceId,
              actorMemberId,
              action: 'member.role_changed',
              targetType: 'member',
              targetId: a.members.member.id,
            })
            .then(() => 'inserted')
            .catch(pgErrorCode);

        await expect(record(b.members.owner.id)).resolves.toBe('23503');
        await expect(record(a.members.owner.id)).resolves.toBe('inserted');
        // A system action has no actor; the workspace must still exist.
        await expect(record(null)).resolves.toBe('inserted');
        await expect(record(null, '00000000-0000-4000-8000-0000000000ff')).resolves.toBe('23503');
      });
    });

    it('audit metadata defaults to an empty object and rows read back newest first through the index key', async () => {
      await withTempDatabase(async (db) => {
        const a = await createWorkspaceFixture(db.orm);
        await db.orm.insert(auditLog).values({
          workspaceId: a.workspaceId,
          actorMemberId: a.members.owner.id,
          action: 'team.created',
          targetType: 'team',
        });

        const [row] = await db.orm
          .select()
          .from(auditLog)
          .where(eq(auditLog.workspaceId, a.workspaceId));

        expect(row?.metadata).toEqual({});
        expect(row?.targetId).toBeNull();
        const indexes = await db.pool.query<{ indexname: string }>(
          "select indexname from pg_indexes where tablename = 'audit_log'",
        );
        expect(indexes.rows.map((r) => r.indexname)).toContain('audit_log_workspace_created_idx');
      });
    });
  });

  it('createWorkspaceFixture honours email overrides', async () => {
    await withTempDatabase(async (db) => {
      const a = await createWorkspaceFixture(db.orm, {
        email: { owner: 'shared@example.test' },
      });
      const b = await createWorkspaceFixture(db.orm, {
        email: { owner: 'shared@example.test' },
      });

      expect(a.members.owner.email).toBe('shared@example.test');
      expect(b.members.owner.email).toBe('shared@example.test');
      expect(a.members.admin.email).not.toBe('shared@example.test');
    });
  });
});
