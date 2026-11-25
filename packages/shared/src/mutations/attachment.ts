// What a client may send to start an upload, and the rules for what may be stored: the type allowlist, the size
// limits and the file name sanitiser. Shared so the web checks a file before it sends a byte and the server checks
// the same rules when it presigns, verifies and serves. No Node imports: this file reaches the browser bundle.
import { z } from 'zod';

/** The largest file, in bytes (25 MiB). The server's `ATTACHMENT_MAX_BYTES` may lower it, never raise it. */
export const MAX_ATTACHMENT_BYTES = 26_214_400;
/** Ready and pending files together, per issue. */
export const MAX_ATTACHMENTS_PER_ISSUE = 50;
/** The longest stored file name, in characters. */
export const MAX_FILE_NAME_LENGTH = 200;

/**
 * One allowed type. `signature` lists the leading byte patterns a real file of the type starts with (`null` matches
 * any byte, for the length field of a RIFF or MP4-style header); a file that matches none is refused. Text types have
 * none: they are checked for NUL bytes instead. `inline` is true only for raster images, the one kind a browser may
 * show inside a page; everything else downloads.
 */
export type AttachmentType = {
  extensions: string[];
  inline: boolean;
  signature?: (number | null)[][];
};

const bytes = (text: string): number[] => [...text].map((char) => char.charCodeAt(0));
const ZIP: (number | null)[][] = [
  [0x50, 0x4b, 0x03, 0x04],
  [0x50, 0x4b, 0x05, 0x06],
];

/** The allowlist. Anything that is not a key here is refused, whatever its name says: html, svg, xml, scripts. */
export const ATTACHMENT_TYPES: Readonly<Record<string, AttachmentType>> = {
  'image/png': {
    extensions: ['png'],
    inline: true,
    signature: [[0x89, ...bytes('PNG'), 0x0d, 0x0a, 0x1a, 0x0a]],
  },
  'image/jpeg': { extensions: ['jpg', 'jpeg'], inline: true, signature: [[0xff, 0xd8, 0xff]] },
  'image/gif': {
    extensions: ['gif'],
    inline: true,
    signature: [bytes('GIF87a'), bytes('GIF89a')],
  },
  'image/webp': {
    extensions: ['webp'],
    inline: true,
    signature: [[...bytes('RIFF'), null, null, null, null, ...bytes('WEBP')]],
  },
  'image/avif': {
    extensions: ['avif'],
    inline: true,
    signature: [
      [null, null, null, null, ...bytes('ftypavif')],
      [null, null, null, null, ...bytes('ftypavis')],
    ],
  },
  'application/pdf': { extensions: ['pdf'], inline: false, signature: [bytes('%PDF')] },
  'application/zip': { extensions: ['zip'], inline: false, signature: ZIP },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
    extensions: ['docx'],
    inline: false,
    signature: ZIP,
  },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
    extensions: ['xlsx'],
    inline: false,
    signature: ZIP,
  },
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': {
    extensions: ['pptx'],
    inline: false,
    signature: ZIP,
  },
  'text/plain': { extensions: ['txt', 'log'], inline: false },
  'text/csv': { extensions: ['csv'], inline: false },
  'text/markdown': { extensions: ['md', 'markdown'], inline: false },
  'application/json': { extensions: ['json'], inline: false },
};

const contentType = z
  .string()
  .trim()
  .toLowerCase()
  .refine((value) => Object.hasOwn(ATTACHMENT_TYPES, value), { message: 'file type not allowed' });

/**
 * The start of an upload: what the browser says the file is. The server presigns a request that enforces the size and
 * the type at the storage, then verifies the stored object. The name is cleaned by `safeFileName` before it is kept.
 */
export const attachmentInitInput = z.strictObject({
  fileName: z.string().min(1).max(1000),
  contentType,
  size: z.number().int().min(1).max(MAX_ATTACHMENT_BYTES),
});
export type AttachmentInitInput = z.infer<typeof attachmentInitInput>;

// Bidirectional overrides, zero-width and byte-order characters: they let `evil‮gnp.exe` read as `evilexe.png`.
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/g;

/**
 * A file name that is safe to store and to put in a Content-Disposition header: no directory part (either slash),
 * no control character, quote or invisible formatting character, no leading dot, 1..200 characters, never empty.
 * A name over the limit is cut in the stem, so the extension stays.
 */
export function safeFileName(raw: string): string {
  const base = raw.normalize('NFC').replace(CONTROL, '').split(/[\\/]/).pop() ?? '';
  const cleaned = base
    .replace(INVISIBLE, '')
    .replace(/["'`]/g, '')
    .trim()
    .replace(/^[.\s]+/, '')
    .trim();
  if (cleaned === '') return 'file';
  if (cleaned.length <= MAX_FILE_NAME_LENGTH) return cleaned;
  const dot = cleaned.lastIndexOf('.');
  const extension = dot > 0 && cleaned.length - dot <= 16 ? cleaned.slice(dot) : '';
  const stem = cleaned.slice(0, dot > 0 && extension ? dot : cleaned.length);
  return stem.slice(0, MAX_FILE_NAME_LENGTH - extension.length) + extension;
}
