// Plain objects for the tests of the issue screens: a team's states, members and labels, and rows to put in them.
import type {
  SyncedIssue,
  SyncedLabel,
  SyncedMember,
  SyncedWorkflowState,
} from '../sync/collections.ts';
import type { TeamData } from './data.ts';
import type { IssueRow } from './model/engine.ts';

export const STATES: SyncedWorkflowState[] = [
  ['s1', 'Todo', 'unstarted', 1],
  ['s2', 'In Progress', 'started', 2],
  ['s3', 'Done', 'completed', 3],
].map(([id, name, type, position]) => ({
  id: id as string,
  workspace_id: 'w',
  team_id: 't',
  name: name as string,
  type: type as SyncedWorkflowState['type'],
  position: position as number,
  color: '#aaaaaa',
  archived_at: null,
}));

export const MEMBERS: SyncedMember[] = [
  ['me', 'Ada Tester', null],
  ['m2', 'Bo Sample', null],
  ['m3', 'Cy Gone', '2026-01-01T00:00:00Z'],
].map(([id, name, deactivated]) => ({
  id: id as string,
  workspace_id: 'w',
  name: name as string,
  handle: (name as string).toLowerCase().replace(' ', '.'),
  role: 'member' as const,
  locale: 'en' as const,
  deactivated_at: deactivated as string | null,
  created_at: '2026-01-01T00:00:00Z',
}));

export const LABELS: SyncedLabel[] = [
  ['l1', 'Bug', null],
  ['l2', 'Old', '2026-02-01T00:00:00Z'],
].map(([id, name, archived]) => ({
  id: id as string,
  workspace_id: 'w',
  team_id: 't',
  parent_id: null,
  name: name as string,
  color: '#cc0000',
  is_group: false,
  archived_at: archived as string | null,
  created_at: '2026-01-01T00:00:00Z',
}));

export function makeData(extra: Partial<TeamData> = {}): TeamData {
  const members = MEMBERS;
  return {
    states: STATES,
    labels: LABELS.filter((label) => label.archived_at === null),
    members: members.filter((member) => member.deactivated_at === null),
    statesById: new Map(STATES.map((state) => [state.id, state])),
    labelsById: new Map(LABELS.map((label) => [label.id, label])),
    membersById: new Map(members.map((member) => [member.id, member])),
    ready: true,
    statesReady: true,
    ...extra,
  };
}

export function makeRow(
  n: number,
  extra: Partial<SyncedIssue> = {},
  labelIds: string[] = [],
): IssueRow {
  const issue: SyncedIssue = {
    id: `i${n}`,
    workspace_id: 'w',
    team_id: 't',
    number: n,
    title: `Issue ${n}`,
    state_id: n % 2 === 0 ? 's2' : 's1',
    priority: 0,
    assignee_id: null,
    creator_id: 'me',
    created_at: '2026-11-01T00:00:00Z',
    updated_at: '2026-11-01T00:00:00Z',
    archived_at: null,
    estimate: null,
    due_date: null,
    parent_id: null,
    sort_order: n,
    started_at: null,
    completed_at: null,
    canceled_at: null,
    ...extra,
  };
  return { id: issue.id, issue, identifier: `ENG-${n}`, labelIds, pending: false };
}
