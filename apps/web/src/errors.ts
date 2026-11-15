import type { Locale } from '@torch/shared/i18n';
import { t } from '@torch/shared/i18n';
import { ADMIN_ERROR_CODES, type AdminErrorCode } from '@torch/shared/mutations/admin';
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

const ADMIN_CODES: ReadonlySet<string> = new Set<AdminErrorCode>(ADMIN_ERROR_CODES);

/** What a person reads for a refusal of an admin call (members, teams, invites). One text per code, in EN and IT. */
export function adminErrorMessage(locale: Locale, code: AdminErrorCode): string {
  return t(locale, `admin.error.${code}`);
}

/**
 * The text for whatever an admin call threw: a known code gets its translation (the server's own text is an English
 * developer fallback), no answer at all says so, and a code this web does not know shows the server text.
 */
export function adminFailureMessage(locale: Locale, error: unknown): string {
  if (error instanceof ApiError) {
    if (ADMIN_CODES.has(error.code)) return adminErrorMessage(locale, error.code as AdminErrorCode);
    if (error.code === 'network') return t(locale, 'admin.error.network');
    if (error.message) return error.message;
  }
  return t(locale, 'admin.error.unknown');
}
