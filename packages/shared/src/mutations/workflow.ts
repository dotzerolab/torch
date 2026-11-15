// What a client may send to administer labels and workflow states. Shared so the web validates before sending and the
// server validates what arrives. No Node imports: this file reaches the browser bundle.
import { z } from 'zod';
import { WORKFLOW_STATE_TYPES } from '../db/enums.ts';

/** An id from a request: any case is accepted, the stored lower-case form is what the code compares. */
const id = z.guid().toLowerCase();
const name = z.string().trim().min(1).max(80);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, { message: 'must be a color like #94a3b8' });
const AT_LEAST_ONE = { message: 'at least one field is required' };
const hasAField = (input: Record<string, unknown>) =>
  Object.values(input).some((value) => value !== undefined);

/**
 * A new label. `teamId` absent or null makes a workspace label; `isGroup` makes a group (a group only groups: it is
 * never put on an issue and has no parent); `parentId` puts the label in a group of the same scope.
 */
export const labelCreateInput = z.strictObject({
  name,
  color,
  teamId: id.nullable().optional(),
  parentId: id.nullable().optional(),
  isGroup: z.boolean().optional(),
});
export type LabelCreateInput = z.infer<typeof labelCreateInput>;

/** Rename, recolor or move a label to another group of its scope (`null` takes it out of its group). */
export const labelUpdateInput = z
  .strictObject({
    name: name.optional(),
    color: color.optional(),
    parentId: id.nullable().optional(),
  })
  .refine(hasAField, AT_LEAST_ONE);
export type LabelUpdateInput = z.infer<typeof labelUpdateInput>;

/** A new state of a team. `type` is fixed for life; `position` defaults to the end of the list. */
export const workflowStateCreateInput = z.strictObject({
  name,
  type: z.enum(WORKFLOW_STATE_TYPES),
  color: color.optional(),
  position: z.number().int().min(0).max(100_000).optional(),
});
export type WorkflowStateCreateInput = z.infer<typeof workflowStateCreateInput>;

export const workflowStateUpdateInput = z
  .strictObject({
    name: name.optional(),
    color: color.optional(),
    position: z.number().int().min(0).max(100_000).optional(),
  })
  .refine(hasAField, AT_LEAST_ONE);
export type WorkflowStateUpdateInput = z.infer<typeof workflowStateUpdateInput>;

/** Archiving a state that still has issues needs the state they move to. */
export const workflowStateArchiveInput = z.strictObject({ moveIssuesTo: id.optional() });
export type WorkflowStateArchiveInput = z.infer<typeof workflowStateArchiveInput>;
