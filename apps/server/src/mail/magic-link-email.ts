// The sign-in email: one text and one HTML part, in the member's locale, carrying the instance brand.
import type { Brand } from '@torch/shared/brand';
import { type Locale, t } from '@torch/shared/i18n';
import type { MailMessage } from './mailer.ts';

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] as string);

export function renderMagicLinkEmail(input: {
  brand: Brand;
  locale: Locale;
  link: string;
  expiresInMinutes: number;
}): Omit<MailMessage, 'to'> {
  const { brand, locale, link } = input;
  const vars = { brand: brand.productName, minutes: String(input.expiresInMinutes) };
  const subject = t(locale, 'auth.email.subject', vars);
  const intro = t(locale, 'auth.email.intro', vars);
  const button = t(locale, 'auth.email.button', vars);
  const expiry = t(locale, 'auth.email.expiry', vars);
  const ignore = t(locale, 'auth.email.ignore', vars);

  const text = [intro, '', `${button}: ${link}`, '', expiry, ignore].join('\n');

  const accent = /^#[0-9a-fA-F]{3,6}$/.test(brand.accentColor) ? brand.accentColor : '#000000';
  const html = [
    '<!doctype html>',
    `<html lang="${locale}"><body style="font-family:sans-serif;color:#111;">`,
    `<p>${escapeHtml(intro)}</p>`,
    `<p><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 18px;background:${accent};color:#fff;text-decoration:none;border-radius:6px;">${escapeHtml(button)}</a></p>`,
    `<p style="color:#555;">${escapeHtml(expiry)}<br>${escapeHtml(ignore)}</p>`,
    '</body></html>',
  ].join('\n');

  return { subject, text, html };
}
