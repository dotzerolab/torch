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

/** One connection pool, shared by the Drizzle handle and by code that needs raw SQL. */
export function createDb(databaseUrl: string): Db {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 5,
    connectionTimeoutMillis: 3000,
  });
  pool.on('error', (error) => console.error('database pool error:', error.message));

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
    close: () => pool.end(),
  };
}
