import { describe, expect, it } from 'vitest';
import type { SyncedIssue, SyncedIssueLabel } from '../../sync/collections.ts';
import { buildRows, identifierOf } from './row-model.ts';

const issue = (id: string, extra: Partial<SyncedIssue> = {}): SyncedIssue => ({
  id,
  workspace_id: 'w',
  team_id: 't1',
  number: 12,
  title: id,
  state_id: 's',
  priority: 0,
  assignee_id: null,
  creator_id: 'm',
  created_at: '2026-11-01T00:00:00Z',
  updated_at: '2026-11-01T00:00:00Z',
  archived_at: null,
  estimate: null,
  due_date: null,
  parent_id: null,
  sort_order: 0,
  started_at: null,
  completed_at: null,
  canceled_at: null,
  ...extra,
});
const link = (issue_id: string, label_id: string): SyncedIssueLabel => ({
  workspace_id: 'w',
  team_id: 't1',
  issue_id,
  label_id,
});

describe('row model', () => {
  it('names an issue by its team key and number', () => {
    expect(identifierOf('ENG', 12)).toBe('ENG-12');
    expect(identifierOf('ENG', 0)).toBe('');
    expect(identifierOf(undefined, 12)).toBe('');
  });

  it('gives each issue its labels, its identifier and whether it is still queued', () => {
    const rows = buildRows(
      [issue('a'), issue('b', { team_id: 't2', number: 3 })],
      [link('a', 'l1'), link('a', 'l2'), link('zzz', 'l9')],
      new Map([
        ['t1', 'ENG'],
        ['t2', 'OPS'],
      ]),
      new Set(['b']),
    );
    expect(rows).toEqual([
      { id: 'a', issue: issue('a'), identifier: 'ENG-12', labelIds: ['l1', 'l2'], pending: false },
      {
        id: 'b',
        issue: issue('b', { team_id: 't2', number: 3 }),
        identifier: 'OPS-3',
        labelIds: [],
        pending: true,
      },
    ]);
  });

  it('an issue of a team this person has no key for has no identifier, never an invented one', () => {
    const [row] = buildRows([issue('a', { team_id: 'gone' })], [], new Map());
    expect(row?.identifier).toBe('');
  });

  it('keeps the order of the issues it is given', () => {
    const rows = buildRows([issue('c'), issue('a'), issue('b')], [], new Map([['t1', 'ENG']]));
    expect(rows.map((row) => row.id)).toEqual(['c', 'a', 'b']);
  });
});
