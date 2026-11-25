// Object storage settings from the environment. Off (null) without S3_ENDPOINT, so an installation without file
// storage still runs and says so; a half-set or malformed group stops the server at startup instead of failing on
// the first upload. Messages name variables only: no key or secret is ever part of an error or a log line.
import { MAX_ATTACHMENT_BYTES } from '@torch/shared/mutations/attachment';

export type StorageConfig = {
  /** Where the server talks to the storage (inside the network). */
  endpoint: string;
  /** Where the browser reaches the storage; presigned requests are signed for this address. */
  publicEndpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  /** The largest upload in bytes; never above what the database accepts. */
  maxBytes: number;
};

export class StorageConfigError extends Error {}

const URL_HELP = 'must be an http(s) URL such as http://localhost:9000';

function httpUrl(name: string, raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new StorageConfigError(`${name} ${URL_HELP}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new StorageConfigError(`${name} ${URL_HELP}`);
  }
  return raw.replace(/\/+$/, '');
}

export function readStorageConfig(env: Record<string, string | undefined>): StorageConfig | null {
  const rawEndpoint = env.S3_ENDPOINT;
  if (!rawEndpoint) return null;
  const endpoint = httpUrl('S3_ENDPOINT', rawEndpoint);

  for (const name of ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const) {
    if (!env[name]) throw new StorageConfigError(`${name} must be set when S3_ENDPOINT is set`);
  }

  const publicEndpoint = env.S3_PUBLIC_ENDPOINT
    ? httpUrl('S3_PUBLIC_ENDPOINT', env.S3_PUBLIC_ENDPOINT)
    : endpoint;

  const style = env.S3_FORCE_PATH_STYLE ?? 'true';
  if (style !== 'true' && style !== 'false') {
    throw new StorageConfigError('S3_FORCE_PATH_STYLE must be "true" or "false"');
  }

  let maxBytes = MAX_ATTACHMENT_BYTES;
  if (env.ATTACHMENT_MAX_BYTES) {
    maxBytes = /^\d+$/.test(env.ATTACHMENT_MAX_BYTES)
      ? Number(env.ATTACHMENT_MAX_BYTES)
      : Number.NaN;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_ATTACHMENT_BYTES) {
      throw new StorageConfigError(
        `ATTACHMENT_MAX_BYTES must be a whole number of bytes from 1 to ${MAX_ATTACHMENT_BYTES}`,
      );
    }
  }

  return {
    endpoint,
    publicEndpoint,
    region: env.S3_REGION || 'us-east-1',
    bucket: env.S3_BUCKET as string,
    accessKeyId: env.S3_ACCESS_KEY_ID as string,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY as string,
    forcePathStyle: style === 'true',
    maxBytes,
  };
}
