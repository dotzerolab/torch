import type { Brand } from '@torch/shared/brand';
import { loadBrand } from '@torch/shared/brand';
import { describe, expect, it } from 'vitest';
import { renderInviteEmail } from './email.ts';

const acme: Brand = {
  productName: 'Acme Tasks',
  logoLight: '/acme/logo-light.svg',
  logoDark: '/acme/logo-dark.svg',
  favicon: '/acme/favicon.svg',
  accentColor: '#3366ff',
  emailSenderName: 'Acme Tasks',
  emailSenderAddress: 'no-reply@acme.example',
};
const link = 'https://app.example.test/invite#token=abc_DEF-123';
const base = {
  brand: acme,
  workspaceName: 'Globex Corp',
  inviterName: 'Ada Lovelace',
  role: 'member' as const,
  link,
  expiresInDays: 7,
};

describe('renderInviteEmail', () => {
  it('renders the English subject and body with inviter, workspace, brand, role, link and expiry', () => {
    const mail = renderInviteEmail({ ...base, locale: 'en' });

    expect(mail.subject).toBe('Ada Lovelace invited you to Globex Corp on Acme Tasks');
    for (const part of [mail.text, mail.html]) {
      expect(part).toContain(link);
      expect(part).toContain('Ada Lovelace');
      expect(part).toContain('Globex Corp');
      expect(part).toContain('Acme Tasks');
      expect(part).toContain('Member');
      expect(part).toContain('7 days');
    }
    expect(mail).not.toHaveProperty('to');
  });

  it('renders Italian', () => {
    const mail = renderInviteEmail({ ...base, locale: 'it', role: 'guest' });

    expect(mail.subject).toBe('Ada Lovelace ti invita a unirti a Globex Corp su Acme Tasks');
    for (const part of [mail.text, mail.html]) {
      expect(part).toContain(link);
      expect(part).toContain('Ospite');
      expect(part).toContain('7 giorni');
    }
    expect(mail.html).toContain('lang="it"');
    expect(mail.text).not.toContain('invited you');
  });

  it('names the role in the invitee language', () => {
    const labels = { owner: 'Owner', admin: 'Admin', member: 'Member', guest: 'Guest' } as const;
    const italian = {
      owner: 'Proprietario',
      admin: 'Amministratore',
      member: 'Membro',
      guest: 'Ospite',
    } as const;

    for (const role of ['owner', 'admin', 'member', 'guest'] as const) {
      expect(renderInviteEmail({ ...base, locale: 'en', role }).text).toContain(labels[role]);
      expect(renderInviteEmail({ ...base, locale: 'it', role }).text).toContain(italian[role]);
    }
  });

  it('uses the brand name and never the default product name', () => {
    const defaultName = loadBrand({}).productName;

    for (const locale of ['en', 'it'] as const) {
      const mail = renderInviteEmail({ ...base, locale });
      const all = `${mail.subject}\n${mail.text}\n${mail.html}`;

      expect(mail.subject).toContain('Acme Tasks');
      expect(all).not.toContain(defaultName);
    }
  });

  it('escapes the names, the brand and the link in the html part but not in the text part', () => {
    const evil = { ...acme, productName: 'A<b>' };
    const evilLink = 'https://app.example.test/invite#token=a&x="y"';

    const mail = renderInviteEmail({
      ...base,
      brand: evil,
      locale: 'en',
      inviterName: '<script>alert(1)</script>',
      workspaceName: 'Tom & "Jerry"',
      link: evilLink,
    });

    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(mail.html).toContain('Tom &amp; &quot;Jerry&quot;');
    expect(mail.html).toContain('A&lt;b&gt;');
    expect(mail.html).not.toContain('A<b>');
    expect(mail.html).toContain('token=a&amp;x=&quot;y&quot;');
    expect(mail.text).toContain('<script>alert(1)</script>');
    expect(mail.text).toContain(evilLink);
  });

  it('keeps line breaks in a name out of the subject (no header injection)', () => {
    const mail = renderInviteEmail({
      ...base,
      locale: 'en',
      inviterName: 'Ada\r\nBcc: victim@example.test',
      workspaceName: 'Glo\nbex',
    });

    expect(mail.subject).not.toMatch(/[\r\n]/);
    expect(mail.subject).toBe('Ada Bcc: victim@example.test invited you to Glo bex on Acme Tasks');
  });

  it('falls back to a safe accent colour for a malformed one', () => {
    const mail = renderInviteEmail({
      ...base,
      brand: { ...acme, accentColor: 'red;background:url(x)' },
      locale: 'en',
    });

    expect(mail.html).not.toContain('url(x)');
    expect(mail.html).toContain('#000000');
  });
});
