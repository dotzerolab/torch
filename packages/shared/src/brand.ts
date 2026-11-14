import { readFileSync } from 'node:fs';
import defaultBrand from '../../../config/brand.default.json' with { type: 'json' };

export type Brand = {
  productName: string;
  logoLight: string;
  logoDark: string;
  favicon: string;
  accentColor: string;
  emailSenderName: string;
  emailSenderAddress: string;
  supportUrl?: string;
  legalUrl?: string;
};

/** A brand file is unusable. The message names the file and the field so an operator can fix it. */
export class BrandConfigError extends Error {
  override name = 'BrandConfigError';
}

const DEFAULT_SOURCE = 'config/brand.default.json';
const REQUIRED_FIELDS = [
  'productName',
  'logoLight',
  'logoDark',
  'favicon',
  'accentColor',
  'emailSenderName',
  'emailSenderAddress',
] as const;
const OPTIONAL_FIELDS = ['supportUrl', 'legalUrl'] as const;
const KNOWN_FIELDS: readonly string[] = [...REQUIRED_FIELDS, ...OPTIONAL_FIELDS];
// The accent colour ends up in a CSS custom property, so only a plain hex colour is accepted.
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * Brand of this instance: the JSON file at BRAND_CONFIG_PATH when set, else the default brand.
 * Throws BrandConfigError (never returns a partial brand) so a typo stops startup.
 */
export function loadBrand(env: Record<string, string | undefined>): Brand {
  const path = env.BRAND_CONFIG_PATH;
  if (!path) return parseBrand(defaultBrand, DEFAULT_SOURCE);

  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new BrandConfigError(`Cannot read brand config at ${path}: ${(error as Error).message}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new BrandConfigError(
      `Invalid brand config at ${path}: not valid JSON (${(error as Error).message})`,
    );
  }
  return parseBrand(json, path);
}

function parseBrand(value: unknown, source: string): Brand {
  const fail = (reason: string): never => {
    throw new BrandConfigError(`Invalid brand config at ${source}: ${reason}`);
  };

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail('expected a JSON object');
  }
  const record = value as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (!KNOWN_FIELDS.includes(key)) fail(`unknown field "${key}"`);
  }
  for (const field of REQUIRED_FIELDS) {
    if (!(field in record)) fail(`missing required field "${field}"`);
    if (!isFilledString(record[field])) fail(`field "${field}" must be a non-empty string`);
  }
  for (const field of OPTIONAL_FIELDS) {
    if (field in record && !isFilledString(record[field])) {
      fail(`field "${field}" must be a non-empty string when present`);
    }
  }
  if (!HEX_COLOR.test(record.accentColor as string)) {
    fail('field "accentColor" must be a hex colour such as "#3366ff"');
  }

  return record as Brand;
}

function isFilledString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}
