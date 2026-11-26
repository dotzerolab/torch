// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SyncedAttachment, SyncedIssue } from '../sync/collections.ts';
import { manualCollection } from '../test/collections.ts';

const mocks = vi.hoisted(() => ({ collections: {} as Record<string, unknown> }));
vi.mock('../sync/shapes.ts', () => ({
  syncRegistry: { get: () => ({}), refresh: () => {} },
  useShape: (key: { kind: string }) => mocks.collections[key.kind],
}));

import { useIssueAttachments } from './useIssueAttachments.ts';

const file = (id: string, created_at: string): SyncedAttachment => ({
  id,
  workspace_id: 'w1',
  team_id: 't1',
  issue_id: 'i1',
  uploader_id: 'm1',
  file_name: `${id}.png`,
  content_type: 'image/png',
  size_bytes: 10,
  created_at,
});

describe('useIssueAttachments', () => {
  it('is ready after the shape answered and lists the files oldest first', async () => {
    const issues = manualCollection<SyncedIssue>('issues', (row) => row.id);
    issues.ready();
    const files = manualCollection<SyncedAttachment>('files', (row) => row.id);
    mocks.collections.issues = issues.collection;
    mocks.collections.issueAttachments = files.collection;
    const { result } = renderHook(() => useIssueAttachments('w1', 't1', 'i1'));
    expect(result.current).toEqual({ attachments: [], ready: false });
    await act(async () => {
      files.set(file('b', '2026-11-26T10:02:00Z'), file('a', '2026-11-26T10:01:00Z'));
      files.ready();
    });
    expect(result.current.ready).toBe(true);
    expect(result.current.attachments.map((f) => f.id)).toEqual(['a', 'b']);
  });
});
