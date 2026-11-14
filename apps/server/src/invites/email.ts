// The invitation email: one text and one HTML part, in the language chosen for the invitee, carrying the instance
// brand, the workspace, the inviter and the role.
import type { Brand } from '@torch/shared/brand';
import { type Locale, t } from '@torch/shared/i18n';
import type { Role } from '@torch/shared/permissions';
import type { MailMessage } from '../mail/mailer.ts';

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] as string);

/** Names are typed by people: line breaks would end a mail header early, so every run of whitespace is one space. */
const singleLine = (value: string) => value.replace(/\s+/g, ' ').trim();

export function renderInviteEmail(input: {
  brand: Brand;
  locale: Locale;
  workspaceName: string;
  inviterName: string;
  role: Role;
  link: string;
  expiresInDays: number;
}): Omit<MailMessage, 'to'> {
  const { brand, locale, link } = input;
  const vars = {
    brand: singleLine(brand.productName),
    workspace: singleLine(input.workspaceName),
    inviter: singleLine(input.inviterName),
    role: t(locale, `role.${input.role}`),
    days: String(input.expiresInDays),
  };
  const subject = t(locale, 'invite.email.subject', vars);
  const intro = t(locale, 'invite.email.intro', vars);
  const button = t(locale, 'invite.email.button', vars);
  const expiry = t(locale, 'invite.email.expiry', vars);
  const ignore = t(locale, 'invite.email.ignore', vars);

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
