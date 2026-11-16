import { issue } from '@torch/shared/db/schema';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { openSession } from '../test/admin-helpers.ts';
import { createAuthTestApp } from '../test/auth-app.ts';
import { createWorkspaceFixture, withTempDatabase } from '../test/fixtures.ts';

const databaseUrl = process.env.DATABASE_URL;

// Integration: needs the dev compose Postgres (see db.test.ts). Skipped, loudly, when DATABASE_URL is not set.
if (!databaseUrl) {
  console.warn(
    '[issues/routes.test] SKIPPED the issue route tests: DATABASE_URL is not set. ' +
      'Start `docker compose -f docker-compose.dev.yml up -d --wait postgres` and set DATABASE_URL (see .env.example).',
  );
}

type Created = {
  issue: { id: string; identifier: string; number: number; title: string; priority: number };
  txid: number;
};
const created = async (res: Response) => (await res.json()) as Created;

describe.skipIf(!databaseUrl)('POST /api/w/:workspaceId/issues', () => {
  async function setup(db: Parameters<Parameters<typeof withTempDatabase>[0]>[0]) {
    const f = await createWorkspaceFixture(db.orm);
    const t = createAuthTestApp(db);
    const cookie = (await openSession(db.orm, f.workspaceId, f.members.member.id)).cookie;
    const path = `/api/w/${f.workspaceId}/issues`;
    return { f, t, cookie, path };
  }

  it('creates an issue: 201 with the issue and a transaction id, never cached', async () => {
    await withTempDatabase(async (db) => {
      const { f, t, cookie, path } = await setup(db);

      const res = await t.post(
        path,
        { teamId: f.teams.eng.id, title: 'Over HTTP', priority: 3 },
        { cookie },
      );

      expect(res.status).toBe(201);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('idempotent-replayed')).toBeNull();
      const body = await created(res);
      expect(body.issue).toMatchObject({
        identifier: 'ENG-4',
        number: 4,
        title: 'Over HTTP',
        priority: 3,
        creatorId: f.members.member.id,
      });
      expect(Number.isInteger(body.txid)).toBe(true);
    });
  });

  it('Idempotency-Key: the second call replays the answer and says so', async () => {
    await withTempDatabase(async (db) => {
      const { f, t, cookie, path } = await setup(db);
      const headers = { 'idempotency-key': 'abc-123' };
      const body = { teamId: f.teams.eng.id, title: 'Replayed' };

      const first = await t.post(path, body, { cookie, headers });
      const second = await t.post(path, body, { cookie, headers });

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.headers.get('idempotent-replayed')).toBe('true');
      expect((await created(second)).issue.id).toBe((await created(first)).issue.id);
      expect(await db.orm.select().from(issue).where(eq(issue.title, 'Replayed'))).toHaveLength(1);
    });
  });

  it('the same key with another body is 422 idempotency_key_reused', async () => {
    await withTempDatabase(async (db) => {
      const { f, t, cookie, path } = await setup(db);
      const headers = { 'idempotency-key': 'abc-123' };

      await t.post(path, { teamId: f.teams.eng.id, title: 'One' }, { cookie, headers });
      const res = await t.post(path, { teamId: f.teams.eng.id, title: 'Two' }, { cookie, headers });

      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({ error: 'idempotency_key_reused' });
    });
  });

  it.each(['', 'x'.repeat(129)])(
    'an Idempotency-Key of %s characters is 400 invalid_input',
    async (key) => {
      await withTempDatabase(async (db) => {
        const { f, t, cookie, path } = await setup(db);

        const res = await t.post(
          path,
          { teamId: f.teams.eng.id, title: 'Keyed' },
          { cookie, headers: { 'idempotency-key': key } },
        );

        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ error: 'invalid_input' });
        expect(await db.orm.select().from(issue).where(eq(issue.title, 'Keyed'))).toEqual([]);
      });
    },
  );

  it('answers the documented error bodies', async () => {
    await withTempDatabase(async (db) => {
      const { f, t, cookie, path } = await setup(db);
      const other = await createWorkspaceFixture(db.orm);
      await t.post(
        path,
        { teamId: f.teams.eng.id, title: 'First', externalRef: { source: 'tracker', id: 'R1' } },
        { cookie },
      );

      const invalid = await t.post(path, { teamId: f.teams.eng.id }, { cookie });
      const notJson = await t.post(path, 'not json', { cookie });
      const unknownKey = await t.post(
        path,
        { teamId: f.teams.eng.id, title: 'X', number: 99 },
        { cookie },
      );
      const reference = await t.post(
        path,
        { teamId: f.teams.eng.id, title: 'X', stateId: f.states.ops.backlog.id },
        { cookie },
      );
      const conflict = await t.post(
        path,
        { teamId: f.teams.eng.id, title: 'Dup', externalRef: { source: 'tracker', id: 'R1' } },
        { cookie },
      );
      const foreignTeam = await t.post(
        path,
        { teamId: other.teams.eng.id, title: 'X' },
        { cookie },
      );
      const anonymous = await t.post(path, { teamId: f.teams.eng.id, title: 'X' });

      expect([invalid, notJson, unknownKey].map((res) => res.status)).toEqual([400, 400, 400]);
      expect(await invalid.json()).toMatchObject({
        error: 'invalid_input',
        message: expect.any(String),
      });
      expect(reference.status).toBe(422);
      expect(await reference.json()).toEqual({
        error: 'invalid_reference',
        message: expect.any(String),
        details: { field: 'stateId' },
      });
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toMatchObject({
        error: 'external_ref_exists',
        details: { identifier: 'ENG-4' },
      });
      expect(foreignTeam.status).toBe(404);
      expect(await foreignTeam.json()).toMatchObject({ error: 'not_found' });
      expect(anonymous.status).toBe(401);
      expect(await anonymous.json()).toMatchObject({ error: 'unauthenticated' });
    });
  });

  it('accepts a description up to 100000 characters and refuses larger bodies', async () => {
    await withTempDatabase(async (db) => {
      const { f, t, cookie, path } = await setup(db);

      const large = await t.post(
        path,
        { teamId: f.teams.eng.id, title: 'Large', description: 'x'.repeat(100_000) },
        { cookie },
      );
      const tooLong = await t.post(
        path,
        { teamId: f.teams.eng.id, title: 'Long', description: 'x'.repeat(100_001) },
        { cookie },
      );
      const tooBig = await t.post(
        path,
        { teamId: f.teams.eng.id, title: 'Big', description: 'x'.repeat(600_000) },
        { cookie },
      );

      expect(large.status).toBe(201);
      expect(tooLong.status).toBe(400);
      expect(tooBig.status).toBe(413);
      expect(await tooBig.json()).toMatchObject({ error: 'invalid_input' });
    });
  });
});
