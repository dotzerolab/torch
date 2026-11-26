// What the screens show before the server has answered (builder decision 5): the queued writes on this device, from every
// tab, are the source of truth for "not yet confirmed", so what shows survives a reload and does not depend on one tab's
// memory. Label edits are the case: they go through the outbox, not through the issues collection, so no optimistic row
// carries them.
import type { OutboxWrite } from '../../sync/outbox.ts';
import type { IssueRow } from './engine.ts';

export type LabelEdit = { issueId: string; add: string[]; remove: string[] };

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/** The label changes in the queued updates of issues of the workspace, in the order they were queued. */
export function labelEditsFromWrites(
  writes: readonly OutboxWrite[],
  workspaceId: string,
): LabelEdit[] {
  const prefix = `/api/w/${workspaceId}/issues/`;
  const edits: LabelEdit[] = [];
  for (const write of writes) {
    if (write.method !== 'PATCH' || write.workspaceId !== workspaceId) continue;
    if (!write.path.startsWith(prefix)) continue;
    const issueId = write.path.slice(prefix.length);
    if (!issueId || issueId.includes('/')) continue;
    const body = (write.body ?? {}) as { addLabelIds?: unknown; removeLabelIds?: unknown };
    const add = strings(body.addLabelIds);
    const remove = strings(body.removeLabelIds);
    if (add.length === 0 && remove.length === 0) continue;
    edits.push({ issueId, add, remove });
  }
  return edits;
}

/** The rows with the queued label edits applied. A row nothing changes keeps its object, so a list re-renders only what moved. */
export function applyLabelEdits(rows: IssueRow[], edits: readonly LabelEdit[]): IssueRow[] {
  if (edits.length === 0) return rows;
  const byIssue = new Map<string, LabelEdit[]>();
  for (const edit of edits) {
    const list = byIssue.get(edit.issueId);
    if (list) list.push(edit);
    else byIssue.set(edit.issueId, [edit]);
  }
  return rows.map((row) => {
    const mine = byIssue.get(row.id);
    if (!mine) return row;
    let labels = row.labelIds;
    for (const edit of mine) {
      const next = labels.filter((id) => !edit.remove.includes(id));
      for (const id of edit.add) if (!next.includes(id)) next.push(id);
      labels = next;
    }
    const same =
      labels.length === row.labelIds.length && labels.every((id, i) => id === row.labelIds[i]);
    return same ? row : { ...row, labelIds: labels };
  });
}

/**
 * Label edits the server has accepted and the label snapshot has not caught up with yet: they stay visible for a few
 * seconds, so a chip does not vanish between "the write is over" and "the labels were read again".
 */
export function createRecentEdits(ttlMs = 4000, now: () => number = () => Date.now()) {
  let entries: Array<{ edit: LabelEdit; until: number }> = [];
  return {
    add(edit: LabelEdit) {
      entries.push({ edit, until: now() + ttlMs });
    },
    active(): LabelEdit[] {
      const time = now();
      entries = entries.filter((entry) => entry.until > time);
      return entries.map((entry) => entry.edit);
    },
  };
}

export const recentLabelEdits = createRecentEdits();
