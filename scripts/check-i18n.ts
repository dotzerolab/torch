// `pnpm i18n:check`: fails when a locale lacks a key that en.json has.
// Optional `--dir <folder>` checks another folder holding en.json and it.json (used by the test).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Catalogs, LOCALES, missingKeys } from '../packages/shared/src/i18n/index.ts';

const defaultDir = fileURLToPath(new URL('../packages/shared/src/i18n', import.meta.url));
const dirFlag = process.argv.indexOf('--dir');
const dir = dirFlag === -1 ? defaultDir : (process.argv[dirFlag + 1] ?? defaultDir);

const catalogs = Object.fromEntries(
  LOCALES.map((locale) => [locale, JSON.parse(readFileSync(join(dir, `${locale}.json`), 'utf8'))]),
) as Catalogs;

const missing = missingKeys(catalogs);
if (missing.length > 0) {
  console.error(`i18n:check failed, ${missing.length} missing translation(s) in ${dir}:`);
  for (const { locale, key } of missing) console.error(`  [${locale}] ${key}`);
  process.exit(1);
}
console.info(`i18n:check ok (${LOCALES.join(', ')})`);
