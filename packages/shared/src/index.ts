// Node-side entry. The web app imports the subpaths (`@torch/shared/brand`, `@torch/shared/i18n`)
// so nothing that touches `node:fs` reaches the browser bundle.
export { type Brand, BrandConfigError, loadBrand } from './brand.ts';
export { LOCALES, type Locale, missingKeys, t } from './i18n/index.ts';
