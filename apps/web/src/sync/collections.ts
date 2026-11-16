// Electric shapes -> TanStack DB collections, in memory only: persistence, multi-tab and the offline outbox are P1
// (ADR 0001 sections 5 and 6). The browser reads through the server's shape proxy (never Electric itself), and a
// write is a PATCH whose txid the collection waits for, so the optimistic change stays until Electric confirms it.
import { FetchError } from '@electric-sql/client';
import { electricCollectionOptions } from '@tanstack/electric-db-collection';
import { createCollection } from '@tanstack/react-db';
import { toIssueUpdate } from './issue-update.ts';
import { enqueueWrite, type OutboxWrite } from './outbox.ts';
import type { Factories, ShapeContext } from './registry.ts';

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
  if (error.status === 401) actions.signIn();
  else if (error.status === 404 && scope.teamId !== undefined) {
    actions.dropTeam(scope.workspaceId, scope.teamId);
  }
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

const NO_CONTEXT: ShapeContext = { dropTeam: () => {}, inert: false };

export function createTeamsCollection(
  workspaceId: string,
  id = `teams-${workspaceId}`,
  context = NO_CONTEXT,
) {
  return createCollection(
    electricCollectionOptions<SyncedTeam>({
      id,
      getKey: (team) => team.id,
      shapeOptions: shapeOptions(`/api/sync/w/${workspaceId}/teams`, { workspaceId }, context),
    }),
  );
}

export function createMembersCollection(
  workspaceId: string,
  id = `members-${workspaceId}`,
  context = NO_CONTEXT,
) {
  return createCollection(
    electricCollectionOptions<SyncedMember>({
      id,
      getKey: (member) => member.id,
      shapeOptions: shapeOptions(`/api/sync/w/${workspaceId}/members`, { workspaceId }, context),
    }),
  );
}

/** The person's own team memberships: the signal that their access to teams changed. Not shown anywhere. */
export function createOwnMembershipsCollection(
  workspaceId: string,
  id = `own-memberships-${workspaceId}`,
  context = NO_CONTEXT,
) {
  return createCollection(
    electricCollectionOptions<SyncedTeamMember>({
      id,
      getKey: (row) => `${row.team_id}:${row.member_id}`,
      shapeOptions: shapeOptions(
        `/api/sync/w/${workspaceId}/me/team-memberships`,
        { workspaceId },
        context,
      ),
    }),
  );
}

export function createTeamMembersCollection(
  workspaceId: string,
  teamId: string,
  id = `team-members-${workspaceId}-${teamId}`,
  context = NO_CONTEXT,
) {
  const options = electricCollectionOptions<SyncedTeamMember>({
    id,
    // A person is in a team once: the pair is the key.
    getKey: (row) => `${row.team_id}:${row.member_id}`,
    shapeOptions: shapeOptions(
      `/api/sync/w/${workspaceId}/teams/${teamId}/members`,
      { workspaceId, teamId },
      context,
    ),
  });
  return createCollection(context.inert ? { ...options, sync: inertSync } : options);
}

export function createWorkflowStatesCollection(
  workspaceId: string,
  teamId: string,
  id = `workflow-states-${workspaceId}-${teamId}`,
  context = NO_CONTEXT,
) {
  const options = electricCollectionOptions<SyncedWorkflowState>({
    id,
    getKey: (state) => state.id,
    shapeOptions: shapeOptions(
      `/api/sync/w/${workspaceId}/teams/${teamId}/workflow-states`,
      { workspaceId, teamId },
      context,
    ),
  });
  return createCollection(context.inert ? { ...options, sync: inertSync } : options);
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
  const options = electricCollectionOptions<SyncedIssue>({
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
  return createCollection(context.inert ? { ...options, sync: inertSync } : options);
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
