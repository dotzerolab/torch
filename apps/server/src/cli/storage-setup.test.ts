import { describe, expect, it } from 'vitest';
import { corsRules } from '../files/storage.ts';
import { type BucketAdmin, setupBucket } from './storage-setup.ts';

function fakeAdmin(exists: boolean) {
  const calls: string[] = [];
  let cors: unknown;
  const admin: BucketAdmin = {
    async bucketExists() {
      calls.push('exists');
      return exists;
    },
    async createBucket() {
      calls.push('create');
    },
    async putCors(rules) {
      calls.push('cors');
      cors = rules;
    },
  };
  return { admin, calls, cors: () => cors };
}

describe('setupBucket', () => {
  it('creates the bucket only when it is missing, then applies CORS', async () => {
    const missing = fakeAdmin(false);
    const present = fakeAdmin(true);

    const created = await setupBucket(missing.admin, 'https://tracker.example.test');
    const kept = await setupBucket(present.admin, 'https://tracker.example.test');

    expect(missing.calls).toEqual(['exists', 'create', 'cors']);
    expect(present.calls).toEqual(['exists', 'cors']);
    expect(created).toEqual({ created: true });
    expect(kept).toEqual({ created: false });
  });

  it('applies the rules for APP_URL: its origin, POST and GET, no wildcard', async () => {
    const world = fakeAdmin(true);

    await setupBucket(world.admin, 'https://tracker.example.test/');

    expect(world.cors()).toEqual(corsRules('https://tracker.example.test/'));
    expect(JSON.stringify(world.cors())).toContain('https://tracker.example.test');
    expect(JSON.stringify(world.cors())).not.toContain('"AllowedOrigins":["*"');
  });

  it('refuses an APP_URL that is not an http(s) URL, before touching the storage', async () => {
    const world = fakeAdmin(false);

    await expect(setupBucket(world.admin, 'not a url')).rejects.toThrow(/APP_URL/);
    expect(world.calls).toEqual([]);
  });
});
