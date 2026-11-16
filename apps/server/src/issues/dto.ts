// The issue as the REST API returns it: dates are ISO strings, the identifier is `<TEAMKEY>-<number>`, and the
// description (large text) is only there when asked for.
import type { IssueRow } from '@torch/shared/db/schema';

export type ExternalRefDto = { source: string; id: string; url: string | null };

export type IssueDto = {
  id: string;
  identifier: string;
  number: number;
  teamId: string;
  title: string;
  /** Present on create and with `include=description`; never in a list otherwise. */
  description?: string;
  stateId: string;
  priority: number;
  estimate: number | null;
  assigneeId: string | null;
  creatorId: string;
  parentId: string | null;
  dueDate: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  canceledAt: string | null;
  archivedAt: string | null;
  labelIds: string[];
  externalRefs: ExternalRefDto[];
};

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

export function toIssueDto(
  row: IssueRow,
  context: {
    teamKey: string;
    labelIds: string[];
    externalRefs: ExternalRefDto[];
    includeDescription: boolean;
  },
): IssueDto {
  return {
    id: row.id,
    identifier: `${context.teamKey}-${row.number}`,
    number: row.number,
    teamId: row.teamId,
    title: row.title,
    ...(context.includeDescription ? { description: row.description } : {}),
    stateId: row.stateId,
    priority: row.priority,
    estimate: row.estimate,
    assigneeId: row.assigneeId,
    creatorId: row.creatorId,
    parentId: row.parentId,
    dueDate: row.dueDate,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    startedAt: iso(row.startedAt),
    completedAt: iso(row.completedAt),
    canceledAt: iso(row.canceledAt),
    archivedAt: iso(row.archivedAt),
    labelIds: context.labelIds,
    externalRefs: context.externalRefs,
  };
}
