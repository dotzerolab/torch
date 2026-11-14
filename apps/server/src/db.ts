import * as schema from '@torch/shared/db/schema';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';

export type DbHealth = { status: 'ok'; walLevel: 'logical' } | { status: 'error'; reason: string };

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

/** Both sync-engine candidates replicate from the WAL, so anything but "logical" is a setup error. */
export function interpretWalLevel(walLevel: string): DbHealth {
  if (walLevel === 'logical') return { status: 'ok', walLevel: 'logical' };
  return {
    status: 'error',
    reason: `wal_level is "${walLevel}", expected "logical" (start Postgres with -c wal_level=logical)`,
  };
}

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
        const result = await pool.query<{ wal_level: string }>(
          "select current_setting('wal_level') as wal_level",
        );
        return interpretWalLevel(result.rows[0]?.wal_level ?? '');
      } catch (error) {
        // The caller is unauthenticated: the log gets the detail, the response only the category.
        console.error('database health check failed:', (error as Error).message);
        return { status: 'error', reason: 'cannot reach the database' };
      }
    },
    close,
  };
}
