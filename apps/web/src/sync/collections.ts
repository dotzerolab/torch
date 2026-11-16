// Electric shapes -> TanStack DB collections. The browser reads through the server's shape proxy (never Electric
// itself), and a write goes through the outbox as a PATCH whose txid the collection waits for, so the optimistic change
// stays until Electric confirms it. When the workspace's device store is open (`persistence.ts`) every collection is
// also kept there, so the next visit renders from the device before the network answers (ADR 0001 section 5).
import { FetchError } from '@electric-sql/client';
import { persistedCollectionOptions } from '@tanstack/browser-db-sqlite-persistence';
import { electricCollectionOptions } from '@tanstack/electric-db-collection';
import { createCollection } from '@tanstack/react-db';
import { createDeviceFollower } from './device-follow.ts';
import { toIssueUpdate } from './issue-update.ts';
import { hubFor, type MirrorOp } from './mirror.ts';
import { enqueueWrite, type OutboxWrite } from './outbox.ts';
import { hasDeviceCopy, persistenceFor, queueDeviceCopy, waitUntilStored } from './persistence.ts';
import { type Factories, type ShapeContext, type ShapeKey, shapeId } from './registry.ts';
import { isSigningOut } from './signing-out.ts';

/** A `team` row as the shape delivers it (column names as in the database). */
export type SyncedTeam = {
  id: string;
  workspace_id: string;
  key: string;
  name: string;
  private: boolean;
};

/**
 * A `member` row as the shape delivers it: the profile without email and time zone (those never leave the server in a
 * shape). `deactivated_at` is set for a member who can no longer sign in.
 */
export type SyncedMember = {
  id: string;
  workspace_id: string;
  name: string;
  handle: string;
  role: 'owner' | 'admin' | 'member' | 'guest';
  locale: 'en' | 'it';
  deactivated_at: string | null;
  created_at: string;
};

/** A `workflow_state` row of a team's shape. */
export type SyncedWorkflowState = {
  id: string;
  workspace_id: string;
  team_id: string;
  name: string;
  type: string;
  position: number;
  color: string;
};

/** A `team_member` row of one team's shape. */
export type SyncedTeamMember = {
  team_id: string;
  member_id: string;
  workspace_id: string;
  created_at: string;
};

/** An `issue` row of a list shape: never the description (ADR 0001 section 4). Timestamps arrive as ISO text. */
export type SyncedIssue = {
  id: string;
  workspace_id: string;
  team_id: string;
  number: number;
  title: string;
  state_id: string;
  priority: number;
  assignee_id: string | null;
  creator_id: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

// How long a write waits for its txid to come back through Electric before the optimistic state is dropped.
const TXID_TIMEOUT_MS = 10_000;

/**
 * 429 and 5xx never reach `onError`: the pinned client's fetch layer retries them itself (1 s doubling to 30 s, full
 * jitter, a `Retry-After` header as the floor, no retry limit). These are the timings it uses.
 */
export const BACKOFF_OPTIONS = { initialDelay: 1000, maxDelay: 30_000, multiplier: 2 } as const;

/** What the error policy may do besides stopping the stream. */
export type ShapeErrorActions = {
  signIn: () => void;
  dropTeam: (workspaceId: string, teamId: string) => void;
};

/**
 * The one policy for a shape that failed beyond the client's own retries: the session ended (401) -> sign in; a
 * team-scoped shape answers 404 -> the team is gone for this person, drop it; anything else stops the stream (an
 * empty return; `{}` would make the client retry).
 */
export function handleShapeError(
  error: Error,
  scope: { workspaceId: string; teamId?: string },
  actions: ShapeErrorActions,
): void {
  if (!(error instanceof FetchError)) return;
  if (error.status === 401) {
    // Signing out ends the session on purpose; the sign-out flow leaves the page itself once the device is clean.
    if (!isSigningOut()) actions.signIn();
  } else if (error.status === 404 && scope.teamId !== undefined) {
    actions.dropTeam(scope.workspaceId, scope.teamId);
  }
}

/**
 * How long a collection waits for the network before it shows what the device holds. A page that was closed a moment ago
 * resumes its shapes in well under this; a page without a network shows the device copy after it.
 */
export const RENDER_FROM_DEVICE_AFTER_MS = 400;

type PersistableOptions = { id?: string; sync?: unknown; onUpdate?: unknown };

type SyncParams = {
  markReady: () => void;
  truncate: (...args: never[]) => void;
  collection: unknown;
};
type SyncFunction = (params: SyncParams) => unknown;
type SyncObject = { sync: SyncFunction } & Record<string, unknown>;

/** What a wrapped sync tells its owner. */
type SyncHooks = {
  /** The shape applied an answer of the server: `markReady` is called after every `up-to-date`, not only the first. */
  settled: (collection: { keys(): Iterable<string | number> }) => void;
  /** A `must-refetch`: the shape started over. */
  truncated: () => void;
  /** The instance was cleaned up. */
  cleanup: () => void;
};

/**
 * The same options with a sync that reports what the rest of the page needs to know: that the shape settled (the access
 * watcher compares rows when it does; nothing can subscribe to a removal of a row that came with the first sync), that
 * it was truncated, and when it ended. It wraps the sync BEFORE the persistence layer does, so it works the same for a
 * warm instance, a cold one and a page without a device copy.
 */
export function observeSync<T extends PersistableOptions>(options: T, hooks: SyncHooks): T {
  const inner = options.sync as SyncObject;
  return {
    ...options,
    sync: {
      ...inner,
      sync: (params: SyncParams) => {
        const result = inner.sync({
          ...params,
          markReady: () => {
            params.markReady();
            hooks.settled(params.collection as { keys(): Iterable<string | number> });
          },
          truncate: (...args: never[]) => {
            params.truncate(...args);
            hooks.truncated();
          },
        });
        const end = () => hooks.cleanup();
        if (typeof result === 'function') {
          return () => {
            end();
            return (result as () => unknown)();
          };
        }
        const object = (result ?? {}) as { cleanup?: () => unknown };
        return {
          ...object,
          cleanup: () => {
            end();
            return object.cleanup?.();
          },
        };
      },
    },
  };
}

/**
 * What a shape does with the device store.
 *
 * Warm (the device already holds the collection): the instance is a persisted one. It renders the stored rows when the
 * network is slow or gone, resumes the shape from where the device copy stopped, and writes the small changes (the
 * library also applies a delete or a truncate to the store).
 *
 * Cold (first visit, or the copy was deleted): the instance stays in memory. Writing a whole first snapshot through the
 * persistence layer takes seconds for 10,000 rows, and the layer admits the next change only after the write, so a
 * remote edit shortly after the load would wait for it. Once the shape is up to date a headless persisted instance of
 * the same shape reads it again and writes it in the background; nothing reads that instance, so it delays nothing.
 * The next visit is warm. That instance ends after its write, so a follower (`device-follow.ts`) runs it again over the
 * populated store when a row later leaves the shape or the shape starts over: the library applies the server's deletes to
 * the store, resuming from the stored offset. A team that is gone for this person is never persisted.
 */
function persisted<T extends PersistableOptions>(
  workspaceId: string,
  build: () => T,
  context: ShapeContext,
): T {
  const persistence = context.inert ? null : persistenceFor(workspaceId);
  const first = build();
  const id = first.id;
  const cold = !!persistence && !!id && !hasDeviceCopy(workspaceId, id);
  // The copy job that is running for this instance, so that ending the instance can end it too.
  const running: RunningCopy = { stop: null };
  let liveKeys: () => Iterable<string | number> = () => [];
  const follower =
    cold && persistence && id
      ? createDeviceFollower({
          keys: () => liveKeys(),
          copy: () => copyToDevice(workspaceId, id, build, persistence, running, 'copy'),
          refresh: () => copyToDevice(workspaceId, id, build, persistence, running, 'refresh'),
          // A restart or a drop ends the copy too: its rows must not be written after the old ones were deleted, and a
          // backlog of dead copies would hold the queue. A pause does not end a FIRST copy: the shape starts again under
          // the same id and an interrupted copy would leave the device without it.
          onCancel: () => {
            if (running.mode === 'refresh' || !running.keepCopy) running.stop?.();
          },
        })
      : null;
  const observed = observeSync(first, {
    settled: (collection) => {
      liveKeys = () => collection.keys();
      follower?.settled();
      context.settled();
    },
    truncated: () => follower?.truncated(),
    cleanup: () => {
      running.cancelled = true;
      running.keepCopy = context.paused();
      follower?.cancel();
    },
  });
  if (!persistence || !id || cold) return observed;
  return persistedCollectionOptions({
    ...(observed as object),
    persistence,
    initialRender: { strategy: 'network-first', networkTimeoutMs: RENDER_FROM_DEVICE_AFTER_MS },
  } as never) as unknown as T;
}

/** The stop of the copy job a shape instance has running, if any. */
type RunningCopy = {
  stop: (() => void) | null;
  mode?: 'copy' | 'refresh';
  cancelled?: boolean;
  /** The instance was only paused: a first copy that is queued or running goes on. */
  keepCopy?: boolean;
};

/** How long a refresh waits for the store to catch up: a changing shape must not hold the queue for a minute. */
const REFRESH_STORE_TIMEOUT_MS = 15_000;
/** How long a refresh waits for the network before it would fall back to the stored rows (it then changes nothing). */
const REFRESH_NETWORK_TIMEOUT_MS = 30_000;

/**
 * Reads a shape through a persisted instance nobody reads and ends it once the store holds what it holds. The first copy
 * starts from an empty store; a refresh starts from the populated one, so the library applies what the server removed
 * (a delete message, or a reset after a `must-refetch`) and a plain delete resumes from the stored offset.
 */
function copyToDevice(
  workspaceId: string,
  id: string,
  build: () => PersistableOptions,
  persistence: NonNullable<ReturnType<typeof persistenceFor>>,
  running: RunningCopy,
  mode: 'copy' | 'refresh',
): Promise<void> {
  return queueDeviceCopy(workspaceId, async (registerStop) => {
    if (running.cancelled && (mode === 'refresh' || !running.keepCopy)) return;
    const copy = createCollection(
      persistedCollectionOptions({
        ...(build() as object),
        // Nothing writes through this instance.
        onUpdate: undefined,
        persistence,
        id,
        // Over a populated store (a refresh) the network answer must win over the stored rows, however long it takes.
        ...(mode === 'refresh'
          ? {
              initialRender: {
                strategy: 'network-first',
                networkTimeoutMs: REFRESH_NETWORK_TIMEOUT_MS,
              },
            }
          : {}),
      } as never) as never,
    ) as unknown as { preload(): Promise<void>; size: number; cleanup(): Promise<void> | void };
    let stopped = false;
    let ended!: () => void;
    // `preload` of an instance that was cleaned up may never settle: the job must not wait for it, or the queue stalls.
    const interrupted = new Promise<void>((resolve) => {
      ended = resolve;
    });
    const stop = () => {
      stopped = true;
      ended();
      void Promise.resolve(copy.cleanup()).catch(() => {});
    };
    registerStop(stop);
    running.stop = stop;
    running.mode = mode;
    try {
      await Promise.race([copy.preload(), interrupted]);
      if (!stopped) {
        await waitUntilStored(workspaceId, id, () => copy.size, {
          timeoutMs: mode === 'refresh' ? REFRESH_STORE_TIMEOUT_MS : undefined,
          isCancelled: () => stopped,
        });
      }
    } finally {
      if (running.stop === stop) running.stop = null;
      if (!stopped) await Promise.resolve(copy.cleanup()).catch(() => {});
    }
  });
}

type Row = Record<string, unknown>;
type SyncMessage = { type: string; key?: string | number; value?: Row };

/** What the follower and the leader's tap need of the sync parameters and the options of an Electric collection. */
type MirrorableParams = SyncParams & {
  begin: (...args: never[]) => void;
  write: (message: SyncMessage) => void;
  commit: () => void;
};
type Mirrorable = PersistableOptions & {
  getKey: (row: never) => string | number;
  utils?: Record<string, unknown>;
};

/**
 * The shape of this tab, by role. A leader syncs it (and keeps it on the device when it can), and tells the follower tabs
 * of the workspace what its collection receives. A follower opens no request: its collection reads what the leader tells
 * it (`mirror.ts`), and a write of it waits for its txid through the leader, which owns the stream that brings it back.
 */
function shaped<T extends PersistableOptions>(
  key: ShapeKey,
  build: () => T,
  context: ShapeContext,
): T {
  if (context.inert) return { ...build(), sync: inertSync };
  if (context.role === 'follower') return followed(key, build() as T & Mirrorable, context) as T;
  const options = persisted(key.workspaceId, build, context);
  const hub = hubFor(key.workspaceId);
  const getKey = (build() as T & Mirrorable).getKey as (row: Row) => string | number;
  const inner = options.sync as SyncObject;
  const shape = shapeId(key);
  return {
    ...options,
    sync: {
      ...inner,
      sync: (params: MirrorableParams) => {
        const tap = hub.publish(shape, getKey);
        const result = inner.sync({
          ...params,
          // What the persistence layer returns (an applied receipt) must reach its caller.
          write: (message: SyncMessage) => {
            const result = (params.write as (m: SyncMessage) => unknown)(message);
            tap.write(message);
            return result;
          },
          truncate: (...args: never[]) => {
            const result = (params.truncate as (...a: never[]) => unknown)(...args);
            tap.truncate();
            return result;
          },
          commit: () => {
            const result = (params.commit as () => unknown)();
            tap.commit();
            return result;
          },
          markReady: () => {
            const result = (params.markReady as () => unknown)();
            tap.ready();
            return result;
          },
        } as never);
        if (typeof result === 'function') {
          return () => {
            tap.end();
            return (result as () => unknown)();
          };
        }
        const object = (result ?? {}) as { cleanup?: () => unknown };
        return {
          ...object,
          cleanup: () => {
            tap.end();
            return object.cleanup?.();
          },
        };
      },
    },
  };
}

function followed<T extends Mirrorable>(key: ShapeKey, base: T, context: ShapeContext): T {
  const hub = hubFor(key.workspaceId);
  const shape = shapeId(key);
  const getKey = base.getKey as (row: Row) => string | number;
  return {
    ...base,
    sync: {
      sync: (params: MirrorableParams) => {
        // The keys the collection holds from the leader: a row is inserted once, and updated after that.
        const known = new Set<string | number>();
        const apply = (ops: ReadonlyArray<MirrorOp>) => {
          params.begin();
          for (const op of ops) {
            if (op.k === 'clear') {
              params.truncate();
              known.clear();
            } else if (op.k === 'set') {
              const rowKey = getKey(op.row);
              params.write({ type: known.has(rowKey) ? 'update' : 'insert', value: op.row });
              known.add(rowKey);
            } else if (known.delete(op.key)) {
              params.write({ type: 'delete', key: op.key });
            }
          }
          params.commit();
        };
        const ready = () => {
          params.markReady();
          context.settled();
        };
        const stop = hub.follow(shape, {
          snapshot: (rows, isReady) => {
            apply([{ k: 'clear' }, ...rows.map((row): MirrorOp => ({ k: 'set', row }))]);
            if (isReady) ready();
          },
          ops: apply,
          ready,
        });
        return { cleanup: stop };
      },
    },
    utils: {
      ...base.utils,
      awaitTxId: async (txid: number, timeoutMs = TXID_TIMEOUT_MS) => {
        if (!(await hub.awaitTxId(shape, txid, timeoutMs))) {
          throw new Error(`The write ${txid} did not come back in time`);
        }
        return true;
      },
    },
  };
}

const signIn = () => window.location.assign('/login');

function shapeOptions(
  path: string,
  scope: { workspaceId: string; teamId?: string },
  context: ShapeContext,
) {
  return {
    url: new URL(path, window.location.origin).href,
    backoffOptions: { ...BACKOFF_OPTIONS },
    onError: (error: Error) => {
      handleShapeError(error, scope, { signIn, dropTeam: context.dropTeam });
    },
  };
}

/** A team the server no longer shows: an empty collection that never syncs, so nothing asks for it again. */
const inertSync = { sync: ({ markReady }: { markReady: () => void }) => markReady() };

const NO_CONTEXT: ShapeContext = {
  dropTeam: () => {},
  inert: false,
  settled: () => {},
  paused: () => false,
  role: 'leader',
};

export function createTeamsCollection(
  workspaceId: string,
  id = `teams-${workspaceId}`,
  context = NO_CONTEXT,
) {
  const build = () =>
    electricCollectionOptions<SyncedTeam>({
      id,
      getKey: (team) => team.id,
      shapeOptions: shapeOptions(`/api/sync/w/${workspaceId}/teams`, { workspaceId }, context),
    });
  return createCollection(shaped({ kind: 'teams', workspaceId }, build, context));
}

export function createMembersCollection(
  workspaceId: string,
  id = `members-${workspaceId}`,
  context = NO_CONTEXT,
) {
  const build = () =>
    electricCollectionOptions<SyncedMember>({
      id,
      getKey: (member) => member.id,
      shapeOptions: shapeOptions(`/api/sync/w/${workspaceId}/members`, { workspaceId }, context),
    });
  return createCollection(shaped({ kind: 'members', workspaceId }, build, context));
}

/** The person's own team memberships: the signal that their access to teams changed. Not shown anywhere. */
export function createOwnMembershipsCollection(
  workspaceId: string,
  id = `own-memberships-${workspaceId}`,
  context = NO_CONTEXT,
) {
  const build = () =>
    electricCollectionOptions<SyncedTeamMember>({
      id,
      getKey: (row) => `${row.team_id}:${row.member_id}`,
      shapeOptions: shapeOptions(
        `/api/sync/w/${workspaceId}/me/team-memberships`,
        { workspaceId },
        context,
      ),
    });
  return createCollection(shaped({ kind: 'ownMemberships', workspaceId }, build, context));
}

export function createTeamMembersCollection(
  workspaceId: string,
  teamId: string,
  id = `team-members-${workspaceId}-${teamId}`,
  context = NO_CONTEXT,
) {
  const build = () =>
    electricCollectionOptions<SyncedTeamMember>({
      id,
      // A person is in a team once: the pair is the key.
      getKey: (row) => `${row.team_id}:${row.member_id}`,
      shapeOptions: shapeOptions(
        `/api/sync/w/${workspaceId}/teams/${teamId}/members`,
        { workspaceId, teamId },
        context,
      ),
    });
  return createCollection(shaped({ kind: 'teamMembers', workspaceId, teamId }, build, context));
}

export function createWorkflowStatesCollection(
  workspaceId: string,
  teamId: string,
  id = `workflow-states-${workspaceId}-${teamId}`,
  context = NO_CONTEXT,
) {
  const build = () =>
    electricCollectionOptions<SyncedWorkflowState>({
      id,
      getKey: (state) => state.id,
      shapeOptions: shapeOptions(
        `/api/sync/w/${workspaceId}/teams/${teamId}/workflow-states`,
        { workspaceId, teamId },
        context,
      ),
    });
  return createCollection(shaped({ kind: 'workflowStates', workspaceId, teamId }, build, context));
}

/**
 * M9: every mutation of a transaction is queued, one PATCH each in order, and every txid is awaited. Sending only the
 * first would confirm the transaction while the others were never written. Resolving before the writes come back
 * through Electric would drop the optimistic state too early. The outbox keeps a write across a lost connection or a
 * reload and sends it again with the same `Idempotency-Key`; a refused write rejects here, so the optimistic change
 * is rolled back.
 */
export async function sendIssueMutations(
  workspaceId: string,
  teamId: string,
  mutations: ReadonlyArray<{ key: string | number; changes: Record<string, unknown> }>,
  awaitTxId: (txid: number) => Promise<unknown>,
  enqueue: (write: OutboxWrite) => Promise<{ txid: number }> = enqueueWrite,
): Promise<void> {
  const txids: number[] = [];
  for (const mutation of mutations) {
    const { txid } = await enqueue({
      workspaceId,
      teamId,
      method: 'PATCH',
      path: `/api/w/${workspaceId}/issues/${mutation.key}`,
      body: toIssueUpdate(mutation.changes),
      idempotencyKey: crypto.randomUUID(),
    });
    txids.push(txid);
  }
  for (const txid of txids) await awaitTxId(txid);
}

export function createIssuesCollection(
  workspaceId: string,
  teamId: string,
  id = `issues-${workspaceId}-${teamId}`,
  context = NO_CONTEXT,
) {
  const build = () =>
    electricCollectionOptions<SyncedIssue>({
      id,
      getKey: (issue) => issue.id,
      shapeOptions: shapeOptions(
        `/api/sync/w/${workspaceId}/teams/${teamId}/issues`,
        { workspaceId, teamId },
        context,
      ),
      // M9: every mutation of the transaction is sent, one PATCH each in order, and every txid is awaited. Sending
      // only the first would confirm the transaction while the others were never written.
      onUpdate: async ({ transaction, collection }) => {
        await sendIssueMutations(workspaceId, teamId, transaction.mutations, (txid) =>
          collection.utils.awaitTxId(txid, TXID_TIMEOUT_MS),
        );
      },
    });
  return createCollection(shaped({ kind: 'issues', workspaceId, teamId }, build, context));
}

/** How each shape kind is built. The registry owns the instances, the ids and the restarts. */
export const collectionFactories = {
  teams: (key, id, context) => createTeamsCollection(key.workspaceId, id, context),
  members: (key, id, context) => createMembersCollection(key.workspaceId, id, context),
  ownMemberships: (key, id, context) =>
    createOwnMembershipsCollection(key.workspaceId, id, context),
  issues: (key, id, context) => createIssuesCollection(key.workspaceId, key.teamId, id, context),
  workflowStates: (key, id, context) =>
    createWorkflowStatesCollection(key.workspaceId, key.teamId, id, context),
  teamMembers: (key, id, context) =>
    createTeamMembersCollection(key.workspaceId, key.teamId, id, context),
} satisfies Factories;

/**
 * Waits until the write with this `txid` came back through the shape of `collection`, so the list on screen already
 * shows it. A wait that runs out is not an error of the write: the server accepted it and the list catches up.
 */
export async function awaitSynced(
  collection: { utils: { awaitTxId: (txid: number, timeoutMs?: number) => Promise<boolean> } },
  txid: number,
): Promise<void> {
  try {
    await collection.utils.awaitTxId(txid, TXID_TIMEOUT_MS);
  } catch {
    // The write is done; the shape was slow or is being refetched.
  }
}
