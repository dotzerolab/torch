import { type Locale, t } from '@torch/shared/i18n';
import { ApiError } from '../api.ts';
import { mutationErrorMessage } from '../errors.ts';

const CODES: ReadonlySet<string> = new Set([
  'forbidden',
  'not_found',
  'invalid_input',
  'issue_archived',
  'comment_deleted',
  'rate_limited',
]);

/**
 * What a person reads when a comment write was refused. The server's texts are English developer fallbacks, so every code
 * a comment write can end with has its own EN and IT text; anything else falls back to the issue-write messages.
 */
export function commentErrorMessage(locale: Locale, error: unknown): string {
  if (error instanceof ApiError) {
    if (CODES.has(error.code)) return t(locale, `comments.error.${error.code}`);
    if (error.code === 'network') return t(locale, 'comments.error.network');
  }
  return error instanceof ApiError
    ? mutationErrorMessage(locale, error)
    : t(locale, 'comments.error.unknown');
}
