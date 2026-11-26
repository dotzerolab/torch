// What a view of issues is made of: the filter (which issues) and the display options (how they are laid out). One
// contract for the web (URL, local settings) and the server (saved views), so what one writes the other reads back.
// No Node imports: this file reaches the browser bundle.
import { z } from 'zod';
import { WORKFLOW_STATE_TYPES, type WorkflowStateType } from './db/enums.ts';

/** The workflow state types, in the order a board and a grouped list show them. */
export const VIEW_STATE_TYPES: readonly WorkflowStateType[] = WORKFLOW_STATE_TYPES;

/** An id from a URL or a request: any case is accepted, the stored lower-case form is what the code compares. */
const id = z.guid().toLowerCase();

const people = (shortcuts: readonly [string, ...string[]]) => z.union([z.enum(shortcuts), id]);

export const DUE_FILTERS = ['overdue', 'week', 'none'] as const;
export type DueFilter = (typeof DUE_FILTERS)[number];

/** The longest text a filter searches for, in characters. */
export const MAX_FILTER_TEXT_LENGTH = 200;

/**
 * Which issues a view shows. A value inside one field is an OR, fields are an AND. `me` stands for the person who opens
 * the view; `none` for an issue with no assignee. Strict: an unknown key is an error.
 */
export const viewFilterSchema = z.strictObject({
  state: z.array(id).max(100).optional(),
  stateType: z.array(z.enum(WORKFLOW_STATE_TYPES)).max(6).optional(),
  assignee: z
    .array(people(['me', 'none']))
    .max(100)
    .optional(),
  creator: z
    .array(people(['me']))
    .max(100)
    .optional(),
  priority: z.array(z.number().int().min(0).max(4)).max(5).optional(),
  label: z.array(id).max(100).optional(),
  due: z.array(z.enum(DUE_FILTERS)).max(3).optional(),
  text: z.string().trim().max(MAX_FILTER_TEXT_LENGTH).optional(),
});

export type ViewFilter = {
  state?: string[];
  stateType?: WorkflowStateType[];
  assignee?: (string | 'me' | 'none')[];
  creator?: (string | 'me')[];
  priority?: number[];
  label?: string[];
  due?: DueFilter[];
  text?: string;
};

/** The properties a row or a card can show, in the order the display menu lists them. */
export const PROPERTY_IDS = [
  'priority',
  'identifier',
  'state',
  'labels',
  'due',
  'estimate',
  'assignee',
  'updated',
] as const;
export type PropertyId = (typeof PROPERTY_IDS)[number];

export const LAYOUTS = ['list', 'board'] as const;
/** Group by label is not offered: an issue with two labels would appear twice. */
export const GROUPS = ['state', 'stateType', 'assignee', 'priority', 'team', 'none'] as const;
export const ORDERS = [
  'manual',
  'priority',
  'updated',
  'created',
  'due',
  'title',
  'estimate',
] as const;

export const viewDisplaySchema = z.strictObject({
  layout: z.enum(LAYOUTS),
  group: z.enum(GROUPS),
  order: z.enum(ORDERS),
  direction: z.enum(['asc', 'desc']),
  /** false hides an issue whose parent is in the same list (it shows under the parent). */
  subIssues: z.boolean(),
  properties: z.array(z.enum(PROPERTY_IDS)).max(PROPERTY_IDS.length),
  showEmptyGroups: z.boolean(),
  showArchived: z.boolean(),
});

export type ViewDisplay = {
  layout: (typeof LAYOUTS)[number];
  group: (typeof GROUPS)[number];
  order: (typeof ORDERS)[number];
  direction: 'asc' | 'desc';
  subIssues: boolean;
  properties: PropertyId[];
  showEmptyGroups: boolean;
  showArchived: boolean;
};

/** What a team opens with when nothing else was chosen: a list grouped by state, in the order people put it in. */
export const DEFAULT_DISPLAY: ViewDisplay = {
  layout: 'list',
  group: 'state',
  order: 'manual',
  direction: 'asc',
  subIssues: true,
  properties: ['priority', 'identifier', 'state', 'labels', 'due', 'assignee'],
  showEmptyGroups: false,
  showArchived: false,
};
