// Vitest globalSetup: with DATABASE_URL set, bring the dev database to the latest schema once per run,
// so every database test starts from migrated tables. Without it the database tests skip themselves.
import { runMigrations } from '../apps/server/src/db/migrate.ts';

export default async function setup(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl) await runMigrations(databaseUrl);
}
