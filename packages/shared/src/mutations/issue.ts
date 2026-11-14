// The first mutation contract (ADR 0001 section 1): what a client may send to update an issue and which refusals
// the server can answer. Shared so the web validates before sending and the server validates what arrives.
// No Node imports: this file reaches the browser bundle.
import { z } from 'zod';

/**
 * Per-field update of one issue. Strict on purpose: `description`, `teamId`, `workspaceId`, `number`, `creatorId`
 * and every other column are not updatable here, and an unknown key is an error, not silently ignored. A field
 * that is absent stays as it is (per-field last-writer-wins, spec §14); `assigneeId: null` un-assigns.
 */
export const issueUpdateInput = z
  .strictObject({
    title: z.string().trim().min(1).max(255).optional(),
    priority: z.number().int().min(0).max(4).optional(),
    stateId: z.guid().optional(),
    assigneeId: z.guid().nullable().optional(),
  })
  .refine((input) => Object.values(input).some((value) => value !== undefined), {
    message: 'at least one field is required',
  });

export type IssueUpdateInput = z.infer<typeof issueUpdateInput>;

/**
 * The refusals of a mutation. All are 4xx: the client rolls back the optimistic change and shows a message;
 * only network errors are retried.
 */
export type MutationErrorCode =
  | 'unauthenticated'
  | 'not_found'
  | 'forbidden'
  | 'invalid_input'
  | 'invalid_state'
  | 'invalid_assignee';
