import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type Brand, loadBrand } from '@torch/shared/brand';
import { describe, expect, it } from 'vitest';
import defaultBrandFile from '../../../../config/brand.default.json' with { type: 'json' };
import { buildManifest } from './manifest.ts';

const defaultBrand = loadBrand({});
const acme = loadBrand({
  BRAND_CONFIG_PATH: fileURLToPath(
    new URL('../../../web/e2e/fixtures/brand.acme.json', import.meta.url),
  ),
});
const publicDir = fileURLToPath(new URL('../../../web/public', import.meta.url));

describe('buildManifest, default brand', () => {
  const manifest = buildManifest(defaultBrand);

  it('is named after the brand and opens at the root as an installed app', () => {
    expect(manifest.name).toBe(defaultBrandFile.productName);
    expect(manifest.short_name).toBe(defaultBrandFile.productName);
    expect(manifest.start_url).toBe('/');
    expect(manifest.display).toBe('standalone');
    expect(manifest.theme_color).toBe(defaultBrandFile.accentColor);
    expect(manifest.background_color).toBe('#ffffff');
  });

  it('lists the three PNG icons and the SVG', () => {
    expect(manifest.icons).toEqual([
      { src: '/brand/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/brand/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      {
        src: '/brand/icon-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
      { src: '/brand/favicon.svg', sizes: 'any', type: 'image/svg+xml' },
    ]);
  });

  it('only points at files that exist in the web app', () => {
    for (const icon of manifest.icons) {
      expect(existsSync(`${publicDir}${icon.src}`), icon.src).toBe(true);
    }
  });
});

describe('buildManifest, custom brand', () => {
  const manifest = buildManifest(acme);

  it('takes name and colour from the brand and keeps the default product name out', () => {
    expect(manifest.name).toBe('Acme Tasks');
    expect(manifest.short_name).toBe('Acme Tasks');
    expect(manifest.theme_color).toBe(acme.accentColor);
    expect(JSON.stringify(manifest)).not.toContain(defaultBrandFile.productName);
  });

  it('has one icon: the brand favicon', () => {
    expect(manifest.icons).toEqual([
      { src: '/acme/favicon.svg', sizes: 'any', type: 'image/svg+xml' },
    ]);
  });

  it.each([
    ['/acme/icon.png', 'image/png'],
    ['/acme/favicon.ico', 'image/x-icon'],
    ['/acme/favicon.SVG', 'image/svg+xml'],
    ['/acme/favicon.svg?v=2', 'image/svg+xml'],
    ['https://cdn.example/acme/mark.png#top', 'image/png'],
  ])('gives %s the type %s', (favicon, type) => {
    const icon = buildManifest({ ...acme, favicon } as Brand).icons[0];
    expect(icon?.type).toBe(type);
    expect(icon?.sizes).toBe('any');
  });

  it.each(['/acme/icon.webp', '/acme/icon', '/acme/icon.'])('omits the type of %s', (favicon) => {
    const icon = buildManifest({ ...acme, favicon } as Brand).icons[0];
    expect(icon).toBeDefined();
    expect(icon).not.toHaveProperty('type');
  });
});
