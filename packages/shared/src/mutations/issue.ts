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

/** An id from a request: any case is accepted, the stored lower-case form is what the code compares. */
const id = z.guid().toLowerCase();

/** An http or https link (the database refuses every other scheme), at most 2048 characters. */
const httpUrl = z
  .string()
  .max(2048)
  .refine((value) => /^https?:\/\/[^\s/]/.test(value) && URL.canParse(value), {
    message: 'must be an http or https URL',
  });

/** A calendar day, `YYYY-MM-DD`, that exists. */
const calendarDay = z.string().refine(
  (value) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return false;
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const date = new Date(Date.UTC(year, month - 1, day));
    return (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    );
  },
  { message: 'must be a calendar day, YYYY-MM-DD' },
);

/** Where an issue also lives in another system: a lower-case source name, the id there and an optional link. */
export const externalRefInput = z.strictObject({
  source: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  id: z.string().min(1).max(255),
  url: httpUrl.optional(),
});
export type ExternalRefInput = z.infer<typeof externalRefInput>;

/** The longest description a client may send, in characters. */
export const MAX_DESCRIPTION_LENGTH = 100_000;

/**
 * Every field an issue can start with, in one call. Strict: `number`, `creatorId` and the timestamps are the server's,
 * and an unknown key is an error, not silently ignored. `stateId` defaults to the team's first backlog state; a new
 * issue goes to the top of its state unless `sortOrder` says otherwise.
 */
export const issueCreateInput = z.strictObject({
  teamId: id,
  title: z.string().trim().min(1).max(255),
  description: z.string().max(MAX_DESCRIPTION_LENGTH).optional(),
  stateId: id.optional(),
  priority: z.number().int().min(0).max(4).optional(),
  estimate: z.number().int().min(0).max(64).nullable().optional(),
  assigneeId: id.nullable().optional(),
  labelIds: z.array(id).max(50).optional(),
  dueDate: calendarDay.nullable().optional(),
  parentId: id.nullable().optional(),
  subscriberIds: z.array(id).max(100).optional(),
  links: z
    .array(z.strictObject({ url: httpUrl, title: z.string().trim().min(1).max(255).optional() }))
    .max(20)
    .optional(),
  sortOrder: z.number().finite().optional(),
  externalRef: externalRefInput.optional(),
});
export type IssueCreateInput = z.infer<typeof issueCreateInput>;

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
