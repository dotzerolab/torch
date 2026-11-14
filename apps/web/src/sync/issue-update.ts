// From the columns TanStack DB says changed to the update body of PATCH /api/w/:workspaceId/issues/:issueId.
// No browser or TanStack imports, so it is unit-testable.
import { type IssueUpdateInput, issueUpdateInput } from '@torch/shared/mutations/issue';
import { ApiError } from '../api.ts';

/** Only the columns the mutation lets a client change are mapped; everything else in `changes` is dropped. */
export function toIssueUpdate(changes: Record<string, unknown>): IssueUpdateInput {
  const body: Record<string, unknown> = {};
  if ('title' in changes) body.title = changes.title;
  if ('priority' in changes) body.priority = changes.priority;
  if ('state_id' in changes) body.stateId = changes.state_id;
  if ('assignee_id' in changes) body.assigneeId = changes.assignee_id;

  const parsed = issueUpdateInput.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(
      400,
      'invalid_input',
      parsed.error.issues[0]?.message ?? 'The change is not valid.',
    );
  }
  return parsed.data;
}
