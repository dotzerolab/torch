import { team, teamMember } from '@torch/shared/db/schema';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { Db } from '../db.ts';
import { openSession } from '../test/admin-helpers.ts';
import { createAuthTestApp } from '../test/auth-app.ts';
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
  withTempDatabase,
} from '../test/fixtures.ts';

const databaseUrl = process.env.DATABASE_URL;

// Integration: needs the dev compose Postgres (see db.test.ts). Skipped, loudly, when DATABASE_URL is not set.
if (!databaseUrl) {
  console.warn(
    '[teams/routes.test] SKIPPED the team route tests: DATABASE_URL is not set. ' +
      'Start `docker compose -f docker-compose.dev.yml up -d --wait postgres` and set DATABASE_URL (see .env.example).',
  );
}

const UNKNOWN_UUID = '99999999-9999-4999-8999-999999999999';

type Who = keyof WorkspaceFixture['members'];

/** The five team routes with a valid body each, for a workspace, one team and one person. */
const routesOf = (workspaceId: string, teamId: string, memberId: string) =>
  [
    ['POST', `/api/w/${workspaceId}/teams`, { key: 'DOCS', name: 'Docs' }],
    ['PATCH', `/api/w/${workspaceId}/teams/${teamId}`, { name: 'Renamed' }],
    ['POST', `/api/w/${workspaceId}/teams/${teamId}/members`, { memberId }],
    ['DELETE', `/api/w/${workspaceId}/teams/${teamId}/members/${memberId}`, undefined],
    ['GET', `/api/w/${workspaceId}/admin/teams`, undefined],
  ] as const;

async function setup(db: Db) {
  const f = await createWorkspaceFixture(db.orm);
  const t = createAuthTestApp(db);
  const as = async (who: Who) =>
    (await openSession(db.orm, f.workspaceId, f.members[who].id)).cookie;
  return { f, t, as };
}

const membersOf = async (db: Db, teamId: string) =>
  (await db.orm.select().from(teamMember).where(eq(teamMember.teamId, teamId)))
    .map((row) => row.memberId)
    .sort();

describe.skipIf(!databaseUrl)('team routes', () => {
  it('every route answers 401 without a cookie, with a garbage cookie, and with a cookie of another workspace', async () => {
    await withTempDatabase(async (db) => {
      const { f, t } = await setup(db);
      const other = await createWorkspaceFixture(db.orm);
      const foreign = await openSession(db.orm, other.workspaceId, other.members.owner.id);

      for (const [method, path, body] of routesOf(
        f.workspaceId,
        f.teams.eng.id,
        f.members.outsider.id,
      )) {
        for (const [label, cookie] of [
          ['no cookie', undefined],
          ['garbage cookie', 'sid=not-a-token'],
          ['cookie of another workspace', foreign.cookie],
        ] as const) {
          const res = await t.request(method, path, body, { cookie });
          expect(res.status, `${method} ${path} ${label}`).toBe(401);
          expect(await res.json()).toMatchObject({ error: 'unauthenticated' });
        }
      }
      expect(await membersOf(db, f.teams.eng.id)).not.toContain(f.members.outsider.id);
    });
  });

  it('every answer of the team routes is no-store, refusals and the private-team directory included', async () => {
    await withTempDatabase(async (db) => {
      const { f, t, as } = await setup(db);
      const owner = await as('owner');
      const member = await as('member');

      for (const [method, path, body] of routesOf(
        f.workspaceId,
        f.teams.eng.id,
        f.members.member.id,
      )) {
        for (const [label, cookie] of [
          ['owner', owner],
          ['member', member],
          ['no cookie', undefined],
        ] as const) {
          const res = await t.request(method, path, body, { cookie });
          expect(res.headers.get('cache-control'), `${method} ${path} ${label} ${res.status}`).toBe(
            'no-store',
          );
        }
      }
    });
  });

  it('POST /teams: owner and admin get 201 with the team id and a txid; member and guest get 403', async () => {
    await withTempDatabase(async (db) => {
      const { f, t, as } = await setup(db);
      const url = `/api/w/${f.workspaceId}/teams`;

      const created = await t.request(
        'POST',
        url,
        { key: 'DOCS', name: 'Docs' },
        {
          cookie: await as('owner'),
        },
      );
      expect(created.status).toBe(201);
      const body = (await created.json()) as { teamId: string; txid: number };
      expect(Number.isInteger(body.txid) && body.txid > 0).toBe(true);
      const [stored] = await db.orm.select().from(team).where(eq(team.id, body.teamId));
      expect(stored).toMatchObject({ key: 'DOCS', name: 'Docs', workspaceId: f.workspaceId });

      const byAdmin = await t.request(
        'POST',
        url,
        { key: 'DSGN', name: 'Design' },
        {
          cookie: await as('admin'),
        },
      );
      expect(byAdmin.status).toBe(201);
      for (const who of ['member', 'guest'] as const) {
        const res = await t.request(
          'POST',
          url,
          { key: 'NOPE', name: 'No' },
          {
            cookie: await as(who),
          },
        );
        expect(res.status, who).toBe(403);
        expect(await res.json()).toEqual({ error: 'forbidden', message: expect.any(String) });
      }
    });
  });

  it('POST /teams refusals: duplicate key 409, bad key, unknown field and bad JSON 400', async () => {
    await withTempDatabase(async (db) => {
      const { f, t, as } = await setup(db);
      const url = `/api/w/${f.workspaceId}/teams`;
      const cookie = await as('owner');

      const cases: [string, unknown, number, string][] = [
        ['duplicate key', { key: 'ENG', name: 'Again' }, 409, 'team_key_taken'],
        ['lower-case key', { key: 'docs', name: 'Docs' }, 400, 'invalid_input'],
        ['unknown field', { key: 'DOCS', name: 'Docs', issueCounter: 99 }, 400, 'invalid_input'],
        ['empty body', {}, 400, 'invalid_input'],
        ['not json', '{nope', 400, 'invalid_input'],
      ];
      for (const [label, body, status, code] of cases) {
        const res = await t.request('POST', url, body, { cookie });
        expect(res.status, label).toBe(status);
        expect(await res.json(), label).toEqual({ error: code, message: expect.any(String) });
      }
      expect(
        await db.orm.select().from(team).where(eq(team.workspaceId, f.workspaceId)),
      ).toHaveLength(2);
    });
  });

  it('PATCH /teams/:id: renames; `key` in the body is 400; a private team the admin is not in is 404', async () => {
    await withTempDatabase(async (db) => {
      const { f, t, as } = await setup(db);
      const url = (id: string) => `/api/w/${f.workspaceId}/teams/${id}`;

      const done = await t.request(
        'PATCH',
        url(f.teams.eng.id),
        { name: 'Platform' },
        {
          cookie: await as('admin'),
        },
      );
      expect(done.status).toBe(200);
      expect(await done.json()).toEqual({ txid: expect.any(Number) });
      const [renamed] = await db.orm.select().from(team).where(eq(team.id, f.teams.eng.id));
      expect(renamed?.name).toBe('Platform');

      const cases: [string, string, unknown, Who, number, string][] = [
        ['key in body', url(f.teams.eng.id), { key: 'NEW' }, 'owner', 400, 'invalid_input'],
        ['empty body', url(f.teams.eng.id), {}, 'owner', 400, 'invalid_input'],
        ['private, admin outside', url(f.teams.ops.id), { name: 'x' }, 'admin', 404, 'not_found'],
        ['member', url(f.teams.eng.id), { name: 'x' }, 'member', 403, 'forbidden'],
        ['unknown id', url(UNKNOWN_UUID), { name: 'x' }, 'owner', 404, 'not_found'],
        ['malformed id', url('not-a-uuid'), { name: 'x' }, 'owner', 404, 'not_found'],
      ];
      for (const [label, path, body, who, status, code] of cases) {
        const res = await t.request('PATCH', path, body, { cookie: await as(who) });
        expect(res.status, label).toBe(status);
        expect(await res.json(), label).toEqual({ error: code, message: expect.any(String) });
      }
    });
  });

  it('POST and DELETE /teams/:id/members: add and remove with a txid; no-ops are 200; bad bodies 400', async () => {
    await withTempDatabase(async (db) => {
      const { f, t, as } = await setup(db);
      const cookie = await as('owner');
      const base = `/api/w/${f.workspaceId}/teams/${f.teams.eng.id}/members`;

      const added = await t.request('POST', base, { memberId: f.members.outsider.id }, { cookie });
      expect(added.status).toBe(200);
      expect(await added.json()).toEqual({ txid: expect.any(Number) });
      expect(await membersOf(db, f.teams.eng.id)).toContain(f.members.outsider.id);
      const again = await t.request('POST', base, { memberId: f.members.outsider.id }, { cookie });
      expect(again.status).toBe(200);
      // An upper-case id in the body is read as the same id.
      const upper = await t.request(
        'POST',
        base,
        { memberId: f.members.outsider.id.toUpperCase() },
        { cookie },
      );
      expect(upper.status).toBe(200);

      for (const body of [{}, { memberId: 'nope' }, { memberId: f.members.outsider.id, x: 1 }]) {
        const res = await t.request('POST', base, body, { cookie });
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(await res.json()).toMatchObject({ error: 'invalid_input' });
      }

      const removed = await t.request('DELETE', `${base}/${f.members.outsider.id}`, undefined, {
        cookie,
      });
      expect(removed.status).toBe(200);
      expect(await removed.json()).toEqual({ txid: expect.any(Number) });
      expect(await membersOf(db, f.teams.eng.id)).not.toContain(f.members.outsider.id);
      const twice = await t.request('DELETE', `${base}/${f.members.outsider.id}`, undefined, {
        cookie,
      });
      expect(twice.status).toBe(200);
    });
  });

  it('membership refusals: member 403, private team outside 404, last member of a private team 409, foreign member and foreign team 404', async () => {
    await withTempDatabase(async (db) => {
      const { f, t, as } = await setup(db);
      const other = await createWorkspaceFixture(db.orm);
      const members = (teamId: string) => `/api/w/${f.workspaceId}/teams/${teamId}/members`;

      const asMember = await t.request(
        'POST',
        members(f.teams.eng.id),
        { memberId: f.members.outsider.id },
        { cookie: await as('member') },
      );
      expect(asMember.status).toBe(403);
      const adminOutsideOps = await t.request(
        'POST',
        members(f.teams.ops.id),
        { memberId: f.members.outsider.id },
        { cookie: await as('admin') },
      );
      expect(adminOutsideOps.status).toBe(404);
      const foreignMember = await t.request(
        'POST',
        members(f.teams.eng.id),
        { memberId: other.members.member.id },
        { cookie: await as('owner') },
      );
      expect(foreignMember.status).toBe(404);
      const foreignTeam = await t.request(
        'POST',
        members(other.teams.eng.id),
        { memberId: f.members.outsider.id },
        { cookie: await as('owner') },
      );
      expect(foreignTeam.status).toBe(404);

      const cookie = await as('owner');
      const first = await t.request(
        'DELETE',
        `${members(f.teams.ops.id)}/${f.members.member.id}`,
        undefined,
        { cookie },
      );
      expect(first.status).toBe(200);
      const last = await t.request(
        'DELETE',
        `${members(f.teams.ops.id)}/${f.members.owner.id}`,
        undefined,
        { cookie },
      );
      expect(last.status).toBe(409);
      expect(await last.json()).toEqual({
        error: 'private_team_needs_member',
        message: expect.any(String),
      });
      expect(await membersOf(db, f.teams.ops.id)).toEqual([f.members.owner.id]);
      expect(await membersOf(db, other.teams.eng.id)).not.toContain(f.members.outsider.id);
    });
  });

  it('an admin adds only themselves to a private team they are not in; the same request for someone else is 404', async () => {
    await withTempDatabase(async (db) => {
      const { f, t, as } = await setup(db);
      const cookie = await as('admin');
      const members = `/api/w/${f.workspaceId}/teams/${f.teams.ops.id}/members`;

      const someoneElse = await t.request(
        'POST',
        members,
        { memberId: f.members.guest.id },
        { cookie },
      );
      expect(someoneElse.status).toBe(404);
      const self = await t.request('POST', members, { memberId: f.members.admin.id }, { cookie });
      expect(self.status).toBe(200);

      expect(await membersOf(db, f.teams.ops.id)).toContain(f.members.admin.id);
      expect(await membersOf(db, f.teams.ops.id)).not.toContain(f.members.guest.id);
      const [joined] = await db.orm
        .select()
        .from(teamMember)
        .where(
          and(eq(teamMember.teamId, f.teams.ops.id), eq(teamMember.memberId, f.members.admin.id)),
        );
      expect(joined).toBeDefined();
    });
  });

  it('GET /admin/teams: owner and admin get the directory, member and guest 403, and nothing else is in it', async () => {
    await withTempDatabase(async (db) => {
      const { f, t, as } = await setup(db);
      const url = `/api/w/${f.workspaceId}/admin/teams`;

      const res = await t.get(url, { cookie: await as('admin') });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        teams: [
          { id: f.teams.ops.id, key: 'OPS', name: 'Operations', memberCount: 2, isMember: false },
        ],
      });
      for (const who of ['member', 'guest'] as const) {
        const denied = await t.get(url, { cookie: await as(who) });
        expect(denied.status, who).toBe(403);
        expect(await denied.json()).toEqual({ error: 'forbidden', message: expect.any(String) });
      }
    });
  });

  it('the directory of another workspace in the URL needs a session of that workspace: 401', async () => {
    await withTempDatabase(async (db) => {
      const { f, t, as } = await setup(db);
      const other = await createWorkspaceFixture(db.orm);

      const res = await t.get(`/api/w/${other.workspaceId}/admin/teams`, {
        cookie: await as('owner'),
      });

      expect(res.status).toBe(401);
      expect(f.workspaceId).not.toBe(other.workspaceId);
    });
  });
});
