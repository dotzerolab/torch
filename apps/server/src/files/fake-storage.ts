// An in-memory FileStorage for tests: the same contract as the S3 one (see storage-contract.ts), plus helpers to put an
// object where an upload would, to read what was minted and to make a call fail.
import { MAX_ATTACHMENT_BYTES } from '@torch/shared/mutations/attachment';
import type { FileStorage } from './storage.ts';

export type FakeStorage = FileStorage & {
  /** Stores an object as a finished upload would. */
  put(key: string, bytes: Uint8Array, contentType: string): void;
  keys(): string[];
  /** Every download URL minted so far. */
  urlsMinted: string[];
  /** Set one to true and that call throws, as a storage outage would. */
  faults: { head: boolean; readStart: boolean; remove: boolean; presign: boolean };
};

const ORIGIN = 'https://storage.example.test';

export function createFakeStorage(opts: { maxBytes?: number } = {}): FakeStorage {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  const faults = { head: false, readStart: false, remove: false, presign: false };
  const urlsMinted: string[] = [];
  const check = (name: keyof typeof faults) => {
    if (faults[name]) throw new Error('storage is down');
  };

  return {
    maxBytes: opts.maxBytes ?? MAX_ATTACHMENT_BYTES,
    faults,
    urlsMinted,
    put(key, bytes, contentType) {
      objects.set(key, { bytes: new Uint8Array(bytes), contentType });
    },
    keys: () => [...objects.keys()],

    async presignUpload({ key, contentType, size }) {
      check('presign');
      return {
        url: `${ORIGIN}/upload`,
        method: 'POST',
        fields: { key, 'Content-Type': contentType, 'x-size-limit': String(size) },
      };
    },
    async presignDownload({ key, fileName, contentType, inline, expiresInSeconds }) {
      check('presign');
      const query = new URLSearchParams({
        disposition: inline ? 'inline' : 'attachment',
        name: fileName,
        type: contentType,
        expires: String(expiresInSeconds),
      });
      const url = `${ORIGIN}/${key}?${query}`;
      urlsMinted.push(url);
      return url;
    },
    async head(key) {
      check('head');
      const found = objects.get(key);
      return found ? { size: found.bytes.length, contentType: found.contentType } : null;
    },
    async readStart(key, bytes) {
      check('readStart');
      return objects.get(key)?.bytes.slice(0, bytes) ?? new Uint8Array();
    },
    async remove(key) {
      check('remove');
      objects.delete(key);
    },
  };
}
