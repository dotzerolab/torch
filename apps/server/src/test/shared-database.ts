// One throwaway database for a whole test file: the tests inside create their own workspaces (random slug and
// emails), so they never share rows, and the file pays for one migration instead of one per test.
import { afterAll, beforeAll } from 'vitest';
import type { Db } from '../db.ts';
import { withTempDatabase } from './fixtures.ts';

/** Call inside a `describe`; read the database with the returned getter from the tests. */
export function useSharedDatabase(): () => Db {
  let db: Db | undefined;
  let release: (() => void) | undefined;
  let finished: Promise<unknown> | undefined;

  beforeAll(async () => {
    await new Promise<void>((ready, fail) => {
      finished = withTempDatabase(async (created) => {
        db = created;
        ready();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      });
      finished.catch(fail);
    });
  });

  afterAll(async () => {
    release?.();
    await finished;
  });

  return () => {
    if (!db) throw new Error('the shared test database is not ready');
    return db;
  };
}
