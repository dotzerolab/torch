import type { Brand } from '@torch/shared/brand';
import { loadBrand } from '@torch/shared/brand';
import { describe, expect, it } from 'vitest';
import { renderMagicLinkEmail } from './magic-link-email.ts';

const acme: Brand = {
  productName: 'Acme Tasks',
  logoLight: '/acme/logo-light.svg',
  logoDark: '/acme/logo-dark.svg',
  favicon: '/acme/favicon.svg',
  accentColor: '#3366ff',
  emailSenderName: 'Acme Tasks',
  emailSenderAddress: 'no-reply@acme.example',
};
const link = 'https://app.example.test/auth/verify?token=abc_DEF-123';

describe('renderMagicLinkEmail', () => {
  it('renders EN and IT with the link, the brand name and the expiry', () => {
    const en = renderMagicLinkEmail({ brand: acme, locale: 'en', link, expiresInMinutes: 15 });
    const it_ = renderMagicLinkEmail({ brand: acme, locale: 'it', link, expiresInMinutes: 15 });

    expect(en.subject).toBe('Sign in to Acme Tasks');
    expect(it_.subject).toBe('Accedi a Acme Tasks');
    for (const mail of [en, it_]) {
      expect(mail.text).toContain(link);
      expect(mail.html).toContain(link);
      expect(mail.text).toContain('Acme Tasks');
      expect(mail.text).toContain('15');
      expect(mail.html).toContain('15');
    }
    expect(en.text).toContain('expires');
    expect(it_.text).toContain('scade');
  });

  it('a custom brand (Acme) appears in subject and body and the default product name does not', () => {
    const defaultName = loadBrand({}).productName;

    for (const locale of ['en', 'it'] as const) {
      const mail = renderMagicLinkEmail({ brand: acme, locale, link, expiresInMinutes: 15 });
      const all = `${mail.subject}\n${mail.text}\n${mail.html}`;

      expect(mail.subject).toContain('Acme Tasks');
      expect(mail.html).toContain('Acme Tasks');
      expect(all).not.toContain(defaultName);
    }
  });

  it('brand name and link are HTML-escaped in the html part', () => {
    const evil = { ...acme, productName: 'A<b>' };
    const evilLink = 'https://app.example.test/auth/verify?token=a&x="y"';

    const mail = renderMagicLinkEmail({
      brand: evil,
      locale: 'en',
      link: evilLink,
      expiresInMinutes: 15,
    });

    expect(mail.html).toContain('A&lt;b&gt;');
    expect(mail.html).not.toContain('A<b>');
    expect(mail.html).toContain('token=a&amp;x=&quot;y&quot;');
    // The plain-text part is not HTML: raw values stay as they are.
    expect(mail.text).toContain(evilLink);
  });
});
