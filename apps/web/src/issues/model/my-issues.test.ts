import { DEFAULT_DISPLAY } from '@torch/shared/views';
import { describe, expect, it } from 'vitest';
import { makeRow } from '../testing.ts';
import { MY_ISSUES_DISPLAY, rowsOfTab, tabOf, withTab } from './my-issues.ts';

describe('tabOf', () => {
  it('is Assigned by default and Created for ?tab=created; anything else is Assigned', () => {
    expect(tabOf('')).toBe('assigned');
    expect(tabOf('?tab=created')).toBe('created');
    expect(tabOf('?tab=assigned')).toBe('assigned');
    expect(tabOf('?tab=nope')).toBe('assigned');
    expect(tabOf('?peek=ENG-1&tab=created&group=team')).toBe('created');
  });
});

describe('withTab', () => {
  it('writes the tab and leaves every other parameter alone; Assigned, the default, is the absence', () => {
    expect(withTab('?group=team&state=x', 'created')).toBe('?group=team&state=x&tab=created');
    expect(withTab('?tab=created&group=team', 'assigned')).toBe('?group=team');
    expect(withTab('', 'assigned')).toBe('');
    expect(withTab('?tab=created', 'created')).toBe('?tab=created');
  });
});

describe('rowsOfTab', () => {
  const rows = [
    makeRow(1, { assignee_id: 'me', creator_id: 'other' }),
    makeRow(2, { assignee_id: 'other', creator_id: 'me' }),
    makeRow(3, { assignee_id: 'me', creator_id: 'me' }),
    makeRow(4, { assignee_id: null, creator_id: 'other' }),
  ];

  it('Assigned holds the issues assigned to the person, Created the ones they made, both when both', () => {
    expect(rowsOfTab(rows, 'assigned', 'me').map((row) => row.id)).toEqual(['i1', 'i3']);
    expect(rowsOfTab(rows, 'created', 'me').map((row) => row.id)).toEqual(['i2', 'i3']);
  });

  it('an issue of nobody the person is does not show on either tab', () => {
    expect(rowsOfTab(rows, 'assigned', 'ghost')).toEqual([]);
    expect(rowsOfTab(rows, 'created', 'ghost')).toEqual([]);
  });
});

describe('MY_ISSUES_DISPLAY', () => {
  it('groups by state type, and is the default display otherwise', () => {
    expect(MY_ISSUES_DISPLAY).toEqual({ ...DEFAULT_DISPLAY, group: 'stateType' });
  });
});
