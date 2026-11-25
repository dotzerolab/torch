import { describe, expect, it } from 'vitest';
import { createFakeStorage } from './fake-storage.ts';
import { describeStorageContract } from './storage-contract.ts';

describeStorageContract('fake storage', () => {
  const storage = createFakeStorage();
  return {
    storage,
    async upload(key, bytes, contentType) {
      storage.put(key, bytes, contentType);
    },
    async cleanup() {},
  };
});

describe('fake storage helpers', () => {
  it('lists its keys, records the download URLs it minted and can be told to fail', async () => {
    const storage = createFakeStorage();
    storage.put('a', new Uint8Array([1]), 'text/plain');

    const url = await storage.presignDownload({
      key: 'a',
      fileName: 'a.txt',
      contentType: 'text/plain',
      inline: false,
      expiresInSeconds: 60,
    });
    storage.faults.remove = true;

    expect(storage.keys()).toEqual(['a']);
    expect(storage.urlsMinted).toEqual([url]);
    await expect(storage.remove('a')).rejects.toThrow('storage is down');
    storage.faults.remove = false;
    await storage.remove('a');
    expect(storage.keys()).toEqual([]);
  });
});
