// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncedDocumentSummary, SyncedIssue } from '../sync/collections.ts';
import { manualCollection } from '../test/collections.ts';

const mocks = vi.hoisted(() => {
  const instances = new Map<string, object>();
  const collections: Record<string, unknown> = {};
  const idOf = (key: unknown) => JSON.stringify(key);
  return {
    instances,
    collections,
    registry: {
      get: vi.fn((key: unknown) => {
        const id = idOf(key);
        if (!instances.has(id)) instances.set(id, { id });
        return instances.get(id);
      }),
      refresh: vi.fn((key: unknown) => {
        instances.set(idOf(key), { id: idOf(key) });
      }),
    },
  };
});
vi.mock('../sync/shapes.ts', () => ({
  syncRegistry: mocks.registry,
  useShape: (key: { kind: string }) => mocks.collections[key.kind],
}));

import {
  forgetLoadedForTests,
  issueObjectKey,
  refreshAfterWrite,
  refresher,
  refreshOnMount,
  useKeepDocumentCurrent,
  useKeepIssueCurrent,
  useRowWatch,
} from './refresh.ts';

const key = issueObjectKey('issueComments', 'w1', 't1', 'i1');

const issue = (id: string, updated_at: string, title = 'Title'): SyncedIssue =>
  ({ id, title, updated_at, workspace_id: 'w1', team_id: 't1' }) as SyncedIssue;

beforeEach(() => {
  mocks.instances.clear();
  mocks.registry.get.mockClear();
  mocks.registry.refresh.mockClear();
  forgetLoadedForTests();
});
afterEach(() => {
  refresher.dispose();
  vi.useRealTimers();
});

describe('refreshAfterWrite', () => {
  it('reads the shape again at once, whatever the gap, and hands back the instance it replaced', () => {
    const before = mocks.registry.get(key);
    refreshAfterWrite(key);
    const second = refreshAfterWrite(key);
    expect(mocks.registry.refresh).toHaveBeenCalledTimes(2);
    expect(mocks.registry.refresh).toHaveBeenCalledWith(key);
    expect(second).not.toBe(before);
    expect(mocks.registry.get(key)).not.toBe(second);
  });
});

describe('refreshOnMount', () => {
  it('leaves a shape alone the first time it is shown', () => {
    refreshOnMount(key, 1_000);
    expect(mocks.registry.refresh).not.toHaveBeenCalled();
  });

  it('reads an instance again that a visit left behind, when it is a while old', () => {
    refreshOnMount(key, 1_000);
    refreshOnMount(key, 3_000);
    expect(mocks.registry.refresh).not.toHaveBeenCalled();
    refreshOnMount(key, 20_000);
    expect(mocks.registry.refresh).toHaveBeenCalledTimes(1);
    // The instance that replaced it is the one just read.
    refreshOnMount(key, 21_000);
    expect(mocks.registry.refresh).toHaveBeenCalledTimes(1);
  });

  it('does not read a new instance again: the registry made it after the old one was released', () => {
    refreshOnMount(key, 1_000);
    mocks.instances.clear();
    refreshOnMount(key, 60_000);
    expect(mocks.registry.refresh).not.toHaveBeenCalled();
  });
});

describe('useRowWatch', () => {
  it('calls back when the watched value changes after the baseline, and for nothing else', () => {
    const subscribers = new Set<() => void>();
    let value: string | undefined = 'v1';
    const onChange = vi.fn();
    const collection = {};
    renderHook(() =>
      useRowWatch(
        {
          collection,
          read: () => value,
          subscribe: (notify) => {
            subscribers.add(notify);
            return () => subscribers.delete(notify);
          },
        },
        onChange,
      ),
    );
    const fire = () => {
      for (const notify of subscribers) notify();
    };
    fire();
    expect(onChange).not.toHaveBeenCalled();
    value = 'v2';
    fire();
    fire();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('ends its subscription with the screen', () => {
    const subscribers = new Set<() => void>();
    const { unmount } = renderHook(() =>
      useRowWatch(
        {
          collection: {},
          read: () => 'v',
          subscribe: (notify) => {
            subscribers.add(notify);
            return () => subscribers.delete(notify);
          },
        },
        () => {},
      ),
    );
    expect(subscribers.size).toBe(1);
    unmount();
    expect(subscribers.size).toBe(0);
  });
});

describe('useKeepIssueCurrent', () => {
  it('reads the comments again when the issue row changes in the live shape, once per change', async () => {
    const issues = manualCollection<SyncedIssue>('issues-t1', (row) => row.id);
    mocks.collections.issues = issues.collection;
    issues.set(issue('i1', '2026-11-26T10:00:00Z'), issue('i2', '2026-11-26T10:00:00Z'));
    issues.ready();

    renderHook(() => useKeepIssueCurrent('w1', 't1', 'i1', 'issueComments'));
    expect(mocks.registry.refresh).not.toHaveBeenCalled();

    // A change of another issue, and of this one that leaves its timestamp alone, say nothing about the comments.
    await act(async () => {
      issues.set(issue('i2', '2026-11-26T10:05:00Z'));
      issues.set(issue('i1', '2026-11-26T10:00:00Z', 'Renamed locally'));
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(mocks.registry.refresh).not.toHaveBeenCalled();

    await act(async () => {
      issues.set(issue('i1', '2026-11-26T10:06:00Z'));
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(mocks.registry.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.registry.refresh).toHaveBeenCalledWith(key);
  });

  it('reads the files of the issue for the files hook and its own key', async () => {
    const issues = manualCollection<SyncedIssue>('issues-t1b', (row) => row.id);
    mocks.collections.issues = issues.collection;
    issues.set(issue('i1', 'a'));
    issues.ready();
    renderHook(() => useKeepIssueCurrent('w1', 't1', 'i1', 'issueAttachments'));
    await act(async () => {
      issues.set(issue('i1', 'b'));
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(mocks.registry.refresh).toHaveBeenCalledWith(
      issueObjectKey('issueAttachments', 'w1', 't1', 'i1'),
    );
  });
});

describe('useKeepDocumentCurrent', () => {
  it('reads the body again when the document row changes in the live titles shape', async () => {
    const titles = manualCollection<SyncedDocumentSummary>('documents-t1', (row) => row.id);
    mocks.collections.documents = titles.collection;
    const doc = (updated_at: string) =>
      ({ id: 'd1', title: 'Plan', updated_at }) as SyncedDocumentSummary;
    titles.set(doc('a'));
    titles.ready();
    renderHook(() => useKeepDocumentCurrent('w1', 't1', 'd1'));
    await act(async () => {
      titles.set(doc('b'));
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(mocks.registry.refresh).toHaveBeenCalledWith({
      kind: 'documentContent',
      workspaceId: 'w1',
      teamId: 't1',
      documentId: 'd1',
    });
  });
});
