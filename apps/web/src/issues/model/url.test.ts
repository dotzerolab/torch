import { DEFAULT_DISPLAY, type ViewDisplay, type ViewFilter } from '@torch/shared/views';
import { describe, expect, it } from 'vitest';
import { decodeView, encodeView } from './url.ts';

const G1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const G2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('view URL codec', () => {
  it('encode/decode roundtrip, every field', () => {
    const filter: ViewFilter = {
      state: [G1, G2],
      stateType: ['started', 'completed'],
      assignee: ['me', 'none', G1],
      creator: ['me', G2],
      priority: [0, 1, 4],
      label: [G2],
      due: ['overdue', 'week', 'none'],
      text: 'login & logout, "quoted" ü',
    };
    const display: Partial<ViewDisplay> = {
      layout: 'board',
      group: 'assignee',
      order: 'updated',
      direction: 'desc',
      subIssues: false,
      properties: ['state', 'estimate'],
      showEmptyGroups: true,
      showArchived: true,
    };
    const params = encodeView(filter, display);
    expect(decodeView(new URLSearchParams(params.toString()))).toEqual({ filter, display });
  });

  it('writes nothing for an empty filter and no display options', () => {
    expect(encodeView({}, {}).toString()).toBe('');
    expect(decodeView(new URLSearchParams())).toEqual({ filter: {}, display: {} });
  });

  it('leaves out an empty filter list and a blank text, but keeps an empty property list (show none)', () => {
    const params = encodeView({ state: [], text: '   ' }, { properties: [] });
    expect(params.toString()).toBe('props=');
    expect(decodeView(new URLSearchParams(params.toString()))).toEqual({
      filter: {},
      display: { properties: [] },
    });
  });

  it('decode ignores garbage', () => {
    expect(decodeView(new URLSearchParams('?state=zzz&order=nope&x=1'))).toEqual({
      filter: {},
      display: {},
    });
  });

  it('keeps the good values of a list and drops the bad ones, without repeats', () => {
    const decoded = decodeView(
      new URLSearchParams(`state=${G1},nope,${G1.toUpperCase()}&priority=1,9,x,1,2&due=week,soon`),
    );
    expect(decoded.filter).toEqual({ state: [G1], priority: [1, 2], due: ['week'] });
  });

  it('a boolean is read from 0 and 1 only', () => {
    expect(decodeView(new URLSearchParams('sub=0&empty=1&archived=true')).display).toEqual({
      subIssues: false,
      showEmptyGroups: true,
    });
  });

  it('properties keep their order and drop the unknown ones', () => {
    expect(decodeView(new URLSearchParams('props=updated,mood,priority')).display).toEqual({
      properties: ['updated', 'priority'],
    });
  });

  it('writes what it is given, so an explicit default is not mistaken for "nothing chosen"', () => {
    const params = encodeView({}, DEFAULT_DISPLAY);
    expect(params.get('layout')).toBe('list');
    expect(decodeView(new URLSearchParams(params.toString()))).toEqual({
      filter: {},
      display: DEFAULT_DISPLAY,
    });
  });
});
