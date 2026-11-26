import { t } from '@torch/shared/i18n';
import { describe, expect, it } from 'vitest';
import type { SyncedActivity, SyncedIssueRelation } from '../../sync/collections.ts';
import { makeRow, STATES } from '../testing.ts';
import {
  ACTIVITY_KEYS,
  type ActivityLookup,
  describeActivity,
  relationsOf,
  subIssueProgress,
} from './detail.ts';

const rel = (type: string, from: string, to: string): SyncedIssueRelation => ({
  id: `${type}-${from}-${to}`,
  workspace_id: 'w',
  issue_id: from,
  related_issue_id: to,
  type,
  created_by: 'me',
  created_at: '2026-11-01T00:00:00Z',
});

describe('relationsOf', () => {
  it('reads each relation from the end of the issue', () => {
    const rows = [rel('blocks', 'a', 'b'), rel('related', 'b', 'c'), rel('duplicate', 'c', 'a')];
    expect(relationsOf(rows, 'a')).toEqual([
      { id: 'blocks-a-b', kind: 'blocks', otherId: 'b' },
      { id: 'duplicate-c-a', kind: 'duplicated_by', otherId: 'c' },
    ]);
    expect(relationsOf(rows, 'b')).toEqual([
      { id: 'blocks-a-b', kind: 'blocked_by', otherId: 'a' },
      { id: 'related-b-c', kind: 'related', otherId: 'c' },
    ]);
    expect(relationsOf(rows, 'c')).toEqual([
      { id: 'related-b-c', kind: 'related', otherId: 'b' },
      { id: 'duplicate-c-a', kind: 'duplicate', otherId: 'a' },
    ]);
  });

  it('skips a type it does not know', () => {
    expect(relationsOf([rel('mystery', 'a', 'b')], 'a')).toEqual([]);
  });
});

describe('subIssueProgress', () => {
  const states = new Map(STATES.map((state) => [state.id, state]));
  it('counts the completed sub-issues out of all of them', () => {
    const rows = [
      makeRow(1),
      makeRow(2, { parent_id: 'i1', state_id: 's3' }),
      makeRow(3, { parent_id: 'i1', state_id: 's1' }),
      makeRow(4, { parent_id: 'i1', state_id: 's3' }),
      makeRow(5, { parent_id: 'i9', state_id: 's3' }),
    ];
    const { children, done } = subIssueProgress(rows, 'i1', states);
    expect(children.map((row) => row.id)).toEqual(['i2', 'i3', 'i4']);
    expect(done).toBe(2);
  });
});

const lookup: ActivityLookup = {
  member: (id) => ({ m1: 'Ada' })[id],
  state: (id) => ({ s1: 'Todo' })[id],
  label: (id) => ({ l1: 'Bug' })[id],
  priority: (value) => `P${value}`,
  none: 'none',
  someone: 'someone',
};
const entry = (type: string, extra: Partial<SyncedActivity> = {}) => ({
  type,
  actor_id: 'm1',
  field: null,
  from_value: null,
  to_value: null,
  ...extra,
});
const describe1 = (row: ReturnType<typeof entry>) => describeActivity(row, lookup, (key) => key);

describe('describeActivity', () => {
  it('names the actor, and says someone for one it does not know', () => {
    expect(describe1(entry('issue.created')).vars.actor).toBe('Ada');
    expect(describe1(entry('issue.created', { actor_id: 'gone' })).vars.actor).toBe('someone');
    expect(describe1(entry('issue.created', { actor_id: null })).vars.actor).toBe('someone');
  });

  it('a field change names the field and both values', () => {
    expect(
      describe1(
        entry('issue.field_changed', { field: 'stateId', from_value: 's1', to_value: 'sx' }),
      ),
    ).toEqual({
      key: 'issue.activity.field_changed',
      vars: { actor: 'Ada', field: 'state', from: 'Todo', to: 'none' },
    });
    expect(
      describe1(entry('issue.field_changed', { field: 'priority', from_value: 0, to_value: 2 }))
        .vars,
    ).toMatchObject({ from: 'none', to: 'P2' });
  });

  it('a description change shows no text', () => {
    expect(
      describe1(
        entry('issue.field_changed', {
          field: 'description',
          from_value: 'secret',
          to_value: 'more',
        }),
      ),
    ).toEqual({ key: 'issue.activity.description', vars: { actor: 'Ada' } });
  });

  it('a label line names the label that was added or removed', () => {
    expect(describe1(entry('issue.label_added', { to_value: 'l1' })).vars.label).toBe('Bug');
    expect(describe1(entry('issue.label_removed', { from_value: 'zz' })).vars.label).toBe('none');
  });

  it('an unknown type or field is a plain "updated"', () => {
    expect(describe1(entry('issue.mystery')).key).toBe('issue.activity.unknown');
    expect(describe1(entry('issue.field_changed', { field: 'sortOrder' })).key).toBe(
      'issue.activity.unknown',
    );
  });

  it('every sentence exists in English and Italian', () => {
    const vars = { actor: 'A', label: 'L', field: 'F', from: 'X', to: 'Y' };
    for (const key of ACTIVITY_KEYS) {
      for (const locale of ['en', 'it'] as const) {
        const text = t(locale, `issue.activity.${key}`, vars);
        expect(text, `${locale} ${key}`).not.toBe(`issue.activity.${key}`);
        expect(text).toContain('A');
      }
    }
  });
});
