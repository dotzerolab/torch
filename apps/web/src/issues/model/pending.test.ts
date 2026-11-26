import { describe, expect, it } from 'vitest';
import type { OutboxWrite } from '../../sync/outbox.ts';
import type { IssueRow } from './engine.ts';
import { applyLabelEdits, createRecentEdits, labelEditsFromWrites } from './pending.ts';

const WS = 'ws1';
const patch = (issueId: string, body: unknown, over: Partial<OutboxWrite> = {}): OutboxWrite => ({
  workspaceId: WS,
  teamId: 't1',
  method: 'PATCH',
  path: `/api/w/${WS}/issues/${issueId}`,
  body,
  idempotencyKey: `k-${issueId}-${Math.random()}`,
  ...over,
});
const row = (id: string, labelIds: string[]): IssueRow =>
  ({ id, issue: { id } as never, identifier: id, labelIds, pending: false }) as IssueRow;

describe('labelEditsFromWrites', () => {
  it('reads the label changes of queued issue updates, in order', () => {
    const edits = labelEditsFromWrites(
      [
        patch('a', { addLabelIds: ['l1'] }),
        patch('a', { removeLabelIds: ['l1'], addLabelIds: ['l2'] }),
        patch('b', { removeLabelIds: ['l9'] }),
      ],
      WS,
    );
    expect(edits).toEqual([
      { issueId: 'a', add: ['l1'], remove: [] },
      { issueId: 'a', add: ['l2'], remove: ['l1'] },
      { issueId: 'b', add: [], remove: ['l9'] },
    ]);
  });

  it('ignores what is not a label edit of an issue of this workspace', () => {
    expect(
      labelEditsFromWrites(
        [
          patch('a', { title: 'x' }),
          patch('a', { addLabelIds: [] }),
          patch('a', { addLabelIds: 'nope' }),
          patch('a', { addLabelIds: ['l1'] }, { method: 'DELETE' }),
          patch('a', { addLabelIds: ['l1'] }, { path: `/api/w/${WS}/teams/t1` }),
          patch('a', { addLabelIds: ['l1'] }, { workspaceId: 'other' }),
          patch('a', undefined),
        ],
        WS,
      ),
    ).toEqual([]);
  });
});

describe('applyLabelEdits', () => {
  it('shows a queued label edit before the server answers', () => {
    const rows = [row('a', ['l1']), row('b', [])];
    const shown = applyLabelEdits(rows, [{ issueId: 'a', add: ['l2'], remove: ['l1'] }]);
    expect(shown.map((r) => r.labelIds)).toEqual([['l2'], []]);
  });

  it('leaves the rows it does not touch as they were (the same objects)', () => {
    const rows = [row('a', ['l1']), row('b', [])];
    const shown = applyLabelEdits(rows, [{ issueId: 'a', add: ['l2'], remove: [] }]);
    expect(shown[1]).toBe(rows[1]);
    expect(shown[0]).not.toBe(rows[0]);
    expect(applyLabelEdits(rows, [])).toBe(rows);
  });

  it('is idempotent: an edit the rows already show changes nothing', () => {
    const rows = [row('a', ['l2'])];
    const shown = applyLabelEdits(rows, [{ issueId: 'a', add: ['l2'], remove: ['l1'] }]);
    expect(shown[0]).toBe(rows[0]);
  });

  it('applies several edits of one issue in the order they were made, without repeats', () => {
    const shown = applyLabelEdits(
      [row('a', [])],
      [
        { issueId: 'a', add: ['l1', 'l2'], remove: [] },
        { issueId: 'a', add: [], remove: ['l1'] },
        { issueId: 'a', add: ['l2'], remove: [] },
      ],
    );
    expect(shown[0]?.labelIds).toEqual(['l2']);
  });

  it('ignores an edit of an issue that is not in the list', () => {
    const rows = [row('a', [])];
    expect(applyLabelEdits(rows, [{ issueId: 'zzz', add: ['l1'], remove: [] }])).toEqual(rows);
  });
});

describe('recent edits', () => {
  it('keeps a confirmed edit visible for a few seconds, until the refreshed labels arrive', () => {
    let time = 1000;
    const recent = createRecentEdits(4000, () => time);
    recent.add({ issueId: 'a', add: ['l1'], remove: [] });
    expect(recent.active()).toEqual([{ issueId: 'a', add: ['l1'], remove: [] }]);
    time += 3999;
    expect(recent.active()).toHaveLength(1);
    time += 1;
    expect(recent.active()).toEqual([]);
  });

  it('keeps the edits in the order they were confirmed', () => {
    const recent = createRecentEdits(4000, () => 0);
    recent.add({ issueId: 'a', add: ['l1'], remove: [] });
    recent.add({ issueId: 'a', add: [], remove: ['l1'] });
    expect(recent.active().map((edit) => edit.remove)).toEqual([[], ['l1']]);
  });
});
