import { describe, expect, it } from 'vitest';
import { sniffMatches } from './sniff.ts';

const text = (value: string) => new TextEncoder().encode(value);
const withBytes = (...parts: (number | string)[]) =>
  Uint8Array.from(parts.flatMap((part) => (typeof part === 'number' ? [part] : [...text(part)])));

const PNG = withBytes(0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13);
const JPEG = withBytes(0xff, 0xd8, 0xff, 0xe0, 0, 16);
const GIF = withBytes('GIF89a', 1, 0, 1, 0);
const WEBP = withBytes('RIFF', 36, 0, 0, 0, 'WEBP', 'VP8 ');
const WAVE = withBytes('RIFF', 36, 0, 0, 0, 'WAVE', 'fmt ');
const AVIF = withBytes(0, 0, 0, 28, 'ftypavif', 0, 0, 0, 0);
const MP4 = withBytes(0, 0, 0, 28, 'ftypmp42', 0, 0, 0, 0);
const PDF = withBytes('%PDF-1.7\n');
const ZIP = withBytes('PK', 3, 4, 20, 0, 0, 0);
const HTML = text('<!doctype html><script>alert(1)</script>');
const SVG = text('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');

// type, a head that belongs to it, a head that does not.
const CASES: [string, Uint8Array, Uint8Array][] = [
  ['image/png', PNG, GIF],
  ['image/jpeg', JPEG, PNG],
  ['image/gif', GIF, JPEG],
  ['image/webp', WEBP, WAVE],
  ['image/avif', AVIF, MP4],
  ['application/pdf', PDF, HTML],
  ['application/zip', ZIP, PNG],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', ZIP, PDF],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ZIP, PNG],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', ZIP, PDF],
];

describe('sniffMatches: binary types need their signature', () => {
  it.each(CASES)('%s accepts its own start and refuses another type', (type, right, wrong) => {
    expect(sniffMatches(type, right)).toBe(true);
    expect(sniffMatches(type, wrong)).toBe(false);
  });

  it('refuses html and svg declared as an image or a pdf', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf']) {
      expect(sniffMatches(type, HTML), type).toBe(false);
      expect(sniffMatches(type, SVG), type).toBe(false);
    }
  });

  it('refuses a head shorter than the signature and an empty one', () => {
    expect(sniffMatches('image/png', PNG.slice(0, 4))).toBe(false);
    expect(sniffMatches('image/webp', WEBP.slice(0, 10))).toBe(false);
    expect(sniffMatches('image/png', new Uint8Array())).toBe(false);
  });

  it('accepts an empty zip, whose first bytes are the end record', () => {
    expect(sniffMatches('application/zip', withBytes('PK', 5, 6, 0, 0))).toBe(true);
  });
});

describe('sniffMatches: text types need no NUL byte', () => {
  it.each(['text/plain', 'text/csv', 'text/markdown', 'application/json'])('%s', (type) => {
    expect(sniffMatches(type, text('a,b\n1,2\n'))).toBe(true);
    expect(sniffMatches(type, text('héllo wörld ✓'))).toBe(true);
    expect(sniffMatches(type, withBytes('abc', 0, 'def'))).toBe(false);
    expect(sniffMatches(type, PNG)).toBe(false);
  });

  it('accepts a text file that is empty after its first bytes were read (a one-byte file)', () => {
    expect(sniffMatches('text/plain', text('x'))).toBe(true);
  });
});

describe('sniffMatches: anything off the list is refused', () => {
  it('unknown, html, svg, javascript and prototype names', () => {
    for (const type of ['text/html', 'image/svg+xml', 'application/javascript', '__proto__', '']) {
      expect(sniffMatches(type, text('hello')), type).toBe(false);
    }
  });

  it('matches the type without regard to case', () => {
    expect(sniffMatches('IMAGE/PNG', PNG)).toBe(true);
  });
});
