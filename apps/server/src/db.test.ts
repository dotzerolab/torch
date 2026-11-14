import { describe, expect, it, vi } from 'vitest';
import { createApp } from './app.ts';
import { createDb, interpretWalLevel } from './db.ts';

const databaseUrl = process.env.DATABASE_URL;

describe('interpretWalLevel', () => {
  it('accepts logical', () => {
    expect(interpretWalLevel('logical')).toEqual({ status: 'ok', walLevel: 'logical' });
  });

  it.each(['replica', 'minimal', ''])('rejects "%s" and says what to change', (level) => {
    const health = interpretWalLevel(level);

    expect(health.status).toBe('error');
    expect(health).toMatchObject({ reason: expect.stringContaining('wal_level=logical') });
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
  it('reports walLevel "logical" through /health/db', async () => {
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
      expect(await res.json()).toEqual({ status: 'ok', walLevel: 'logical' });
    } finally {
      await db.close();
    }
  });
});
