import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const mainPath = join(dirname(fileURLToPath(import.meta.url)), 'main.ts');

describe('server startup', () => {
  it('stops with the file path and field name when the brand file is missing a field', () => {
    const dir = mkdtempSync(join(tmpdir(), 'main-test-'));
    try {
      const brandPath = join(dir, 'brand.json');
      writeFileSync(brandPath, JSON.stringify({ logoLight: '/x.svg' }));

      const result = spawnSync(process.execPath, [mainPath], {
        env: { ...process.env, PORT: '43901', BRAND_CONFIG_PATH: brandPath },
        encoding: 'utf8',
        timeout: 15_000,
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(brandPath);
      expect(result.stderr).toContain('productName');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stops with a clear message when APP_URL is not an http(s) URL while a database is configured', () => {
    const result = spawnSync(process.execPath, [mainPath], {
      env: {
        ...process.env,
        PORT: '43902',
        BRAND_CONFIG_PATH: '',
        DATABASE_URL: 'postgres://u:p@127.0.0.1:1/x',
        APP_URL: 'not a url',
      },
      encoding: 'utf8',
      timeout: 15_000,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('APP_URL');
  });

  it('stops with a clear message when TRUST_PROXY is neither true nor false', () => {
    const result = spawnSync(process.execPath, [mainPath], {
      env: {
        ...process.env,
        PORT: '43903',
        BRAND_CONFIG_PATH: '',
        DATABASE_URL: 'postgres://u:p@127.0.0.1:1/x',
        APP_URL: 'http://localhost:5173',
        TRUST_PROXY: 'maybe',
      },
      encoding: 'utf8',
      timeout: 15_000,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('TRUST_PROXY');
  });

  it('stops with a clear message that names the missing variable when S3_ENDPOINT is set without a bucket', () => {
    const result = spawnSync(process.execPath, [mainPath], {
      env: {
        ...process.env,
        PORT: '43904',
        BRAND_CONFIG_PATH: '',
        DATABASE_URL: '',
        S3_ENDPOINT: 'http://127.0.0.1:1',
        S3_BUCKET: '',
        S3_ACCESS_KEY_ID: 'id-for-the-test',
        S3_SECRET_ACCESS_KEY: 'secret-for-the-test',
      },
      encoding: 'utf8',
      timeout: 15_000,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('S3_BUCKET');
    expect(result.stderr).not.toContain('secret-for-the-test');
  });
});
