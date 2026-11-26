// The comment writes of this person that the server has not confirmed in a shape yet. A comment shape is a snapshot, so
// its row arrives some time after the server accepted the write; until then the page shows the change on top of the rows
// it has (an optimistic overlay, in memory only: a reload shows what the server holds, and a queued write is sent again).
import { useSyncExternalStore } from 'react';
import type { SyncedComment } from '../sync/collections.ts';

/** A comment as the thread shows it: the synced row, marked while this person's own write is not confirmed yet. */
export type CommentView = SyncedComment & { pending?: boolean };

export type PendingOp =
  | {
      kind: 'create';
      workspaceId: string;
      teamId: string;
      issueId: string;
      body: string;
      parentId: string | null;
      authorId: string;
      createdAt: string;
      /** The id the server gave the comment, known once it answered: the overlay yields to the real row. */
      serverId?: string;
    }
  | { kind: 'edit'; commentId: string; body: string; at: string }
  | { kind: 'delete'; commentId: string; at: string }
  | { kind: 'resolve'; commentId: string; resolved: boolean; by: string; at: string }
  | { kind: 'react'; commentId: string; emoji: string; memberId: string; on: boolean };

export type PendingEntry = {
  id: number;
  op: PendingOp;
  /** The shape instance that was current when the server answered; the entry ends once another one has settled. */
  doneOn: object | null;
};

/** How long an acknowledged write stays on screen when the refreshed shape never settles (a lost connection). */
export const GIVE_UP_AFTER_MS = 15_000;

const NONE: readonly PendingEntry[] = [];
const byIssue = new Map<string, readonly PendingEntry[]>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();
let counter = 0;

function set(issueId: string, entries: readonly PendingEntry[]) {
  if (entries.length === 0) byIssue.delete(issueId);
  else byIssue.set(issueId, entries);
  for (const listener of [...listeners]) listener();
}

export const pendingFor = (issueId: string): readonly PendingEntry[] =>
  byIssue.get(issueId) ?? NONE;

export function addPending(issueId: string, op: PendingOp): number {
  counter += 1;
  set(issueId, [...pendingFor(issueId), { id: counter, op, doneOn: null }]);
  return counter;
}

export function removePending(issueId: string, id: number) {
  clearTimeout(timers.get(id));
  timers.delete(id);
  if (pendingFor(issueId).some((entry) => entry.id === id)) {
    set(
      issueId,
      pendingFor(issueId).filter((entry) => entry.id !== id),
    );
  }
}

/** The server answered: the entry stays until a shape instance newer than `instance` has settled (or `giveUpMs`). */
export function markDone(
  issueId: string,
  id: number,
  instance: object,
  patch: { serverId?: string } = {},
  giveUpMs = GIVE_UP_AFTER_MS,
) {
  set(
    issueId,
    pendingFor(issueId).map((entry) =>
      entry.id === id
        ? {
            ...entry,
            doneOn: instance,
            op: entry.op.kind === 'create' ? { ...entry.op, ...patch } : entry.op,
          }
        : entry,
    ),
  );
  clearTimeout(timers.get(id));
  timers.set(
    id,
    setTimeout(() => removePending(issueId, id), giveUpMs),
  );
}

/** A shape instance has settled: every acknowledged write that was made against an older one is now in its rows. */
export function settlePending(issueId: string, instance: object) {
  const done = pendingFor(issueId).filter(
    (entry) => entry.doneOn !== null && entry.doneOn !== instance,
  );
  for (const entry of done) removePending(issueId, entry.id);
}

export function usePending(issueId: string): readonly PendingEntry[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => pendingFor(issueId),
  );
}

export function resetPendingForTests() {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  byIssue.clear();
  counter = 0;
}

/** The rows with this person's unconfirmed writes laid over them. A write the rows already show changes nothing. */
export function applyPending(
  rows: readonly SyncedComment[],
  pending: readonly PendingEntry[],
): CommentView[] {
  let out: CommentView[] = [...rows];
  for (const { id, op } of pending) {
    switch (op.kind) {
      case 'create': {
        if (op.serverId && out.some((row) => row.id === op.serverId)) break;
        out.push({
          id: `pending:${id}`,
          workspace_id: op.workspaceId,
          team_id: op.teamId,
          issue_id: op.issueId,
          parent_id: op.parentId,
          author_id: op.authorId,
          body: op.body,
          reactions: {},
          created_at: op.createdAt,
          edited_at: null,
          resolved_at: null,
          resolved_by: null,
          deleted_at: null,
          pending: true,
        });
        break;
      }
      case 'edit':
        out = out.map((row) =>
          row.id === op.commentId
            ? { ...row, body: op.body, edited_at: row.edited_at ?? op.at, pending: true }
            : row,
        );
        break;
      case 'delete':
        out = out.map((row) =>
          row.id === op.commentId
            ? { ...row, body: '', reactions: {}, deleted_at: op.at, pending: true }
            : row,
        );
        break;
      case 'resolve':
        out = out.map((row) =>
          row.id === op.commentId
            ? {
                ...row,
                resolved_at: op.resolved ? op.at : null,
                resolved_by: op.resolved ? op.by : null,
                pending: true,
              }
            : row,
        );
        break;
      case 'react':
        out = out.map((row) => {
          if (row.id !== op.commentId) return row;
          const people = new Set(row.reactions[op.emoji] ?? []);
          if (op.on) people.add(op.memberId);
          else people.delete(op.memberId);
          const reactions = { ...row.reactions };
          if (people.size === 0) delete reactions[op.emoji];
          else reactions[op.emoji] = [...people];
          return { ...row, reactions, pending: true };
        });
        break;
    }
  }
  return out;
}
