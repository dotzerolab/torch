import { describe, expect, it } from 'vitest';
import { createApp } from '../app.ts';
import { testBrand } from '../test/auth-app.ts';

const appUrl = 'http://app.example.test';
const app = createApp({ brand: testBrand, config: { appUrl, trustProxy: false } });
const send = (method: string, path: string, origin?: string) =>
  app.fetch(new Request(`${appUrl}${path}`, { method, headers: origin ? { origin } : {} }));

describe('csrfGuard on /api/*', () => {
  it('POST with a missing Origin → 403 bad_origin', async () => {
    const res = await send('POST', '/api/anything');

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'bad_origin' });
  });

  it('POST with a foreign or opaque Origin → 403 bad_origin, for every non-GET method', async () => {
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      for (const origin of [
        'https://evil.example.test',
        'null',
        'http://app.example.test.evil.test',
      ]) {
        const res = await send(method, '/api/anything', origin);

        expect(res.status, `${method} ${origin}`).toBe(403);
        expect(await res.json()).toMatchObject({ error: 'bad_origin' });
      }
    }
  });

  it('a matching Origin passes the guard (the route answers, here 404)', async () => {
    const res = await send('POST', '/api/anything', appUrl);

    expect(res.status).toBe(404);
  });

  it('a trailing slash in APP_URL does not change the origin that is accepted', async () => {
    const slashed = createApp({
      brand: testBrand,
      config: { appUrl: `${appUrl}/`, trustProxy: false },
    });

    const res = await slashed.fetch(
      new Request(`${appUrl}/api/anything`, { method: 'POST', headers: { origin: appUrl } }),
    );

    expect(res.status).toBe(404);
  });

  it('GET and HEAD need no Origin, and paths outside /api are not guarded', async () => {
    expect((await send('GET', '/api/brand')).status).toBe(200);
    expect((await send('HEAD', '/api/brand')).status).toBe(200);
    expect((await send('GET', '/health')).status).toBe(200);
  });
});
