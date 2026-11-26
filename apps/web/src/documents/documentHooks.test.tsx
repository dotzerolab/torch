// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SyncedDocumentContent, SyncedDocumentSummary } from '../sync/collections.ts';
import { manualCollection } from '../test/collections.ts';

const mocks = vi.hoisted(() => ({ collections: {} as Record<string, unknown> }));
vi.mock('../sync/shapes.ts', () => ({
  syncRegistry: { get: () => ({}), refresh: () => {} },
  useShape: (key: { kind: string }) => mocks.collections[key.kind],
}));

import { useDocumentContent } from './useDocumentContent.ts';
import { useTeamDocuments } from './useTeamDocuments.ts';

const summary = (id: string, title: string, updated_at: string): SyncedDocumentSummary => ({
  id,
  workspace_id: 'w1',
  team_id: 't1',
  title,
  created_by: 'm1',
  updated_by: 'm1',
  created_at: '2026-11-26T09:00:00Z',
  updated_at,
  archived_at: null,
});

describe('useTeamDocuments', () => {
  it('lists the titles, the most recently changed first, once the shape answered', async () => {
    const titles = manualCollection<SyncedDocumentSummary>('documents', (row) => row.id);
    mocks.collections.documents = titles.collection;
    const { result } = renderHook(() => useTeamDocuments('w1', 't1'));
    expect(result.current.ready).toBe(false);
    await act(async () => {
      titles.set(
        summary('a', 'Old', '2026-11-26T10:00:00Z'),
        summary('b', 'New', '2026-11-26T11:00:00Z'),
      );
      titles.ready();
    });
    expect(result.current.ready).toBe(true);
    expect(result.current.documents.map((d) => d.id)).toEqual(['b', 'a']);
  });
});

describe('useDocumentContent', () => {
  it('has no body until the shape answered, then the body of the document', async () => {
    const titles = manualCollection<SyncedDocumentSummary>('documents-2', (row) => row.id);
    titles.ready();
    const content = manualCollection<SyncedDocumentContent>('content', (row) => row.id);
    mocks.collections.documents = titles.collection;
    mocks.collections.documentContent = content.collection;
    const { result } = renderHook(() => useDocumentContent('w1', 't1', 'd1'));
    expect(result.current).toEqual({ body: null, ready: false });
    await act(async () => {
      content.set({ id: 'd1', workspace_id: 'w1', team_id: 't1', body: '# Notes' });
      content.ready();
    });
    expect(result.current).toEqual({ body: '# Notes', ready: true });
  });
});
