// What is particular to My Issues: the two tabs, and the display it opens on. Pure, so it is tested with plain objects.
import { DEFAULT_DISPLAY, type ViewDisplay } from '@torch/shared/views';
import type { IssueRow } from './engine.ts';

export const MY_TABS = ['assigned', 'created'] as const;
export type MyTab = (typeof MY_TABS)[number];

/** The tab the address names; `assigned` for no tab and for one we do not know. */
export function tabOf(search: string): MyTab {
  const tab = new URLSearchParams(search).get('tab');
  return (MY_TABS as readonly string[]).includes(tab ?? '') ? (tab as MyTab) : 'assigned';
}

/** The query with the tab set. Assigned is the default, so it is the absence of the parameter; the rest is left alone. */
export function withTab(search: string, tab: MyTab): string {
  const params = new URLSearchParams(search);
  if (tab === 'assigned') params.delete('tab');
  else params.set('tab', tab);
  const text = params.toString();
  return text ? `?${text}` : '';
}

/** The rows of one tab: the issues assigned to the person, or the ones they created. An issue can be on both. */
export function rowsOfTab(rows: readonly IssueRow[], tab: MyTab, meId: string): IssueRow[] {
  return rows.filter((row) =>
    tab === 'assigned' ? row.issue.assignee_id === meId : row.issue.creator_id === meId,
  );
}

/** My Issues opens grouped by what kind of state the issue is in: the states of different teams do not line up. */
export const MY_ISSUES_DISPLAY: ViewDisplay = { ...DEFAULT_DISPLAY, group: 'stateType' };
