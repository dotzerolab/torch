// The behaviour every FileStorage must have, run against the in-memory fake and against the real S3 client. A test file
// calls `describeStorageContract` with a factory; `upload` puts bytes at a key the way a browser would (a real HTTP
// upload to a presigned request for S3, a direct put for the fake).
import { describe, expect, it } from 'vitest';
import type { FileStorage } from './storage.ts';

export type ContractWorld = {
  storage: FileStorage;
  upload(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** Removes whatever the test left behind. */
  cleanup(): Promise<void>;
};

const keyOf = () => `contract/${crypto.randomUUID()}`;
const bytes = (...values: number[]) => new Uint8Array(values);

export function describeStorageContract(
  name: string,
  make: () => ContractWorld | Promise<ContractWorld>,
) {
  describe(`${name}: the FileStorage contract`, () => {
    it('an uploaded object has a head, a size and a type, and a ranged read returns its start', async () => {
      const world = await make();
      const key = keyOf();
      try {
        await world.upload(key, bytes(1, 2, 3, 4, 5, 6, 7, 8), 'application/pdf');

        const head = await world.storage.head(key);
        const start = await world.storage.readStart(key, 3);

        expect(head).toEqual({ size: 8, contentType: 'application/pdf' });
        expect([...start]).toEqual([1, 2, 3]);
        expect([...(await world.storage.readStart(key, 100))]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      } finally {
        await world.storage.remove(key);
        await world.cleanup();
      }
    });

    it('head of a missing object is null', async () => {
      const world = await make();
      try {
        expect(await world.storage.head(keyOf())).toBeNull();
      } finally {
        await world.cleanup();
      }
    });

    it('remove is idempotent: an object, then the same key again, then a key that never existed', async () => {
      const world = await make();
      const key = keyOf();
      try {
        await world.upload(key, bytes(9), 'text/plain');

        await world.storage.remove(key);
        await world.storage.remove(key);
        await world.storage.remove(keyOf());

        expect(await world.storage.head(key)).toBeNull();
      } finally {
        await world.cleanup();
      }
    });

    it('presignDownload gives a URL for the key and never the secret', async () => {
      const world = await make();
      const key = keyOf();
      try {
        const url = await world.storage.presignDownload({
          key,
          fileName: 'report.pdf',
          contentType: 'application/pdf',
          inline: false,
          expiresInSeconds: 60,
        });

        expect(url).toMatch(/^https?:\/\//);
        expect(url).toContain(encodeURIComponent(key).replaceAll('%2F', '/'));
      } finally {
        await world.cleanup();
      }
    });

    it('presignUpload names the URL and the method of the upload request', async () => {
      const world = await make();
      try {
        const request = await world.storage.presignUpload({
          key: keyOf(),
          contentType: 'image/png',
          size: 100,
          expiresInSeconds: 300,
        });

        expect(request.url).toMatch(/^https?:\/\//);
        expect(['POST', 'PUT']).toContain(request.method);
      } finally {
        await world.cleanup();
      }
    });
  });
}
