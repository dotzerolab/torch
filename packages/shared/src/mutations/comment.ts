// What a client may send to write a comment, shared so the web validates before sending and the server validates
// what arrives. No Node imports: this file reaches the browser bundle.
import { z } from 'zod';

/** An id from a request: any case is accepted, the stored lower-case form is what the code compares. */
const id = z.guid().toLowerCase();

/** The longest comment a client may send, in characters. */
export const MAX_COMMENT_LENGTH = 20_000;

/** The reactions a comment accepts. A fixed set keeps the stored column small and the picker the same everywhere. */
export const REACTION_EMOJI = ['👍', '👎', '😄', '🎉', '😕', '❤️', '🚀', '👀'] as const;
export type ReactionEmoji = (typeof REACTION_EMOJI)[number];

const body = z.string().trim().min(1).max(MAX_COMMENT_LENGTH);

/**
 * A new comment. `parentId` makes it a reply: it must be a top-level comment of the same issue (the server checks;
 * a reply to a reply is refused). The issue comes from the route, never from the body.
 */
export const commentCreateInput = z.strictObject({ body, parentId: id.optional() });
export type CommentCreateInput = z.infer<typeof commentCreateInput>;

/** A new body for an existing comment. Only the author sends one; the previous body stays in the history. */
export const commentEditInput = z.strictObject({ body });
export type CommentEditInput = z.infer<typeof commentEditInput>;

export const reactionEmoji = z.enum(REACTION_EMOJI);
