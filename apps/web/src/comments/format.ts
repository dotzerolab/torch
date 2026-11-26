import type { Locale } from '@torch/shared/i18n';

/** A moment as a person reads it: a short date and the time, in the language of the page. */
export function formatMoment(locale: Locale, iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return '';
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(time);
}
