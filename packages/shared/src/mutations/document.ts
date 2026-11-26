// What a client may send to write a team document. Shared so the web validates before sending and the server
// validates what arrives. No Node imports: this file reaches the browser bundle.
import { z } from 'zod';

/** An id from a request: any case is accepted, the stored lower-case form is what the code compares. */
const id = z.guid().toLowerCase();

/** The longest document body a client may send, in characters. */
export const MAX_DOCUMENT_LENGTH = 100_000;
/** The longest document title, in characters. */
export const MAX_DOCUMENT_TITLE_LENGTH = 255;

const title = z.string().trim().min(1).max(MAX_DOCUMENT_TITLE_LENGTH);
const body = z.string().max(MAX_DOCUMENT_LENGTH);

/** A new document of a team. The body is optional and may be empty. */
export const documentCreateInput = z.strictObject({ teamId: id, title, body: body.optional() });
export type DocumentCreateInput = z.infer<typeof documentCreateInput>;

/** Per-field update: a field that is absent stays as it is; at least one field is required. */
export const documentUpdateInput = z
  .strictObject({ title: title.optional(), body: body.optional() })
  .refine((input) => input.title !== undefined || input.body !== undefined, {
    message: 'at least one field is required',
  });
export type DocumentUpdateInput = z.infer<typeof documentUpdateInput>;
