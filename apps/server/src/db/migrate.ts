// Explicit migrations: the server never migrates by itself. `pnpm --filter @torch/server db:migrate`
// applies every pending file in apps/server/migrations to DATABASE_URL; a second run changes nothing.
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createPool } from '../db.ts';

const migrationsFolder = fileURLToPath(new URL('../../migrations', import.meta.url));

export async function runMigrations(databaseUrl: string): Promise<void> {
  const { pool, close } = createPool({ connectionString: databaseUrl, max: 1 });
  try {
    await migrate(drizzle({ client: pool }), { migrationsFolder });
  } finally {
    await close();
  }
}

if (import.meta.main) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set (see .env.example)');
    process.exit(1);
  }
  await runMigrations(databaseUrl);
  console.info('migrations applied');
}
