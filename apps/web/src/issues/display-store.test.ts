// @vitest-environment jsdom
import { DEFAULT_DISPLAY } from '@torch/shared/views';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readStoredDisplay, writeStoredDisplay } from './display-store.ts';

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('stored display options', () => {
  it('are kept per team', () => {
    writeStoredDisplay('team-a', { ...DEFAULT_DISPLAY, group: 'assignee' });
    writeStoredDisplay('team-b', { ...DEFAULT_DISPLAY, layout: 'board' });
    expect(readStoredDisplay('team-a')?.group).toBe('assignee');
    expect(readStoredDisplay('team-b')?.layout).toBe('board');
    expect(readStoredDisplay('team-c')).toBeNull();
  });

  it('an unreadable or invalid value is ignored', () => {
    window.localStorage.setItem('view-display:t', '{not json');
    expect(readStoredDisplay('t')).toBeNull();
    window.localStorage.setItem(
      'view-display:t',
      JSON.stringify({ ...DEFAULT_DISPLAY, group: 'mood' }),
    );
    expect(readStoredDisplay('t')).toBeNull();
  });

  it('a storage that throws neither breaks reading nor writing', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('full');
    });
    expect(readStoredDisplay('t')).toBeNull();
    expect(() => writeStoredDisplay('t', DEFAULT_DISPLAY)).not.toThrow();
  });
});
