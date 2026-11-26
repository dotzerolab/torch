import { type Locale, t } from '@torch/shared/i18n';
import { MAX_ATTACHMENT_BYTES } from '@torch/shared/mutations/attachment';
import { ApiError } from '../api.ts';

const CODES: ReadonlySet<string> = new Set([
  'file_too_large',
  'file_type_not_allowed',
  'file_rejected',
  'storage_unavailable',
  'too_many_attachments',
  'rate_limited',
  'issue_archived',
  'forbidden',
  'not_found',
  'invalid_input',
  'network',
]);

/** The size limit as a person reads it, in the language of the page (25 MB). */
export function limitText(locale: Locale): string {
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: 'megabyte',
    maximumFractionDigits: 0,
  }).format(MAX_ATTACHMENT_BYTES / 1024 / 1024);
}

/** What a person reads when an upload or a removal failed: one text per code, in EN and IT. */
export function attachmentErrorMessage(locale: Locale, error: unknown): string {
  const code = error instanceof ApiError && CODES.has(error.code) ? error.code : 'unknown';
  return t(locale, `attachments.error.${code}`, { limit: limitText(locale) });
}

/** A file size as a person reads it (12 KB, 3.4 MB). */
export function formatSize(locale: Locale, bytes: number): string {
  const [unit, divisor] =
    bytes >= 1024 * 1024
      ? (['megabyte', 1024 * 1024] as const)
      : bytes >= 1024
        ? (['kilobyte', 1024] as const)
        : (['byte', 1] as const);
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit,
    unitDisplay: 'short',
    maximumFractionDigits: unit === 'byte' ? 0 : 1,
  }).format(bytes / divisor);
}
