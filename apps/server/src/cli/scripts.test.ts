// The package scripts (`db:migrate`, `db:seed`, `bootstrap`) are plain `node file.ts` entry points: run them
// for real against a throwaway database, so the argument parsing, the DATABASE_URL check and the exit codes
// are covered, not only the functions behind them.
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { withTempDatabase } from '../test/fixtures.ts';

const run = promisify(execFile);
const databaseUrl = process.env.DATABASE_URL;

const script = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
const MIGRATE = script('../db/migrate.ts');
const SEED = script('../db/seed.ts');
const BOOTSTRAP = script('./bootstrap.ts');

type Result = { code: number; stdout: string; stderr: string };
async function node(file: string, args: string[], env: Record<string, string | undefined>) {
  try {
    const { stdout, stderr } = await run(process.execPath, [file, ...args], {
      env: { ...process.env, NODE_ENV: 'test', ...env },
    });
    return { code: 0, stdout, stderr } satisfies Result;
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

describe.skipIf(!databaseUrl)('package scripts (Postgres)', () => {
  it('db:migrate applies and reports, and stops without DATABASE_URL', async () => {
    await withTempDatabase(async (_db, url) => {
      const ok = await node(MIGRATE, [], { DATABASE_URL: url });
      const missing = await node(MIGRATE, [], { DATABASE_URL: '' });

      expect(ok).toMatchObject({ code: 0 });
      expect(ok.stdout).toContain('migrations applied');
      expect(missing.code).toBe(1);
      expect(missing.stderr).toContain('DATABASE_URL is not set');
    });
  });

  it('db:seed creates the demo workspace, is idempotent and refuses in production', async () => {
    await withTempDatabase(async (_db, url) => {
      const first = await node(SEED, [], { DATABASE_URL: url });
      const second = await node(SEED, [], { DATABASE_URL: url });
      const production = await node(SEED, [], { DATABASE_URL: url, NODE_ENV: 'production' });

      expect(first.code).toBe(0);
      expect(first.stdout).toContain('demo workspace created');
      expect(second.code).toBe(0);
      expect(second.stdout).toContain('already exists');
      expect(production.code).toBe(1);
      expect(production.stderr).toContain('production');
    });
  });

  it('bootstrap creates the first workspace and reports usage errors with exit code 1', async () => {
    await withTempDatabase(async (_db, url) => {
      const args = [
        '--name',
        'Acme Studio',
        '--slug',
        'acme-studio',
        '--email',
        'founder@example.test',
        '--owner-name',
        'Fiona Founder',
      ];

      const created = await node(BOOTSTRAP, args, { DATABASE_URL: url });
      const again = await node(BOOTSTRAP, args, { DATABASE_URL: url });
      const incomplete = await node(BOOTSTRAP, ['--name', 'x'], { DATABASE_URL: url });

      expect(created.code).toBe(0);
      expect(created.stdout).toMatch(/workspace [0-9a-f-]{36} created with owner [0-9a-f-]{36}/);
      expect(again.code).toBe(1);
      expect(again.stderr).toContain('already exists');
      expect(incomplete.code).toBe(1);
      expect(incomplete.stderr).toContain('missing required option --slug');
      expect(incomplete.stderr).toContain('usage: bootstrap');
    });
  });
});
