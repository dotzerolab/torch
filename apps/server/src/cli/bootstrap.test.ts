import { member, workspace } from '@torch/shared/db/schema';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withTempDatabase } from '../test/fixtures.ts';
import { bootstrapWorkspace, parseBootstrapArgs } from './bootstrap.ts';

const databaseUrl = process.env.DATABASE_URL;

// Integration: needs the dev compose Postgres (see db.test.ts). Skipped, loudly, when DATABASE_URL is not set.
if (!databaseUrl) {
  console.warn(
    '[bootstrap.test] SKIPPED the bootstrap integration tests: DATABASE_URL is not set. ' +
      'Start `docker compose -f docker-compose.dev.yml up -d --wait postgres` and set DATABASE_URL (see .env.example).',
  );
}

const input = {
  name: 'Acme Studio',
  slug: 'acme-studio',
  ownerEmail: '  Founder@Example.Test ',
  ownerName: 'Fiona Founder',
};

describe.skipIf(!databaseUrl)('bootstrapWorkspace (Postgres)', () => {
  it('bootstrapWorkspace creates workspace and owner with a normalised email', async () => {
    await withTempDatabase(async (db) => {
      const result = await bootstrapWorkspace(db.orm, input);

      const [ws] = await db.orm
        .select()
        .from(workspace)
        .where(eq(workspace.id, result.workspaceId));
      const [owner] = await db.orm.select().from(member).where(eq(member.id, result.memberId));
      expect(ws).toMatchObject({ name: 'Acme Studio', slug: 'acme-studio' });
      expect(owner).toMatchObject({
        workspaceId: result.workspaceId,
        email: 'founder@example.test',
        name: 'Fiona Founder',
        role: 'owner',
        locale: 'en',
        deactivatedAt: null,
      });
      expect(owner?.handle).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    });
  });

  it('bootstrapWorkspace refuses an existing slug', async () => {
    await withTempDatabase(async (db) => {
      await bootstrapWorkspace(db.orm, input);

      await expect(
        bootstrapWorkspace(db.orm, { ...input, ownerEmail: 'other@example.test' }),
      ).rejects.toThrow(/already exists/);

      const counts = await db.orm.select({ n: sql<number>`count(*)::int` }).from(workspace);
      expect(counts[0]?.n).toBe(1);
    });
  });

  it.each([
    ['slug', { slug: 'Not A Slug' }],
    ['slug', { slug: 'x' }],
    ['email', { ownerEmail: 'not-an-email' }],
    ['name', { name: '   ' }],
    ['owner name', { ownerName: '' }],
  ])('rejects an invalid %s and writes nothing', async (_field, override) => {
    await withTempDatabase(async (db) => {
      await expect(bootstrapWorkspace(db.orm, { ...input, ...override })).rejects.toThrow();

      const counts = await db.orm.select({ n: sql<number>`count(*)::int` }).from(workspace);
      expect(counts[0]?.n).toBe(0);
    });
  });
});

describe('parseBootstrapArgs', () => {
  it('reads the four options', () => {
    const parsed = parseBootstrapArgs([
      '--name',
      'Acme Studio',
      '--slug',
      'acme-studio',
      '--email',
      'founder@example.test',
      '--owner-name',
      'Fiona Founder',
    ]);

    expect(parsed).toEqual({
      name: 'Acme Studio',
      slug: 'acme-studio',
      ownerEmail: 'founder@example.test',
      ownerName: 'Fiona Founder',
    });
  });

  it('names the missing option', () => {
    expect(() => parseBootstrapArgs(['--name', 'Acme', '--slug', 'acme'])).toThrow(/--email/);
  });

  it('rejects an unknown option', () => {
    expect(() =>
      parseBootstrapArgs([
        '--name',
        'A',
        '--slug',
        'a',
        '--email',
        'a@example.test',
        '--owner-name',
        'A',
        '--oops',
        'x',
      ]),
    ).toThrow();
  });
});
