import { describe, expect, it } from 'vitest';
import { DEFAULT_DISPLAY, PROPERTY_IDS, viewDisplaySchema, viewFilterSchema } from './views.ts';

const GUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('view filter', () => {
  it('accepts every field, with the people shortcuts', () => {
    const filter = {
      state: [GUID],
      stateType: ['started', 'completed'],
      assignee: [GUID, 'me', 'none'],
      creator: ['me'],
      priority: [0, 1, 4],
      label: [GUID],
      due: ['overdue', 'week', 'none'],
      text: 'login',
    };
    expect(viewFilterSchema.parse(filter)).toEqual(filter);
  });

  it('is strict: an unknown key is an error', () => {
    expect(viewFilterSchema.safeParse({ colour: 'red' }).success).toBe(false);
  });

  it('refuses ids that are not guids, and shortcuts where they do not belong', () => {
    expect(viewFilterSchema.safeParse({ state: ['zzz'] }).success).toBe(false);
    expect(viewFilterSchema.safeParse({ label: ['me'] }).success).toBe(false);
    expect(viewFilterSchema.safeParse({ creator: ['none'] }).success).toBe(false);
    expect(viewFilterSchema.safeParse({ priority: [5] }).success).toBe(false);
    expect(viewFilterSchema.safeParse({ due: ['tomorrow'] }).success).toBe(false);
    expect(viewFilterSchema.safeParse({ stateType: ['done'] }).success).toBe(false);
  });

  it('stores ids in lower case, and trims the text', () => {
    expect(viewFilterSchema.parse({ state: [GUID.toUpperCase()], text: '  bug ' })).toEqual({
      state: [GUID],
      text: 'bug',
    });
  });
});

describe('view display', () => {
  it('the default is a list grouped by state in manual order', () => {
    expect(viewDisplaySchema.parse(DEFAULT_DISPLAY)).toEqual(DEFAULT_DISPLAY);
    expect(DEFAULT_DISPLAY).toMatchObject({
      layout: 'list',
      group: 'state',
      order: 'manual',
      direction: 'asc',
      subIssues: true,
      showEmptyGroups: false,
      showArchived: false,
    });
    expect(DEFAULT_DISPLAY.properties).toEqual([
      'priority',
      'identifier',
      'state',
      'labels',
      'due',
      'assignee',
    ]);
  });

  it('knows the eight properties', () => {
    expect([...PROPERTY_IDS]).toEqual([
      'priority',
      'identifier',
      'state',
      'labels',
      'due',
      'estimate',
      'assignee',
      'updated',
    ]);
  });

  it('refuses a layout, grouping or property it does not offer (group by label is not one)', () => {
    expect(viewDisplaySchema.safeParse({ ...DEFAULT_DISPLAY, group: 'label' }).success).toBe(false);
    expect(viewDisplaySchema.safeParse({ ...DEFAULT_DISPLAY, layout: 'timeline' }).success).toBe(
      false,
    );
    expect(viewDisplaySchema.safeParse({ ...DEFAULT_DISPLAY, properties: ['mood'] }).success).toBe(
      false,
    );
    expect(viewDisplaySchema.safeParse({ ...DEFAULT_DISPLAY, extra: 1 }).success).toBe(false);
  });
});
