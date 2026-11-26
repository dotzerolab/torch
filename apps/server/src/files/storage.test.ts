import { describe, expect, it } from 'vitest';
import { readStorageConfig, type StorageConfig } from './config.ts';
import { UPLOAD_PREFIX } from './keys.ts';
import {
  corsRules,
  createS3Storage,
  ensureBucket,
  type FileStorage,
  lifecycleRules,
  type UploadRequest,
} from './storage.ts';
import { type ContractWorld, describeStorageContract } from './storage-contract.ts';

const SECRET = 'unit-test-secret-value-7f3a9c';
const unitConfig: StorageConfig = {
  endpoint: 'http://storage.internal:9000',
  publicEndpoint: 'https://files.example.test',
  region: 'us-east-1',
  bucket: 'attachments-unit',
  accessKeyId: 'unit-access-id',
  secretAccessKey: SECRET,
  forcePathStyle: true,
  maxBytes: 26_214_400,
};

describe('createS3Storage (no network)', () => {
  const storage = createS3Storage(unitConfig);

  it('presignUpload returns a POST form whose policy pins key, type and size, valid for 300 s', async () => {
    const request = await storage.presignUpload({
      key: 'workspaces/w1/attachments/a1',
      contentType: 'image/png',
      size: 2048,
      expiresInSeconds: 300,
    });

    expect(request.method).toBe('POST');
    expect(request.url).toBe('https://files.example.test/attachments-unit');
    expect(request.fields?.key).toBe('workspaces/w1/attachments/a1');
    expect(request.fields?.['Content-Type']).toBe('image/png');
    const policy = JSON.parse(Buffer.from(request.fields?.Policy ?? '', 'base64').toString()) as {
      expiration: string;
      conditions: unknown[];
    };
    expect(policy.conditions).toEqual(
      expect.arrayContaining([
        { bucket: 'attachments-unit' },
        { key: 'workspaces/w1/attachments/a1' },
        { 'Content-Type': 'image/png' },
        ['content-length-range', 1, 2048],
      ]),
    );
    const seconds = (Date.parse(policy.expiration) - Date.now()) / 1000;
    expect(seconds).toBeGreaterThan(290);
    expect(seconds).toBeLessThanOrEqual(301);
    expect(JSON.stringify(request)).not.toContain(SECRET);
  });

  it('presignDownload: an attachment for a document, inline only where allowed, 60 s, no secret', async () => {
    const download = (over: { inline: boolean; contentType: string; fileName: string }) =>
      storage.presignDownload({
        key: 'workspaces/w1/attachments/a1',
        expiresInSeconds: 60,
        ...over,
      });

    const pdf = new URL(
      await download({
        inline: false,
        contentType: 'application/pdf',
        fileName: 'Q3 report ü.pdf',
      }),
    );
    const png = new URL(
      await download({ inline: true, contentType: 'image/png', fileName: 'shot.png' }),
    );

    expect(pdf.origin).toBe('https://files.example.test');
    expect(pdf.pathname).toBe('/attachments-unit/workspaces/w1/attachments/a1');
    const disposition = pdf.searchParams.get('response-content-disposition') ?? '';
    expect(disposition.startsWith('attachment;')).toBe(true);
    expect(disposition).toContain("filename*=UTF-8''Q3%20report%20%C3%BC.pdf");
    expect(pdf.searchParams.get('response-content-type')).toBe('application/pdf');
    expect(pdf.searchParams.get('X-Amz-Expires')).toBe('60');
    expect(png.searchParams.get('response-content-disposition')?.startsWith('inline;')).toBe(true);
    expect(`${pdf}${png}`).not.toContain(SECRET);
  });

  it('a file name with quotes and line breaks cannot break out of the header', async () => {
    const url = new URL(
      await storage.presignDownload({
        key: 'k',
        fileName: 'a"b\r\nSet-Cookie: x=1.pdf',
        contentType: 'application/pdf',
        inline: false,
        expiresInSeconds: 60,
      }),
    );

    const disposition = url.searchParams.get('response-content-disposition') ?? '';
    expect(disposition).not.toMatch(/[\r\n]/);
    expect(disposition.match(/"/g)?.length ?? 0).toBeLessThanOrEqual(2);
  });

  it('exposes the size limit it was configured with', () => {
    expect(storage.maxBytes).toBe(26_214_400);
  });
});

describe('corsRules', () => {
  it('allows the app origin only, for POST, PUT and GET, never a wildcard', () => {
    const rules = corsRules('https://tracker.example.test/some/path') as {
      CORSRules: { AllowedOrigins: string[]; AllowedMethods: string[] }[];
    };

    expect(rules.CORSRules).toHaveLength(1);
    expect(rules.CORSRules[0]?.AllowedOrigins).toEqual(['https://tracker.example.test']);
    expect(rules.CORSRules[0]?.AllowedMethods).toEqual(expect.arrayContaining(['POST', 'GET']));
    expect(rules.CORSRules[0]?.AllowedOrigins).not.toContain('*');
  });
});

describe('lifecycleRules', () => {
  it('expires the staging prefix after a day and aborts incomplete multipart uploads after a day', () => {
    const { Rules } = lifecycleRules() as {
      Rules: {
        Status: string;
        Filter: { Prefix: string };
        Expiration?: { Days: number };
        AbortIncompleteMultipartUpload?: { DaysAfterInitiation: number };
      }[];
    };

    const staged = Rules.find((rule) => rule.Filter.Prefix === UPLOAD_PREFIX);
    const multipart = Rules.find((rule) => rule.AbortIncompleteMultipartUpload);
    expect(UPLOAD_PREFIX).toBe('uploads/');
    expect(staged).toMatchObject({ Status: 'Enabled', Expiration: { Days: 1 } });
    expect(multipart).toMatchObject({
      Status: 'Enabled',
      AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
    });
    expect(Rules.every((rule) => rule.Status === 'Enabled')).toBe(true);
  });
});

// ---- the real storage service (the dev compose one), skipped loudly without S3_ENDPOINT ----

const config = process.env.S3_ENDPOINT ? readStorageConfig(process.env) : null;

if (!config) {
  console.warn(
    '[files/storage.test] SKIPPED the storage integration tests: S3_ENDPOINT is not set. ' +
      'Start `docker compose -f docker-compose.dev.yml up -d --wait` and set the S3_* variables (see .env.example).',
  );
}

/** What a browser does with a presigned POST: the fields first, the file last. */
async function sendUpload(
  request: UploadRequest,
  bytes: Uint8Array,
  overrides: Record<string, string> = {},
) {
  if (request.method === 'PUT') {
    return fetch(request.url, {
      method: 'PUT',
      headers: { ...request.headers, ...overrides },
      body: bytes,
    });
  }
  const form = new FormData();
  for (const [name, value] of Object.entries({ ...request.fields, ...overrides })) {
    form.append(name, value);
  }
  form.append('file', new Blob([new Uint8Array(bytes)]), 'upload.bin');
  return fetch(request.url, { method: 'POST', body: form });
}

describe.skipIf(!config)('S3 storage (integration)', () => {
  // A skipped suite still runs this body to collect its tests, so nothing here may need a real service: without
  // S3_ENDPOINT the offline config builds a client that is never used, because every test below is skipped.
  const real: StorageConfig = config ?? unitConfig;
  const storage: FileStorage = createS3Storage(real);
  const made: string[] = [];
  const keyOf = () => {
    const key = `tests/${crypto.randomUUID()}`;
    made.push(key);
    return key;
  };

  const world = async (): Promise<ContractWorld> => {
    await ensureBucket(real);
    return {
      storage,
      async upload(key, bytes, contentType) {
        made.push(key);
        const request = await storage.presignUpload({
          key,
          contentType,
          size: bytes.length,
          expiresInSeconds: 300,
        });
        const res = await sendUpload(request, bytes);
        if (!res.ok) throw new Error(`upload answered ${res.status}: ${await res.text()}`);
      },
      async cleanup() {
        for (const key of made.splice(0)) await storage.remove(key);
      },
    };
  };
  describeStorageContract('S3', world);

  it('upload then head then read start, through the signed download URL too', async () => {
    const w = await world();
    const key = keyOf();
    const body = new TextEncoder().encode('%PDF-1.7 hello');
    try {
      await w.upload(key, body, 'application/pdf');

      const url = await storage.presignDownload({
        key,
        fileName: 'hello.pdf',
        contentType: 'application/pdf',
        inline: false,
        expiresInSeconds: 60,
      });
      const res = await fetch(url);

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/pdf');
      expect(res.headers.get('content-disposition')).toContain('attachment');
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(body);
    } finally {
      await w.cleanup();
    }
  });

  it('a second POST with the same presigned request after the copy does not change the published object', async () => {
    const w = await world();
    const staged = keyOf();
    const published = keyOf();
    const first = new Uint8Array(64);
    first.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    try {
      const request = await storage.presignUpload({
        key: staged,
        contentType: 'image/png',
        size: 64,
        expiresInSeconds: 300,
      });
      expect((await sendUpload(request, first)).ok).toBe(true);
      expect(await storage.copy(staged, published)).toBe(true);
      await storage.remove(staged);

      // The request is a policy and stays good until it expires: the browser (or anybody holding it) can send again.
      const again = await sendUpload(request, new TextEncoder().encode('<html>other</html>'));

      expect(again.ok).toBe(true);
      expect(await storage.head(published)).toEqual({ size: 64, contentType: 'image/png' });
      expect([...(await storage.readStart(published, 100))]).toEqual([...first]);
    } finally {
      await w.cleanup();
    }
  });

  it('oversize body refused by storage', async () => {
    const w = await world();
    const key = keyOf();
    try {
      const request = await storage.presignUpload({
        key,
        contentType: 'image/png',
        size: 100,
        expiresInSeconds: 300,
      });

      const res = await sendUpload(request, new Uint8Array(5000));

      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(await storage.head(key)).toBeNull();
    } finally {
      await w.cleanup();
    }
  });

  it('wrong content type refused by storage', async () => {
    const w = await world();
    const key = keyOf();
    try {
      const request = await storage.presignUpload({
        key,
        contentType: 'image/png',
        size: 100,
        expiresInSeconds: 300,
      });

      const res = await sendUpload(
        request,
        new Uint8Array(50),
        request.method === 'POST'
          ? { 'Content-Type': 'text/html' }
          : { 'content-type': 'text/html' },
      );

      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(await storage.head(key)).toBeNull();
    } finally {
      await w.cleanup();
    }
  });

  it('another key than the one signed is refused by storage', async () => {
    const w = await world();
    const key = keyOf();
    try {
      const request = await storage.presignUpload({
        key,
        contentType: 'image/png',
        size: 100,
        expiresInSeconds: 300,
      });
      if (request.method === 'PUT') return; // the key is part of the signed URL itself

      const res = await sendUpload(request, new Uint8Array(50), { key: `${key}-other` });

      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(await storage.head(`${key}-other`)).toBeNull();
    } finally {
      await w.cleanup();
    }
  });

  it('expired request refused', async () => {
    const w = await world();
    const key = keyOf();
    try {
      const request = await storage.presignUpload({
        key,
        contentType: 'image/png',
        size: 100,
        expiresInSeconds: 1,
      });
      await new Promise((resolve) => setTimeout(resolve, 2500));

      const res = await sendUpload(request, new Uint8Array(50));

      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(await storage.head(key)).toBeNull();
    } finally {
      await w.cleanup();
    }
  });

  it('an expired download URL is refused', async () => {
    const w = await world();
    const key = keyOf();
    try {
      await w.upload(key, new Uint8Array([1, 2, 3]), 'text/plain');
      const url = await storage.presignDownload({
        key,
        fileName: 'a.txt',
        contentType: 'text/plain',
        inline: false,
        expiresInSeconds: 1,
      });
      await new Promise((resolve) => setTimeout(resolve, 2500));

      expect((await fetch(url)).status).toBeGreaterThanOrEqual(400);
    } finally {
      await w.cleanup();
    }
  });
});
