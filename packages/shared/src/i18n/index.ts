import en from './en.json' with { type: 'json' };
import it from './it.json' with { type: 'json' };

export type Locale = 'en' | 'it';
export const LOCALES: readonly Locale[] = ['en', 'it'];
/** English is the source language: its keys define what every other locale must translate. */
export const SOURCE_LOCALE: Locale = 'en';

export type Catalog = Record<string, string>;
export type Catalogs = Record<Locale, Catalog>;

const shipped: Catalogs = { en, it };
const logged = new Set<string>();

function logOnce(id: string, message: string) {
  if (logged.has(id)) return;
  logged.add(id);
  console.warn(message);
}

/**
 * Text for `key` in `locale`. `{name}` placeholders are filled from `vars` (callers always pass `brand`).
 * An unknown key returns the key itself and logs once; there is no silent fallback to another locale,
 * `pnpm i18n:check` is what keeps a missing translation from shipping.
 */
export function t(locale: Locale, key: string, vars?: Record<string, string>): string {
  const catalog = shipped[locale];
  const text = Object.hasOwn(catalog, key) ? catalog[key] : undefined;
  if (text === undefined) {
    logOnce(`${locale}:${key}`, `i18n: unknown key "${key}" for locale "${locale}"`);
    return key;
  }
  return text.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    vars && Object.hasOwn(vars, name) ? (vars[name] as string) : placeholder,
  );
}

/** Keys of the source locale that another locale lacks (an empty translation counts as lacking). */
export function missingKeys(catalogs: Catalogs = shipped): { locale: Locale; key: string }[] {
  const missing: { locale: Locale; key: string }[] = [];
  for (const locale of LOCALES) {
    if (locale === SOURCE_LOCALE) continue;
    for (const key of Object.keys(catalogs[SOURCE_LOCALE])) {
      const text = Object.hasOwn(catalogs[locale], key) ? catalogs[locale][key] : undefined;
      if (typeof text !== 'string' || text.trim() === '') missing.push({ locale, key });
    }
  }
  return missing;
}

/** Locale for a browser language tag: `it`, `it-IT`... give Italian, everything else English. */
export function detectLocale(language: string | undefined): Locale {
  return language?.toLowerCase().split('-')[0] === 'it' ? 'it' : 'en';
}
