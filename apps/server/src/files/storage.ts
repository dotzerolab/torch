// File storage for attachments: files never pass through this server. The browser sends a file to the storage with a
// request this module presigned (the storage enforces the size range and the type itself), the server then verifies
// the stored object, and reads are a redirect to a short-lived signed URL minted after the permission check.
// Nothing here logs a URL, a key or a field: a signed request is a bearer credential for its lifetime.
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutBucketCorsCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { StorageConfig } from './config.ts';

/** What the browser sends to put a file in the storage: a form POST (fields, then the file) or a PUT with headers. */
export type UploadRequest = {
  url: string;
  method: 'POST' | 'PUT';
  fields?: Record<string, string>;
  headers?: Record<string, string>;
};

export type FileStorage = {
  /** The largest upload this installation accepts, in bytes. */
  readonly maxBytes: number;
  presignUpload(input: {
    key: string;
    contentType: string;
    size: number;
    expiresInSeconds: number;
  }): Promise<UploadRequest>;
  presignDownload(input: {
    key: string;
    fileName: string;
    contentType: string;
    inline: boolean;
    expiresInSeconds: number;
  }): Promise<string>;
  /** Size and stored type of an object, or null when there is none. */
  head(key: string): Promise<{ size: number; contentType: string | null } | null>;
  /** The first `bytes` bytes of an object (a ranged read). */
  readStart(key: string, bytes: number): Promise<Uint8Array>;
  /** Deletes an object; a missing key is not an error. */
  remove(key: string): Promise<void>;
};

function clientFor(config: StorageConfig, endpoint: string): S3Client {
  return new S3Client({
    region: config.region,
    endpoint,
    forcePathStyle: config.forcePathStyle,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    // Self-hosted S3 services do not all understand the checksum headers newer SDKs add by default.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

/** RFC 5987 percent-encoding: what `encodeURIComponent` leaves alone but a header value must not. */
const encodeHeaderValue = (value: string) =>
  encodeURIComponent(value).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/** A Content-Disposition value: the type, an ASCII fallback name and the full name in UTF-8. The name has no quote or line break. */
function contentDisposition(inline: boolean, fileName: string): string {
  const fallback = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\\r\n]/g, '_');
  return `${inline ? 'inline' : 'attachment'}; filename="${fallback}"; filename*=UTF-8''${encodeHeaderValue(fileName)}`;
}

const isMissing = (error: unknown): boolean => {
  const { name, $metadata } = (error ?? {}) as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return name === 'NotFound' || name === 'NoSuchKey' || $metadata?.httpStatusCode === 404;
};

export function createS3Storage(config: StorageConfig): FileStorage {
  // Presigned requests carry the host they were signed for, so they are signed for the address the browser uses.
  const inside = clientFor(config, config.endpoint);
  const signing =
    config.publicEndpoint === config.endpoint ? inside : clientFor(config, config.publicEndpoint);
  const Bucket = config.bucket;

  return {
    maxBytes: config.maxBytes,

    async presignUpload({ key, contentType, size, expiresInSeconds }) {
      const post = await createPresignedPost(signing, {
        Bucket,
        Key: key,
        Fields: { 'Content-Type': contentType },
        // The key, the bucket and every field (the type) are exact-match conditions already; the size is a range.
        Conditions: [['content-length-range', 1, size]],
        Expires: expiresInSeconds,
      });
      return { url: post.url, method: 'POST', fields: post.fields };
    },

    presignDownload({ key, fileName, contentType, inline, expiresInSeconds }) {
      return getSignedUrl(
        signing,
        new GetObjectCommand({
          Bucket,
          Key: key,
          ResponseContentType: contentType,
          ResponseContentDisposition: contentDisposition(inline, fileName),
        }),
        { expiresIn: expiresInSeconds },
      );
    },

    async head(key) {
      try {
        const res = await inside.send(new HeadObjectCommand({ Bucket, Key: key }));
        return { size: res.ContentLength ?? 0, contentType: res.ContentType ?? null };
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    },

    async readStart(key, bytes) {
      const res = await inside.send(
        new GetObjectCommand({ Bucket, Key: key, Range: `bytes=0-${Math.max(bytes, 1) - 1}` }),
      );
      return (await res.Body?.transformToByteArray()) ?? new Uint8Array();
    },

    async remove(key) {
      await inside.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },
  };
}

/** The browser rules for the bucket: the app's origin may POST an upload and GET a download, nobody else. */
export function corsRules(appUrl: string): { CORSRules: object[] } {
  return {
    CORSRules: [
      {
        AllowedOrigins: [new URL(appUrl).origin],
        AllowedMethods: ['POST', 'PUT', 'GET', 'HEAD'],
        AllowedHeaders: ['*'],
        ExposeHeaders: ['ETag'],
        MaxAgeSeconds: 3000,
      },
    ],
  };
}

/** What `storage:setup` needs from a storage service; a thin layer over the SDK so the setup logic is testable. */
export type BucketAdmin = {
  bucketExists(): Promise<boolean>;
  createBucket(): Promise<void>;
  putCors(rules: { CORSRules: object[] }): Promise<void>;
};

export function createS3BucketAdmin(config: StorageConfig): BucketAdmin {
  const client = clientFor(config, config.endpoint);
  const Bucket = config.bucket;
  return {
    async bucketExists() {
      try {
        await client.send(new HeadBucketCommand({ Bucket }));
        return true;
      } catch (error) {
        if (isMissing(error)) return false;
        throw error;
      }
    },
    async createBucket() {
      await client.send(new CreateBucketCommand({ Bucket }));
    },
    async putCors(rules) {
      await client.send(
        new PutBucketCorsCommand({ Bucket, CORSConfiguration: rules as { CORSRules: never[] } }),
      );
    },
  };
}

/** Creates the bucket when it is missing (no CORS): for tests and the first run of a development stack. */
export async function ensureBucket(config: StorageConfig): Promise<void> {
  const admin = createS3BucketAdmin(config);
  if (!(await admin.bucketExists())) await admin.createBucket();
}
