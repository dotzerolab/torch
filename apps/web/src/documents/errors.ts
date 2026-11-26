import { type Locale, t } from '@torch/shared/i18n';
import { ApiError } from '../api.ts';

const CODES: ReadonlySet<string> = new Set([
  'forbidden',
  'not_found',
  'invalid_input',
  'document_archived',
  'rate_limited',
  'network',
]);

/** What a person reads when a document write was refused: one text per code, in EN and IT. */
export function documentErrorMessage(locale: Locale, error: unknown): string {
  const code = error instanceof ApiError && CODES.has(error.code) ? error.code : 'unknown';
  return t(locale, `documents.error.${code}`);
}
