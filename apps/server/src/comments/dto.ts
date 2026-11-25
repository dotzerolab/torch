// What a comment looks like to a client over REST. A deleted comment keeps its place and its author but no text.
import type { CommentRow } from '@torch/shared/db/schema';

export type CommentDto = {
  id: string;
  issueId: string;
  parentId: string | null;
  authorId: string;
  body: string;
  reactions: Record<string, string[]>;
  createdAt: string;
  editedAt: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  deleted: boolean;
};

export type CommentEditDto = { id: string; body: string; editedBy: string; createdAt: string };

export function toCommentDto(row: CommentRow): CommentDto {
  const deleted = row.deletedAt !== null;
  return {
    id: row.id,
    issueId: row.issueId,
    parentId: row.parentId,
    authorId: row.authorId,
    body: deleted ? '' : row.body,
    reactions: deleted ? {} : row.reactions,
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt?.toISOString() ?? null,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolvedBy: row.resolvedBy,
    deleted,
  };
}
