import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from './app.ts';
import { createDb, type Db, type DbHealth, interpretHealth } from './db.ts';

const databaseUrl = process.env.DATABASE_URL;

describe('interpretHealth', () => {
  const row = { wal_level: 'logical', role: 'torch_app', can_replicate: true };

  it('accepts logical with a role that can replicate', () => {
    expect(interpretHealth(row)).toEqual({ status: 'ok', walLevel: 'logical', replication: true });
  });

  it.each(['replica', 'minimal', ''])('rejects wal_level "%s" and says what to change', (level) => {
    const health = interpretHealth({ ...row, wal_level: level });

    expect(health.status).toBe('error');
    expect(health).toMatchObject({ reason: expect.stringContaining('wal_level=logical') });
  });

  it('names the role and the REPLICATION privilege when the role cannot replicate', () => {
    const health = interpretHealth({ ...row, can_replicate: false });

    expect(health).toEqual({
      status: 'error',
      reason:
        'role "torch_app" lacks the REPLICATION privilege the sync service needs ' +
        '(ALTER ROLE torch_app WITH REPLICATION), or point the sync service at a role that has it',
    });
  });

  it('reports the WAL level first when both settings are wrong', () => {
    const health = interpretHealth({
      wal_level: 'replica',
      role: 'torch_app',
      can_replicate: false,
    });

    expect(health).toMatchObject({ reason: expect.stringContaining('wal_level=logical') });
  });

  // A superuser passes: the query folds rolsuper into can_replicate, so the row looks like any other that may replicate.
  it('accepts a superuser, which can replicate without the REPLICATION attribute', () => {
    expect(
      interpretHealth({ wal_level: 'logical', role: 'postgres', can_replicate: true }),
    ).toEqual({
      status: 'ok',
      walLevel: 'logical',
      replication: true,
    });
  });
});

describe('createDb health', () => {
  it('reports an unreachable database with a generic reason and logs the detail', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = createDb('postgres://user:s3cret@127.0.0.1:1/nope');

    const health = await db.health();
    await db.close();

    // The endpoint is unauthenticated: no host, port or driver text in the response, only in the log.
    expect(health).toEqual({ status: 'error', reason: 'cannot reach the database' });
    expect(log).toHaveBeenCalledWith(
      'database health check failed:',
      expect.stringContaining('ECONNREFUSED'),
    );
  });
});

// Integration: needs the dev compose Postgres. `docker compose -f docker-compose.dev.yml up -d --wait postgres`,
// then run with DATABASE_URL set (see .env.example). Skipped, loudly, when it is not set.
if (!databaseUrl) {
  console.warn(
    '[db.test] SKIPPED the Postgres integration test: DATABASE_URL is not set. ' +
      'Start `docker compose -f docker-compose.dev.yml up -d --wait postgres` and set DATABASE_URL (see .env.example).',
  );
}

describe.skipIf(!databaseUrl)('Postgres integration (dev compose)', () => {
  it('reports walLevel "logical" and the replication privilege through /health/db', async () => {
    const db = createDb(databaseUrl as string);
    const brand = {
      productName: 'Acme Tasks',
      logoLight: '/l.svg',
      logoDark: '/d.svg',
      favicon: '/f.svg',
      accentColor: '#3366ff',
      emailSenderName: 'Acme Tasks',
      emailSenderAddress: 'no-reply@acme.example',
    };
    try {
      const app = createApp({ brand, db });

      const res = await app.fetch(new Request('http://localhost/health/db'));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'ok', walLevel: 'logical', replication: true });
    } finally {
      await db.close();
    }
  });

  // The query reads pg_roles, so the three cases that matter are checked against a real server: a role with the
  // attribute, a role without it, and a superuser that has the privilege only through rolsuper.
  describe('replication privilege of the connecting role', () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const password = `pw_${suffix}`;
    const roles = {
      plain: `torch_test_plain_${suffix}`,
      replicator: `torch_test_repl_${suffix}`,
      superOnly: `torch_test_super_${suffix}`,
      rdsMember: `torch_test_rds_${suffix}`,
    };
    let admin: Db;

    beforeAll(async () => {
      admin = createDb(databaseUrl as string);
      await admin.pool.query(`create role ${roles.plain} login password '${password}'`);
      await admin.pool.query(
        `create role ${roles.replicator} login replication password '${password}'`,
      );
      await admin.pool.query(
        `create role ${roles.superOnly} login superuser noreplication password '${password}'`,
      );
      // Amazon RDS and Aurora hand out replication through membership of this role, not through the attribute. A
      // real RDS server has it; here it is created once and left alone, because other runs may share the cluster.
      await admin.pool.query(
        `do $$ begin create role rds_replication nologin; exception when duplicate_object then null; end $$`,
      );
      await admin.pool.query(`create role ${roles.rdsMember} login password '${password}'`);
      await admin.pool.query(`grant rds_replication to ${roles.rdsMember}`);
    });

    afterAll(async () => {
      for (const role of Object.values(roles))
        await admin.pool.query(`drop role if exists ${role}`);
      await admin.close();
    });

    async function healthAs(role: string): Promise<DbHealth> {
      const url = new URL(databaseUrl as string);
      url.username = role;
      url.password = password;
      const db = createDb(url.toString());
      try {
        return await db.health();
      } finally {
        await db.close();
      }
    }

    it('fails, naming the role, when it has neither REPLICATION nor superuser', async () => {
      const health = await healthAs(roles.plain);

      expect(health).toMatchObject({
        status: 'error',
        reason: expect.stringContaining(`role "${roles.plain}" lacks the REPLICATION privilege`),
      });
    });

    it('passes for a role with the REPLICATION attribute', async () => {
      expect(await healthAs(roles.replicator)).toEqual({
        status: 'ok',
        walLevel: 'logical',
        replication: true,
      });
    });

    it('passes for a member of rds_replication, which is how managed Amazon Postgres grants it', async () => {
      expect(await healthAs(roles.rdsMember)).toEqual({
        status: 'ok',
        walLevel: 'logical',
        replication: true,
      });
    });

    it('passes for a superuser without the REPLICATION attribute', async () => {
      expect(await healthAs(roles.superOnly)).toEqual({
        status: 'ok',
        walLevel: 'logical',
        replication: true,
      });
    });
  });

  // `pool.end()` alone resolves while the sockets are still open; dropping a database right after then makes the
  // server cut the still-open backends with 57P01, an unhandled error when nothing listens on that client.
  it('close() resolves only once every connection is closed', async () => {
    const db = createDb(databaseUrl as string);
    const ended: boolean[] = [];
    const first = await db.pool.connect();
    const second = await db.pool.connect();
    for (const client of [first, second]) client.once('end', () => ended.push(true));
    first.release();
    second.release();

    await db.close();

    expect(ended).toHaveLength(2);
  });
});
