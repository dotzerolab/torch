import { describe, expect, it } from 'vitest';
import { readStorageConfig, StorageConfigError } from './config.ts';

const full = {
  S3_ENDPOINT: 'http://localhost:9000',
  S3_BUCKET: 'attachments-test',
  S3_ACCESS_KEY_ID: 'access-id-0000',
  S3_SECRET_ACCESS_KEY: 'secret-value-0000',
};

describe('readStorageConfig', () => {
  it('is null without S3_ENDPOINT: attachments are off', () => {
    expect(readStorageConfig({})).toBeNull();
    expect(readStorageConfig({ S3_ENDPOINT: '', S3_BUCKET: 'x' })).toBeNull();
  });

  it('reads the group with defaults for the optional variables', () => {
    expect(readStorageConfig(full)).toEqual({
      endpoint: 'http://localhost:9000',
      publicEndpoint: 'http://localhost:9000',
      region: 'us-east-1',
      bucket: 'attachments-test',
      accessKeyId: 'access-id-0000',
      secretAccessKey: 'secret-value-0000',
      forcePathStyle: true,
      maxBytes: 26_214_400,
    });
  });

  it('takes the optional variables when set, and drops a trailing slash', () => {
    const config = readStorageConfig({
      ...full,
      S3_ENDPOINT: 'http://storage:9000/',
      S3_PUBLIC_ENDPOINT: 'https://files.example.test/',
      S3_REGION: 'eu-west-1',
      S3_FORCE_PATH_STYLE: 'false',
      ATTACHMENT_MAX_BYTES: '1048576',
    });

    expect(config).toMatchObject({
      endpoint: 'http://storage:9000',
      publicEndpoint: 'https://files.example.test',
      region: 'eu-west-1',
      forcePathStyle: false,
      maxBytes: 1_048_576,
    });
  });

  it.each(['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const)(
    'throws a message that names %s when it is missing, and never a value',
    (missing) => {
      const env = { ...full, [missing]: undefined };

      let message = '';
      try {
        readStorageConfig(env);
      } catch (error) {
        expect(error).toBeInstanceOf(StorageConfigError);
        message = (error as Error).message;
      }

      expect(message).toContain(missing);
      expect(message).not.toContain('secret-value-0000');
      expect(message).not.toContain('access-id-0000');
    },
  );

  it('refuses endpoints that are not http(s) URLs', () => {
    expect(() => readStorageConfig({ ...full, S3_ENDPOINT: 'localhost:9000' })).toThrow(
      /S3_ENDPOINT/,
    );
    expect(() => readStorageConfig({ ...full, S3_PUBLIC_ENDPOINT: 'ftp://files.test' })).toThrow(
      /S3_PUBLIC_ENDPOINT/,
    );
  });

  it('refuses a flag that is not true or false', () => {
    expect(() => readStorageConfig({ ...full, S3_FORCE_PATH_STYLE: 'yes' })).toThrow(
      /S3_FORCE_PATH_STYLE/,
    );
  });

  it.each(['0', '-5', '1.5', 'abc', '26214401', '5368709121'])(
    'refuses ATTACHMENT_MAX_BYTES=%s',
    (value) => {
      expect(() => readStorageConfig({ ...full, ATTACHMENT_MAX_BYTES: value })).toThrow(
        /ATTACHMENT_MAX_BYTES/,
      );
    },
  );

  it('accepts the largest value the database allows', () => {
    expect(readStorageConfig({ ...full, ATTACHMENT_MAX_BYTES: '26214400' })?.maxBytes).toBe(
      26_214_400,
    );
  });
});
