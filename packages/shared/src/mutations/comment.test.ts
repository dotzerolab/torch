import { describe, expect, it } from 'vitest';
import {
  commentCreateInput,
  commentEditInput,
  MAX_COMMENT_LENGTH,
  REACTION_EMOJI,
  reactionEmoji,
} from './comment.ts';

const ID = '3f2b8c1e-9d4a-4e6b-8a7c-1b2d3e4f5a6b';

describe('commentCreateInput', () => {
  it('accepts a body and trims it', () => {
    const parsed = commentCreateInput.parse({ body: '  Looks good\n' });

    expect(parsed).toEqual({ body: 'Looks good' });
  });

  it('refuses an empty body and a body of whitespace only', () => {
    expect(commentCreateInput.safeParse({ body: '' }).success).toBe(false);
    expect(commentCreateInput.safeParse({ body: ' \n\t ' }).success).toBe(false);
  });

  it('accepts the longest body and refuses one character more', () => {
    expect(commentCreateInput.safeParse({ body: 'a'.repeat(MAX_COMMENT_LENGTH) }).success).toBe(
      true,
    );
    expect(commentCreateInput.safeParse({ body: 'a'.repeat(MAX_COMMENT_LENGTH + 1) }).success).toBe(
      false,
    );
    expect(MAX_COMMENT_LENGTH).toBe(20_000);
  });

  it('refuses an unknown key (strict)', () => {
    expect(commentCreateInput.safeParse({ body: 'x', authorId: ID }).success).toBe(false);
    expect(commentCreateInput.safeParse({ body: 'x', issueId: ID }).success).toBe(false);
  });

  it('wants a guid as parentId and lower-cases it', () => {
    expect(commentCreateInput.safeParse({ body: 'x', parentId: 'not-a-guid' }).success).toBe(false);
    expect(commentCreateInput.parse({ body: 'x', parentId: ID.toUpperCase() }).parentId).toBe(ID);
  });
});

describe('commentEditInput', () => {
  it('takes a body only, trimmed, 1..MAX', () => {
    expect(commentEditInput.parse({ body: ' new ' })).toEqual({ body: 'new' });
    expect(commentEditInput.safeParse({ body: '' }).success).toBe(false);
    expect(commentEditInput.safeParse({ body: 'a'.repeat(MAX_COMMENT_LENGTH + 1) }).success).toBe(
      false,
    );
    expect(commentEditInput.safeParse({ body: 'x', parentId: ID }).success).toBe(false);
  });
});

describe('reactionEmoji', () => {
  it('is exactly the fixed set of eight', () => {
    expect([...REACTION_EMOJI]).toEqual(['👍', '👎', '😄', '🎉', '😕', '❤️', '🚀', '👀']);
    for (const emoji of REACTION_EMOJI) expect(reactionEmoji.safeParse(emoji).success).toBe(true);
  });

  it('refuses an emoji outside the set and anything that is not a single emoji of it', () => {
    expect(reactionEmoji.safeParse('🔥').success).toBe(false);
    expect(reactionEmoji.safeParse('👍👍').success).toBe(false);
    expect(reactionEmoji.safeParse('').success).toBe(false);
    expect(reactionEmoji.safeParse('thumbsup').success).toBe(false);
  });
});
