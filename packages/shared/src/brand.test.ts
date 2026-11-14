import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { BrandConfigError, loadBrand } from './brand.ts';

const dir = mkdtempSync(join(tmpdir(), 'brand-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const validBrand = {
  productName: 'Acme Tasks',
  logoLight: '/acme/logo-light.svg',
  logoDark: '/acme/logo-dark.svg',
  favicon: '/acme/favicon.svg',
  accentColor: '#3366ff',
  emailSenderName: 'Acme Tasks',
  emailSenderAddress: 'no-reply@acme.example',
};

function brandFile(name: string, content: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
  return path;
}

describe('loadBrand', () => {
  it('uses the default brand when BRAND_CONFIG_PATH is unset', () => {
    expect(loadBrand({}).productName).toBe('Torch');
  });

  it('treats an empty BRAND_CONFIG_PATH as unset', () => {
    expect(loadBrand({ BRAND_CONFIG_PATH: '' }).productName).toBe('Torch');
  });

  it('reads the custom file named by BRAND_CONFIG_PATH', () => {
    const path = brandFile('custom.json', validBrand);

    expect(loadBrand({ BRAND_CONFIG_PATH: path }).productName).toBe('Acme Tasks');
  });

  it('keeps the optional links when present', () => {
    const path = brandFile('links.json', {
      ...validBrand,
      supportUrl: 'https://acme.example/help',
      legalUrl: 'https://acme.example/legal',
    });

    const brand = loadBrand({ BRAND_CONFIG_PATH: path });

    expect(brand.supportUrl).toBe('https://acme.example/help');
    expect(brand.legalUrl).toBe('https://acme.example/legal');
  });

  it('throws with the file path and the field name when productName is missing', () => {
    const { productName: _omitted, ...withoutName } = validBrand;
    const path = brandFile('no-name.json', withoutName);

    const error = catchError(() => loadBrand({ BRAND_CONFIG_PATH: path }));

    expect(error).toBeInstanceOf(BrandConfigError);
    expect(error.message).toContain(path);
    expect(error.message).toContain('productName');
  });

  it('throws with the path when the file does not exist', () => {
    const path = join(dir, 'does-not-exist.json');

    const error = catchError(() => loadBrand({ BRAND_CONFIG_PATH: path }));

    expect(error).toBeInstanceOf(BrandConfigError);
    expect(error.message).toContain(path);
  });

  it('throws with the path when the file is not valid JSON', () => {
    const path = brandFile('broken.json', '{ "productName": ');

    const error = catchError(() => loadBrand({ BRAND_CONFIG_PATH: path }));

    expect(error.message).toContain(path);
    expect(error.message).toMatch(/JSON/);
  });

  it('rejects an empty required field instead of rendering it blank', () => {
    const path = brandFile('empty-name.json', { ...validBrand, productName: '  ' });

    const error = catchError(() => loadBrand({ BRAND_CONFIG_PATH: path }));

    expect(error.message).toContain(path);
    expect(error.message).toContain('productName');
  });

  it('rejects a field with the wrong type, naming the field', () => {
    const path = brandFile('wrong-type.json', { ...validBrand, emailSenderName: 42 });

    const error = catchError(() => loadBrand({ BRAND_CONFIG_PATH: path }));

    expect(error.message).toContain(path);
    expect(error.message).toContain('emailSenderName');
  });

  it('rejects an unknown field so a typo in an optional field is not silently dropped', () => {
    const path = brandFile('typo.json', { ...validBrand, suportUrl: 'https://acme.example' });

    const error = catchError(() => loadBrand({ BRAND_CONFIG_PATH: path }));

    expect(error.message).toContain(path);
    expect(error.message).toContain('suportUrl');
  });

  it('rejects an accent colour that is not a hex colour', () => {
    const path = brandFile('bad-accent.json', { ...validBrand, accentColor: 'red; x: y' });

    const error = catchError(() => loadBrand({ BRAND_CONFIG_PATH: path }));

    expect(error.message).toContain(path);
    expect(error.message).toContain('accentColor');
  });

  it('rejects a JSON value that is not an object', () => {
    const path = brandFile('array.json', '[]');

    const error = catchError(() => loadBrand({ BRAND_CONFIG_PATH: path }));

    expect(error.message).toContain(path);
  });
});

function catchError(fn: () => unknown): Error {
  try {
    fn();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the call to throw');
}
