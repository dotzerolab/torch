import type { Brand } from '@torch/shared/brand';
import defaultBrand from '../../../../config/brand.default.json' with { type: 'json' };

export type WebManifestIcon = {
  src: string;
  sizes: string;
  type?: string;
  purpose?: 'any' | 'maskable';
};

export type WebManifest = {
  name: string;
  short_name: string;
  start_url: '/';
  display: 'standalone';
  theme_color: string;
  background_color: '#ffffff';
  icons: WebManifestIcon[];
};

// The PNG set shipped in apps/web/public/brand next to the default brand's favicon.
const DEFAULT_ICONS: WebManifestIcon[] = [
  { src: '/brand/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
  { src: '/brand/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
  { src: '/brand/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  { src: defaultBrand.favicon, sizes: 'any', type: 'image/svg+xml' },
];

const ICON_TYPES: Record<string, string> = {
  svg: 'image/svg+xml',
  png: 'image/png',
  ico: 'image/x-icon',
};

/** The MIME type for a favicon path or URL by its extension; undefined when the extension says nothing. */
function iconType(favicon: string): string | undefined {
  const path = favicon.split(/[?#]/, 1)[0] ?? '';
  const extension = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  return extension ? ICON_TYPES[extension] : undefined;
}

/**
 * The web app manifest of an instance. Name, colour and icon come from the brand, so an installed app never shows
 * another product's name. The default brand brings its full icon set; a custom brand has only its favicon.
 */
export function buildManifest(brand: Brand): WebManifest {
  const type = iconType(brand.favicon);
  const icons: WebManifestIcon[] =
    brand.favicon === defaultBrand.favicon
      ? DEFAULT_ICONS
      : [{ src: brand.favicon, sizes: 'any', ...(type ? { type } : {}) }];
  return {
    name: brand.productName,
    short_name: brand.productName,
    start_url: '/',
    display: 'standalone',
    theme_color: brand.accentColor,
    background_color: '#ffffff',
    icons,
  };
}
