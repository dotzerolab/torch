import type { Locale } from '@torch/shared/i18n';
import { t } from '@torch/shared/i18n';
import type { MutationErrorCode } from '@torch/shared/mutations/issue';
import { ApiError } from './api.ts';

const MUTATION_CODES: ReadonlySet<string> = new Set<MutationErrorCode>([
  'unauthenticated',
  'not_found',
  'forbidden',
  'invalid_input',
  'invalid_state',
  'invalid_assignee',
]);

/**
 * What a person reads when a write was refused. The server's own texts are English developer fallbacks, so each
 * known code has an EN and IT text here; only a code this version of the web does not know shows the server text.
 */
export function mutationErrorMessage(locale: Locale, error: unknown): string {
  if (error instanceof ApiError) {
    if (MUTATION_CODES.has(error.code)) return t(locale, `mutation.error.${error.code}`);
    if (error.code === 'network') return t(locale, 'mutation.error.network');
    if (error.message) return error.message;
  }
  return t(locale, 'mutation.error.unknown');
}
