// When the snapshot shapes of one opened issue (its comments, its files) and of one opened document (its body) are read
// again. A snapshot holds no connection, so something has to ask: the screen opening again after a short absence, a
// change of the issue (or document) row in the live shape that is already open, and this person's own write. The server
// bumps the issue's `updated_at` in the same transaction as every comment and file change, so the live `issues` shape
// carries the signal within a second or two. Bursts become one read now and at most one more a few seconds later.
import { useEffect, useRef } from 'react';
import type { ShapeKey } from '../sync/registry.ts';
import { syncRegistry, useShape } from '../sync/shapes.ts';
import { createRefresher } from '../sync/snapshots.ts';

/** The page's refresher for the snapshots of this folder, one gap per shape. */
export const refresher = createRefresher({ refresh: (key) => syncRegistry.refresh(key) });

export type IssueObjectKind = 'issueComments' | 'issueAttachments';

export function issueObjectKey(
  kind: IssueObjectKind,
  workspaceId: string,
  teamId: string,
  issueId: string,
): ShapeKey {
  return { kind, workspaceId, teamId, issueId };
}

export function documentContentKey(
  workspaceId: string,
  teamId: string,
  documentId: string,
): ShapeKey {
  return { kind: 'documentContent', workspaceId, teamId, documentId };
}

/**
 * This person just wrote: read the shape again now, whatever the gap. Returns the instance that was current when the
 * write was acknowledged, so the caller can tell when the instance that replaces it has settled.
 */
export function refreshAfterWrite(key: ShapeKey): object {
  const before = syncRegistry.get(key) as object;
  refresher.request(key, { now: true });
  noteLoaded(key);
  return before;
}

// What the page last knew of each shape: the instance and when. A screen that opens again finds the instance a recent visit
// left (the registry keeps a released shape 30 s); if that is the instance it knew a while ago, it may be behind.
const MOUNT_STALE_AFTER_MS = 5000;
const REMEMBER_LIMIT = 200;
const loaded = new Map<string, { instance: object; at: number }>();

function loadedId(key: ShapeKey): string {
  return JSON.stringify(key);
}

function noteLoaded(key: ShapeKey, at = Date.now()) {
  if (loaded.size >= REMEMBER_LIMIT) loaded.clear();
  loaded.set(loadedId(key), { instance: syncRegistry.get(key) as object, at });
}

/** A screen of the shape mounts: read it again when it is an old instance, else remember it as the one just read. */
export function refreshOnMount(key: ShapeKey, now = Date.now()) {
  const known = loaded.get(loadedId(key));
  const current = syncRegistry.get(key) as object;
  if (known && known.instance === current && now - known.at > MOUNT_STALE_AFTER_MS) {
    refresher.request(key, { now: true });
    noteLoaded(key, now);
    return;
  }
  if (!known || known.instance !== current) noteLoaded(key, now);
}

export function forgetLoadedForTests() {
  loaded.clear();
}

/** What a hook watches: a row of a live shape, and the `updated_at` that says it changed. */
export type RowWatch = {
  /** The collection the row lives in: when it is replaced the watch starts again. */
  collection: object;
  read: () => string | undefined;
  /** Calls `notify` for every change of the shape; returns what ends the subscription. */
  subscribe: (notify: () => void) => () => void;
};

/** Calls `onChange` when the watched value changes between two notifications. The first value is the baseline. */
export function useRowWatch(watch: RowWatch, onChange: () => void) {
  const latest = useRef(onChange);
  latest.current = onChange;
  const read = useRef(watch.read);
  read.current = watch.read;
  const subscribe = useRef(watch.subscribe);
  subscribe.current = watch.subscribe;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the watch object is new every render; its collection is the key
  useEffect(() => {
    let last = read.current();
    return subscribe.current(() => {
      const next = read.current();
      if (next === last) return;
      last = next;
      latest.current();
    });
  }, [watch.collection]);
}

/**
 * Keeps one snapshot of an issue current while a screen shows it: read again when the screen opens on an old instance and
 * whenever the issue row changes in the live `issues` shape of the team (the server bumps `updated_at` for every comment
 * and file change).
 */
export function useKeepIssueCurrent(
  workspaceId: string,
  teamId: string,
  issueId: string,
  kind: IssueObjectKind,
) {
  const issues = useShape({ kind: 'issues', workspaceId, teamId });
  useEffect(() => {
    refreshOnMount(issueObjectKey(kind, workspaceId, teamId, issueId));
  }, [workspaceId, teamId, issueId, kind]);
  useRowWatch(
    {
      collection: issues,
      read: () => issues.get(issueId)?.updated_at,
      subscribe: (notify) => {
        const subscription = issues.subscribeChanges((changes) => {
          if (changes.some((change) => change.key === issueId)) notify();
        });
        return () => subscription.unsubscribe();
      },
    },
    () => refresher.request(issueObjectKey(kind, workspaceId, teamId, issueId)),
  );
}

/** The same for the body of a document, which changes when its row in the live titles shape does. */
export function useKeepDocumentCurrent(workspaceId: string, teamId: string, documentId: string) {
  const titles = useShape({ kind: 'documents', workspaceId, teamId });
  useEffect(() => {
    refreshOnMount(documentContentKey(workspaceId, teamId, documentId));
  }, [workspaceId, teamId, documentId]);
  useRowWatch(
    {
      collection: titles,
      read: () => titles.get(documentId)?.updated_at,
      subscribe: (notify) => {
        const subscription = titles.subscribeChanges((changes) => {
          if (changes.some((change) => change.key === documentId)) notify();
        });
        return () => subscription.unsubscribe();
      },
    },
    () => refresher.request(documentContentKey(workspaceId, teamId, documentId)),
  );
}
