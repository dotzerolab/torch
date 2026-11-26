import type { Brand } from '@torch/shared/brand';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app.ts';
import type { Orm } from './db.ts';
import { createMemoryMailer } from './mail/mailer.ts';
import type { ActorResolver } from './permissions/load-actor.ts';

const brand: Brand = {
  productName: 'Acme Tasks',
  logoLight: '/acme/logo-light.svg',
  logoDark: '/acme/logo-dark.svg',
  favicon: '/acme/favicon.svg',
  accentColor: '#3366ff',
  emailSenderName: 'Acme Tasks',
  emailSenderAddress: 'no-reply@acme.example',
};

describe('GET /health', () => {
  it('returns ok', async () => {
    const app = createApp({ brand });

    const res = await app.fetch(new Request('http://localhost/health'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});

describe('GET /api/brand', () => {
  it('returns the instance brand without authentication', async () => {
    const app = createApp({ brand });

    const res = await app.fetch(new Request('http://localhost/api/brand'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(brand);
  });
});

describe('GET /api/manifest.webmanifest', () => {
  it('serves the manifest of the instance brand without authentication, never cached', async () => {
    const app = createApp({ brand });

    const res = await app.fetch(new Request('http://localhost/api/manifest.webmanifest'));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/manifest\+json/);
    expect(res.headers.get('cache-control')).toBe('no-cache');
    const manifest = (await res.json()) as { name: string; theme_color: string };
    expect(manifest.name).toBe('Acme Tasks');
    expect(manifest.theme_color).toBe('#3366ff');
  });
});

describe('GET /health/db', () => {
  const get = (app: ReturnType<typeof createApp>) =>
    app.fetch(new Request('http://localhost/health/db'));

  it('returns ok with the WAL level and the replication privilege when the database is ready for sync', async () => {
    const db = {
      health: async () => ({ status: 'ok', walLevel: 'logical', replication: true }) as const,
    };

    const res = await get(createApp({ brand, db }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', walLevel: 'logical', replication: true });
  });

  it('returns 503 with the reason when the database check fails', async () => {
    const db = {
      health: async () => ({ status: 'error', reason: 'wal_level is "replica"' }) as const,
    };

    const res = await get(createApp({ brand, db }));

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: 'error', reason: 'wal_level is "replica"' });
  });

  it('returns 503 when no database is configured', async () => {
    const res = await get(createApp({ brand }));

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: 'error', reason: 'DATABASE_URL is not set' });
  });
});

describe('GET /health/sync', () => {
  const get = (app: ReturnType<typeof createApp>) =>
    app.fetch(new Request('http://localhost/health/sync'));
  const electric = { url: 'http://sync.example.test:3000', secret: 'topsecret-value' };

  afterEach(() => vi.unstubAllGlobals());

  it('answers disabled with 200 when no sync service is configured', async () => {
    const res = await get(createApp({ brand }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'disabled' });
  });

  it('answers ok with 200 when the sync service is active', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ status: 'active' }));

    const res = await get(createApp({ brand, electric }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('answers 503 with the reason when the sync service is not replicating', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ status: 'waiting' }));

    const res = await get(createApp({ brand, electric }));

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      status: 'error',
      reason: 'sync service is not replicating yet (waiting)',
    });
  });
});

describe('request body limit on /api/*', () => {
  const origin = 'http://app.example.test';
  // Nothing may reach the database before a body is accepted: any property access fails the test.
  const untouchedOrm = new Proxy(
    {},
    {
      get() {
        throw new Error('the database must not be touched');
      },
    },
  ) as unknown as Orm;
  const app = createApp({
    brand,
    db: {
      health: async () => ({ status: 'ok', walLevel: 'logical', replication: true }),
      orm: untouchedOrm,
    },
    config: { appUrl: origin, trustProxy: false },
    mailer: createMemoryMailer(),
  });
  const send = (
    path: string,
    body: string | ReadableStream<Uint8Array>,
    headers: Record<string, string> = {},
  ) =>
    app.fetch(
      new Request(`${origin}${path}`, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json', ...headers },
        body,
        duplex: 'half',
      }),
    );
  const oversized = JSON.stringify({ token: 'x'.repeat(32 * 1024) });

  it.each(['/api/auth/verify', '/api/auth/magic-link'])(
    '%s refuses a 32 KB body with 413',
    async (path) => {
      const res = await send(path, oversized);

      expect(res.status).toBe(413);
      expect(await res.json()).toMatchObject({ error: 'invalid_input' });
    },
  );

  // A finite stream that counts how often the server reads from it; highWaterMark 0 means no read-ahead.
  function countingBody(chunks: number) {
    const state = { pulled: 0 };
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (state.pulled === chunks) return controller.close();
          state.pulled += 1;
          controller.enqueue(new Uint8Array(1024));
        },
      },
      { highWaterMark: 0 },
    );
    return { state, body };
  }

  it('refuses on the declared Content-Length without reading the body', async () => {
    const { state, body } = countingBody(1024);

    const res = await send('/api/auth/verify', body, { 'content-length': String(1024 * 1024) });

    expect(res.status).toBe(413);
    expect(state.pulled).toBe(0);
  });

  it('stops reading a body of unknown length once it passes the limit', async () => {
    const { state, body } = countingBody(4096); // 4 MB in total

    const res = await send('/api/auth/verify', body);

    expect(res.status).toBe(413);
    // 16 KB allowed plus the chunk that crosses the line; never the whole 4 MB.
    expect(state.pulled).toBeLessThanOrEqual(17);
  });

  it('lets a normal sign-in body through to the route', async () => {
    const res = await send('/api/auth/magic-link', JSON.stringify({ email: 'not-an-email' }));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_email' });
  });
});

describe('body limits of the routes that take large bodies', () => {
  const origin = 'http://app.example.test';
  const untouchedOrm = new Proxy(
    {},
    {
      get() {
        throw new Error('the database must not be touched');
      },
    },
  ) as unknown as Orm;
  // No session: a request that gets past the body limit reaches the route and is answered 401.
  const app = createApp({
    brand,
    db: {
      health: async () => ({ status: 'ok', walLevel: 'logical', replication: true }),
      orm: untouchedOrm,
    },
    config: { appUrl: origin, trustProxy: false },
    mailer: createMemoryMailer(),
    auth: { resolveActor: async () => null },
  });
  const send = (path: string, method: string, bytes: number) =>
    app.fetch(
      new Request(`${origin}${path}`, {
        method,
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({ body: 'x'.repeat(bytes) }),
      }),
    );
  const ws = crypto.randomUUID();
  const id = crypto.randomUUID();

  it.each([
    ['POST', `/api/w/${ws}/issues/${id}/comments`],
    ['PATCH', `/api/w/${ws}/comments/${id}`],
    ['POST', `/api/w/${ws}/teams/${id}/documents`],
    ['PATCH', `/api/w/${ws}/documents/${id}`],
  ])('%s %s takes a 100 KiB body to the route', async (method, path) => {
    const res = await send(path, method, 100 * 1024);

    expect(res.status).toBe(401);
  });

  it.each([
    ['POST', `/api/w/${ws}/members`],
    ['PATCH', `/api/w/${ws}/teams/${id}`],
    ['POST', `/api/w/${ws}/teams/${id}/members`],
    ['POST', `/api/w/${ws}/issues/${id}/attachments`],
  ])('a 100 KiB body to %s %s still answers 413', async (method, path) => {
    const res = await send(path, method, 100 * 1024);

    expect(res.status).toBe(413);
  });
});

describe('cookie-authenticated routes need the CSRF guard', () => {
  const origin = 'http://app.example.test';
  const db = {
    health: async () => ({ status: 'ok', walLevel: 'logical', replication: true }) as const,
  };
  const orm = {} as unknown as Orm;
  const neverCalled: ActorResolver = {
    resolveActor: async () => {
      throw new Error('the resolver must not run before the Origin check');
    },
  };
  const issuePath = `/api/w/${crypto.randomUUID()}/issues/${crypto.randomUUID()}`;

  it('createApp refuses an actor resolver without the config that carries APP_URL', () => {
    expect(() => createApp({ brand, db: { ...db, orm }, auth: neverCalled })).toThrow(/config/);
  });

  it('a PATCH from a foreign Origin never reaches the data route or the resolver', async () => {
    const app = createApp({
      brand,
      db: { ...db, orm },
      auth: neverCalled,
      config: { appUrl: origin, trustProxy: false },
    });

    for (const headers of [{}, { origin: 'https://evil.example.test' }]) {
      const res = await app.fetch(
        new Request(`${origin}${issuePath}`, { method: 'PATCH', headers, body: '{}' }),
      );

      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: 'bad_origin' });
    }
  });
});

describe('unexpected errors', () => {
  const origin = 'http://app.example.test';

  it('answer a generic JSON 500 and log the error name and code, never the SQL or its parameters', async () => {
    const failing = {
      select() {
        throw Object.assign(
          new Error('Failed query: select ... params: alice@example.test,3f2a9c0d5b7e'),
          { name: 'DrizzleQueryError', cause: { code: '57P01', detail: 'alice@example.test' } },
        );
      },
    } as unknown as Orm;
    const app = createApp({
      brand,
      db: {
        health: async () => ({ status: 'ok', walLevel: 'logical', replication: true }),
        orm: failing,
      },
      config: { appUrl: origin, trustProxy: false },
      mailer: createMemoryMailer(),
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await app.fetch(
      new Request(`${origin}/api/auth/session`, { headers: { cookie: `sid=${'a'.repeat(43)}` } }),
    );

    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ error: 'internal' });
    const logged = JSON.stringify(errors.mock.calls);
    expect(logged).toContain('DrizzleQueryError');
    expect(logged).toContain('57P01');
    expect(logged).not.toContain('alice@example.test');
    expect(logged).not.toContain('Failed query');
    errors.mockRestore();
  });
});
