// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { DEFAULT_DISPLAY } from '@torch/shared/views';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useViewState } from './useViewState.ts';

const G1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

beforeEach(() => window.history.replaceState({}, '', '/teams/ENG'));
afterEach(() => window.localStorage.clear());

describe('useViewState', () => {
  it('opens on the default view when the address and the device say nothing', () => {
    const { result } = renderHook(() => useViewState('t1'));
    expect(result.current.filter).toEqual({});
    expect(result.current.display).toEqual(DEFAULT_DISPLAY);
  });

  it('adding a state filter updates the address without a new history entry', () => {
    const before = window.history.length;
    const { result } = renderHook(() => useViewState('t1'));
    act(() => result.current.setFilter({ state: [G1] }));
    expect(window.location.search).toBe(`?state=${G1}`);
    expect(result.current.filter).toEqual({ state: [G1] });
    expect(window.history.length).toBe(before);
  });

  it('a garbage query is ignored', () => {
    window.history.replaceState({}, '', '/teams/ENG?state=nope&layout=cube&priority=9&text=');
    const { result } = renderHook(() => useViewState('t1'));
    expect(result.current.filter).toEqual({});
    expect(result.current.display).toEqual(DEFAULT_DISPLAY);
  });

  it('display persists per team across a reload', () => {
    const first = renderHook(() => useViewState('t1'));
    act(() => first.result.current.setDisplay({ ...DEFAULT_DISPLAY, group: 'assignee' }));
    first.unmount();
    // A reload: the address has no display options any more, the device remembers them.
    window.history.replaceState({}, '', '/teams/ENG');
    const reloaded = renderHook(() => useViewState('t1'));
    expect(reloaded.result.current.display.group).toBe('assignee');
    const other = renderHook(() => useViewState('t2'));
    expect(other.result.current.display.group).toBe('state');
  });

  it('the address wins over the device', () => {
    window.localStorage.setItem(
      'view-display:t1',
      JSON.stringify({ ...DEFAULT_DISPLAY, group: 'assignee' }),
    );
    window.history.replaceState({}, '', '/teams/ENG?group=priority');
    const { result } = renderHook(() => useViewState('t1'));
    expect(result.current.display.group).toBe('priority');
  });

  it('going back to the default group is not undone by what the device remembered', () => {
    window.localStorage.setItem(
      'view-display:t1',
      JSON.stringify({ ...DEFAULT_DISPLAY, group: 'assignee' }),
    );
    const { result } = renderHook(() => useViewState('t1'));
    act(() => result.current.setDisplay({ ...DEFAULT_DISPLAY, group: 'state' }));
    expect(result.current.display.group).toBe('state');
    const reloaded = renderHook(() => useViewState('t1'));
    expect(reloaded.result.current.display.group).toBe('state');
  });

  it('keeps the other parameters of the address (the peek)', () => {
    window.history.replaceState({}, '', '/teams/ENG?peek=ENG-4');
    const { result } = renderHook(() => useViewState('t1'));
    act(() => result.current.setFilter({ priority: [1] }));
    expect(new URLSearchParams(window.location.search).get('peek')).toBe('ENG-4');
  });

  it('a storage that throws does not break the view', () => {
    const real = Storage.prototype.getItem;
    Storage.prototype.getItem = () => {
      throw new Error('blocked');
    };
    try {
      const { result } = renderHook(() => useViewState('t1'));
      expect(result.current.display).toEqual(DEFAULT_DISPLAY);
      act(() => result.current.setDisplay({ ...DEFAULT_DISPLAY, group: 'priority' }));
      expect(result.current.display.group).toBe('priority');
    } finally {
      Storage.prototype.getItem = real;
    }
  });

  it('a scope with its own defaults opens on them, and the address says only what differs from them', () => {
    const mine = { ...DEFAULT_DISPLAY, group: 'stateType' as const };
    const { result } = renderHook(() => useViewState('my-issues', mine));
    expect(result.current.display.group).toBe('stateType');

    // The global default is a choice here: without it in the address the screen would come back on its own default.
    act(() => result.current.setDisplay({ ...mine, group: 'state' }));
    expect(window.location.search).toBe('?group=state');
    expect(result.current.display.group).toBe('state');

    act(() => result.current.setDisplay({ ...mine, group: 'stateType' }));
    expect(window.location.search).toBe('');
    expect(result.current.display.group).toBe('stateType');
  });

  it('keeps a parameter it does not own, such as the tab, when the view changes', () => {
    window.history.replaceState({}, '', '/my-issues?tab=created');
    const { result } = renderHook(() => useViewState('my-issues'));
    act(() => result.current.setFilter({ priority: [1] }));
    expect(window.location.search).toBe('?tab=created&priority=1');
  });
});
