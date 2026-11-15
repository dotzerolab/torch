import * as schema from '@torch/shared/db/schema';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';

export type DbHealth =
  | { status: 'ok'; walLevel: 'logical'; replication: true }
  | { status: 'error'; reason: string };

/** Drizzle handle with the full schema; what every query function in the server takes. */
export type Orm = NodePgDatabase<typeof schema>;

/** The handle inside `orm.transaction(...)`: what a service function writes with, so action and audit row commit together. */
export type Tx = Parameters<Parameters<Orm['transaction']>[0]>[0];

export type Db = {
  health(): Promise<DbHealth>;
  close(): Promise<void>;
  orm: Orm;
  pool: pg.Pool;
};

/** What the health query returns: the WAL level and whether the connecting role may start replication. */
export type HealthRow = { wal_level: string; role: string; can_replicate: boolean };

/**
 * The sync service replicates from the WAL, so the server needs `wal_level=logical`, and the role that connects needs
 * the REPLICATION attribute (a superuser, or on Amazon RDS a member of `rds_replication`, may replicate without it;
 * the query folds both into `can_replicate`). The
 * WAL level is reported first: with `replica` nothing else matters until Postgres is restarted.
 */
export function interpretHealth(row: HealthRow): DbHealth {
  if (row.wal_level !== 'logical') {
    return {
      status: 'error',
      reason: `wal_level is "${row.wal_level}", expected "logical" (start Postgres with -c wal_level=logical)`,
    };
  }
  if (!row.can_replicate) {
    return {
      status: 'error',
      reason:
        `role "${row.role}" lacks the REPLICATION privilege the sync service needs ` +
        `(ALTER ROLE ${row.role} WITH REPLICATION), or point the sync service at a role that has it`,
    };
  }
  return { status: 'ok', walLevel: 'logical', replication: true };
}

/**
 * One round trip for both settings; the scalar subquery keeps the row even if the role cannot be read. A role may
 * replicate through the REPLICATION attribute, through superuser, or, on Amazon RDS and Aurora, through membership of
 * `rds_replication` (the provider's documented way to give the privilege to a role other than its default user).
 */
const HEALTH_QUERY = `
  select
    current_setting('wal_level') as wal_level,
    current_user as role,
    coalesce((
      select r.rolreplication
        or r.rolsuper
        or exists (
          select 1 from pg_roles m
          where m.rolname = 'rds_replication' and pg_has_role(current_user, m.oid, 'member')
        )
      from pg_roles r where r.rolname = current_user
    ), false) as can_replicate
`;

/** Longest `close` waits for the sockets to close after the pool let go of its clients. */
const POOL_CLOSE_TIMEOUT_MS = 5000;

/**
 * A pool that always has an error listener (a pool without one turns the error of an idle client, such as the
 * server cutting it, into an uncaught exception) and a `close` that resolves only when every connection is closed.
 * `pool.end()` alone resolves as soon as the pool lets go of its clients, while their sockets are still open and the
 * server backends alive; a `drop database ... with (force)` right after then cuts those backends with 57P01
 * (`terminating connection due to administrator command`). Use this for every pool, never `new pg.Pool`.
 */
export function createPool(options: pg.PoolConfig): { pool: pg.Pool; close(): Promise<void> } {
  const pool = new pg.Pool(options);
  pool.on('error', (error) => console.error('database pool error:', error.message));

  const open = new Set<pg.PoolClient>();
  pool.on('connect', (client) => {
    open.add(client);
    client.once('end', () => open.delete(client));
  });

  return {
    pool,
    async close() {
      await pool.end();
      const closed = [...open].map(
        (client) => new Promise<void>((resolve) => client.once('end', resolve)),
      );
      let timer: NodeJS.Timeout | undefined;
      const gaveUp = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, POOL_CLOSE_TIMEOUT_MS);
      });
      await Promise.race([Promise.all(closed), gaveUp]);
      clearTimeout(timer);
    },
  };
}

/** One connection pool, shared by the Drizzle handle and by code that needs raw SQL. */
export function createDb(databaseUrl: string): Db {
  const { pool, close } = createPool({
    connectionString: databaseUrl,
    max: 5,
    connectionTimeoutMillis: 3000,
  });

  return {
    orm: drizzle({ client: pool, schema }),
    pool,
    async health() {
      try {
        const result = await pool.query<HealthRow>(HEALTH_QUERY);
        const row = result.rows[0];
        return interpretHealth(row ?? { wal_level: '', role: '', can_replicate: false });
      } catch (error) {
        // The caller is unauthenticated: the log gets the detail, the response only the category.
        console.error('database health check failed:', (error as Error).message);
        return { status: 'error', reason: 'cannot reach the database' };
      }
    },
    close,
  };
}
