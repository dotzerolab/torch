// Changing an issue from a screen. Scalar fields go through the issues collection (the change shows at once and a refusal
// rolls it back); labels have no column on the issue, so a label edit goes through the outbox and the label snapshot is
// read again once the server has it. Either way a refusal rejects with the server's code (`mutationErrorMessage`).
import { type IssueUpdateInput, issueUpdateInput } from '@torch/shared/mutations/issue';
import { ApiError } from '../api.ts';
import type { SyncedIssue } from '../sync/collections.ts';
import { enqueueWrite, type OutboxWrite } from '../sync/outbox.ts';
import { snapshotWatch } from '../sync/snapshot-hooks.ts';
import { recentLabelEdits } from './model/pending.ts';

/** What `updateIssue` needs of the issues collection: an optimistic update that settles or fails. */
export type IssuesCollection = {
  update(
    key: string,
    change: (draft: SyncedIssue) => void,
  ): { when(state: 'settled'): Promise<unknown> };
};

export type UpdateDeps = {
  enqueue: (write: OutboxWrite) => Promise<{ txid: number }>;
  /** The labels of the issue changed on the server: read them again. */
  refreshLabels: (workspaceId: string, teamId: string) => void;
  /** The server accepted a label edit that the label snapshot does not show yet: keep it visible until it does. */
  confirmLabels: (edit: { issueId: string; add: string[]; remove: string[] }) => void;
};

const defaultDeps: UpdateDeps = {
  enqueue: enqueueWrite,
  refreshLabels: (workspaceId, teamId) =>
    snapshotWatch.ownWrite({ workspaceId, teamId, kinds: ['issueLabels'] }),
  confirmLabels: (edit) => recentLabelEdits.add(edit),
};

/** The columns of the row a scalar field of the update changes. */
function applyScalars(draft: SyncedIssue, patch: IssueUpdateInput) {
  if (patch.title !== undefined) draft.title = patch.title;
  if (patch.priority !== undefined) draft.priority = patch.priority;
  if (patch.stateId !== undefined) draft.state_id = patch.stateId;
  if (patch.assigneeId !== undefined) draft.assignee_id = patch.assigneeId;
  if (patch.estimate !== undefined) draft.estimate = patch.estimate;
  if (patch.dueDate !== undefined) draft.due_date = patch.dueDate;
  if (patch.parentId !== undefined) draft.parent_id = patch.parentId;
  if (patch.sortOrder !== undefined) draft.sort_order = patch.sortOrder;
}

export async function updateIssue(
  issues: IssuesCollection,
  issue: Pick<SyncedIssue, 'id' | 'workspace_id' | 'team_id'>,
  patch: IssueUpdateInput,
  deps: UpdateDeps = defaultDeps,
): Promise<void> {
  const parsed = issueUpdateInput.safeParse(patch);
  if (!parsed.success) {
    throw new ApiError(
      400,
      'invalid_input',
      parsed.error.issues[0]?.message ?? 'The change is not valid.',
    );
  }
  const { addLabelIds, removeLabelIds, ...scalars } = parsed.data;
  const jobs: Promise<unknown>[] = [];

  if (Object.values(scalars).some((value) => value !== undefined)) {
    const transaction = issues.update(issue.id, (draft) => applyScalars(draft, scalars));
    jobs.push(transaction.when('settled'));
  }
  if (addLabelIds?.length || removeLabelIds?.length) {
    jobs.push(
      deps
        .enqueue({
          workspaceId: issue.workspace_id,
          teamId: issue.team_id,
          method: 'PATCH',
          path: `/api/w/${issue.workspace_id}/issues/${issue.id}`,
          body: { addLabelIds, removeLabelIds },
          idempotencyKey: crypto.randomUUID(),
        })
        .then(() => {
          deps.confirmLabels({
            issueId: issue.id,
            add: addLabelIds ?? [],
            remove: removeLabelIds ?? [],
          });
          deps.refreshLabels(issue.workspace_id, issue.team_id);
        }),
    );
  }
  await Promise.all(jobs);
}

// ---- writes of the issue panel: they go through the outbox (they survive a reload and replay with their key) ----

type SnapshotKind = 'issueDetail' | 'issueSubscribers';

export type DetailDeps = {
  enqueue: (write: OutboxWrite) => Promise<{ txid: number }>;
  /** Read the held snapshots of these kinds again: the write changed what they hold. */
  refresh: (workspaceId: string, teamId: string, kinds: SnapshotKind[]) => void;
};

const detailDeps: DetailDeps = {
  enqueue: enqueueWrite,
  refresh: (workspaceId, teamId, kinds) => snapshotWatch.ownWrite({ workspaceId, teamId, kinds }),
};

type IssueRef = Pick<SyncedIssue, 'id' | 'workspace_id' | 'team_id'>;

const issuePath = (issue: IssueRef) => `/api/w/${issue.workspace_id}/issues/${issue.id}`;

/** The description is not in the list shape: it is a PATCH, and the opened issue's snapshot is read again. */
export async function saveDescription(
  issue: IssueRef,
  description: string,
  deps: DetailDeps = detailDeps,
): Promise<void> {
  await deps.enqueue({
    workspaceId: issue.workspace_id,
    teamId: issue.team_id,
    method: 'PATCH',
    path: issuePath(issue),
    body: { description },
    idempotencyKey: crypto.randomUUID(),
  });
  deps.refresh(issue.workspace_id, issue.team_id, ['issueDetail']);
}

export async function setSubscribed(
  issue: IssueRef,
  memberId: string,
  subscribed: boolean,
  deps: DetailDeps = detailDeps,
): Promise<void> {
  await deps.enqueue({
    workspaceId: issue.workspace_id,
    teamId: issue.team_id,
    method: subscribed ? 'PUT' : 'DELETE',
    path: `${issuePath(issue)}/subscribers/${memberId}`,
    idempotencyKey: crypto.randomUUID(),
  });
  deps.refresh(issue.workspace_id, issue.team_id, ['issueSubscribers']);
}

/** The issues shape carries `archived_at` back by itself; nothing else needs reading again. */
export async function setArchived(
  issue: IssueRef,
  archived: boolean,
  deps: Pick<DetailDeps, 'enqueue'> = detailDeps,
): Promise<void> {
  await deps.enqueue({
    workspaceId: issue.workspace_id,
    teamId: issue.team_id,
    method: 'POST',
    path: `${issuePath(issue)}/${archived ? 'archive' : 'unarchive'}`,
    idempotencyKey: crypto.randomUUID(),
  });
}
