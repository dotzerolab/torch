// The rows a screen draws: an issue with its labels and its identifier, the shape the view engine works on.
import type { SyncedIssue, SyncedIssueLabel } from '../../sync/collections.ts';
import type { IssueRow } from './engine.ts';

/** `ENG-12`. Empty when the issue has no number yet or the team key is not known: the UI never invents one. */
export function identifierOf(teamKey: string | undefined, number: number): string {
  return teamKey && number > 0 ? `${teamKey}-${number}` : '';
}

/**
 * `teamKeys` maps a team id to its key; `pending` holds the ids of issues queued on this device (builder decision 5).
 * One pass over the issue-label links, so ten thousand issues cost a few milliseconds.
 */
export function buildRows(
  issues: readonly SyncedIssue[],
  links: readonly SyncedIssueLabel[],
  teamKeys: ReadonlyMap<string, string>,
  pending: ReadonlySet<string> = new Set(),
): IssueRow[] {
  const labelsOf = new Map<string, string[]>();
  for (const link of links) {
    const labels = labelsOf.get(link.issue_id);
    if (labels) labels.push(link.label_id);
    else labelsOf.set(link.issue_id, [link.label_id]);
  }
  return issues.map((issue) => ({
    id: issue.id,
    issue,
    identifier: identifierOf(teamKeys.get(issue.team_id), issue.number),
    labelIds: labelsOf.get(issue.id) ?? [],
    pending: pending.has(issue.id),
  }));
}
