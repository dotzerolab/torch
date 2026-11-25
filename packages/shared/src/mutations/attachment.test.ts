import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT_TYPES,
  attachmentInitInput,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_ISSUE,
  safeFileName,
} from './attachment.ts';

const init = (over: Record<string, unknown> = {}) =>
  attachmentInitInput.safeParse({
    fileName: 'a.png',
    contentType: 'image/png',
    size: 1000,
    ...over,
  });

describe('limits', () => {
  it('are 25 MiB and 50 files', () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(26_214_400);
    expect(MAX_ATTACHMENTS_PER_ISSUE).toBe(50);
  });
});

describe('ATTACHMENT_TYPES', () => {
  it('is the allowlist: raster images, pdf, text, csv, markdown, json, zip and Office', () => {
    expect(Object.keys(ATTACHMENT_TYPES).sort()).toEqual(
      [
        'application/json',
        'application/pdf',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/zip',
        'image/avif',
        'image/gif',
        'image/jpeg',
        'image/png',
        'image/webp',
        'text/csv',
        'text/markdown',
        'text/plain',
      ].sort(),
    );
  });

  it('lets a browser show raster images inline and nothing else', () => {
    const inline = Object.entries(ATTACHMENT_TYPES)
      .filter(([, spec]) => spec.inline)
      .map(([type]) => type)
      .sort();

    expect(inline).toEqual(['image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/webp']);
  });

  it('never lists html, svg, xml, javascript or video and audio', () => {
    for (const type of Object.keys(ATTACHMENT_TYPES)) {
      expect(type).not.toMatch(
        /html|svg|^(application|text)\/xml|javascript|ecmascript|^video\/|^audio\//,
      );
    }
  });

  it('gives every binary type a signature and every text type none', () => {
    for (const [type, spec] of Object.entries(ATTACHMENT_TYPES)) {
      const isText = type.startsWith('text/') || type === 'application/json';
      expect(spec.signature === undefined, type).toBe(isText);
      expect(spec.extensions.length, type).toBeGreaterThan(0);
    }
  });
});

describe('attachmentInitInput', () => {
  it('accepts an allowed type with a size in range', () => {
    expect(init().success).toBe(true);
    expect(init({ contentType: 'application/pdf', fileName: 'spec.pdf' }).success).toBe(true);
    expect(init({ size: MAX_ATTACHMENT_BYTES }).success).toBe(true);
  });

  it.each([
    'text/html',
    'image/svg+xml',
    'application/javascript',
    'application/octet-stream',
    'text/xml',
    'video/mp4',
    'audio/mpeg',
    '',
    '__proto__',
    'constructor',
  ])('refuses the type %s', (contentType) => {
    expect(init({ contentType }).success).toBe(false);
  });

  it('matches the type without case or parameters in the way', () => {
    expect(init({ contentType: 'IMAGE/PNG' }).success).toBe(true);
    expect(init({ contentType: 'image/png; charset=utf-8' }).success).toBe(false);
  });

  it('refuses size 0, a negative size, MAX + 1, a float and a string', () => {
    expect(init({ size: 0 }).success).toBe(false);
    expect(init({ size: -5 }).success).toBe(false);
    expect(init({ size: MAX_ATTACHMENT_BYTES + 1 }).success).toBe(false);
    expect(init({ size: 10.5 }).success).toBe(false);
    expect(init({ size: '1000' }).success).toBe(false);
  });

  it('refuses an empty file name, an unknown key and a missing field', () => {
    expect(init({ fileName: '' }).success).toBe(false);
    expect(init({ uploaderId: 'x' }).success).toBe(false);
    expect(attachmentInitInput.safeParse({ fileName: 'a.png', size: 5 }).success).toBe(false);
  });
});

describe('safeFileName', () => {
  it('strips the path', () => {
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('C:\\Users\\me\\report.pdf')).toBe('report.pdf');
    expect(safeFileName('/abs/olute/shot.png')).toBe('shot.png');
  });

  it('removes quotes, control characters, CR and LF', () => {
    const name = safeFileName('a"b\r\nc.png');

    expect([...name].some((char) => char === '"' || char === "'" || char.charCodeAt(0) < 32)).toBe(
      false,
    );
    expect(name.endsWith('.png')).toBe(true);
    expect(safeFileName("it's.txt")).not.toContain("'");
  });

  it('removes bidi override and zero-width characters', () => {
    expect(safeFileName('evil\u202Egnp.exe')).toBe('evilgnp.exe');
    expect(safeFileName('a\u200Bb.txt')).toBe('ab.txt');
  });

  it('never returns an empty name', () => {
    expect(safeFileName('')).toBe('file');
    expect(safeFileName('   ')).toBe('file');
    expect(safeFileName('..')).toBe('file');
    expect(safeFileName('///')).toBe('file');
    expect(safeFileName('"\r\n')).toBe('file');
  });

  it('does not return a name that starts with a dot', () => {
    expect(safeFileName('.htaccess')).toBe('htaccess');
  });

  it('cuts a 400-character name to 200 and keeps the extension', () => {
    const name = safeFileName(`${'x'.repeat(400)}.pdf`);

    expect(name.length).toBe(200);
    expect(name.endsWith('.pdf')).toBe(true);
  });

  it('cuts a long name without an extension', () => {
    expect(safeFileName('y'.repeat(500)).length).toBe(200);
  });

  it('leaves an ordinary name alone', () => {
    expect(safeFileName('Quarterly report (final).xlsx')).toBe('Quarterly report (final).xlsx');
    expect(safeFileName('schermata è ü 日本語.png')).toBe('schermata è ü 日本語.png');
  });
});
