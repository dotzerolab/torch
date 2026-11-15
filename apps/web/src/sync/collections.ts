// Electric shapes -> TanStack DB collections, in memory only: persistence, multi-tab and the offline outbox are P1
// (ADR 0001 sections 5 and 6). The browser reads through the server's shape proxy (never Electric itself), and a
// write is a PATCH whose txid the collection waits for, so the optimistic change stays until Electric confirms it.
import { FetchError } from '@electric-sql/client';
import { electricCollectionOptions } from '@tanstack/electric-db-collection';
import { createCollection } from '@tanstack/react-db';
import { apiFetch } from '../api.ts';
import { toIssueUpdate } from './issue-update.ts';

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

function shapeOptions(path: string) {
  return {
    url: new URL(path, window.location.origin).href,
    // The session ended while a shape was open: the proxy answers 401, so go back to sign-in.
    onError: (error: Error) => {
      if (error instanceof FetchError && error.status === 401) window.location.assign('/login');
    },
  };
}

export function createTeamsCollection(workspaceId: string) {
  return createCollection(
    electricCollectionOptions<SyncedTeam>({
      id: `teams-${workspaceId}`,
      getKey: (team) => team.id,
      shapeOptions: shapeOptions(`/api/sync/w/${workspaceId}/teams`),
    }),
  );
}

export function createMembersCollection(workspaceId: string) {
  return createCollection(
    electricCollectionOptions<SyncedMember>({
      id: `members-${workspaceId}`,
      getKey: (member) => member.id,
      shapeOptions: shapeOptions(`/api/sync/w/${workspaceId}/members`),
    }),
  );
}

export function createTeamMembersCollection(workspaceId: string, teamId: string) {
  return createCollection(
    electricCollectionOptions<SyncedTeamMember>({
      id: `team-members-${workspaceId}-${teamId}`,
      // A person is in a team once: the pair is the key.
      getKey: (row) => `${row.team_id}:${row.member_id}`,
      shapeOptions: shapeOptions(`/api/sync/w/${workspaceId}/teams/${teamId}/members`),
    }),
  );
}

export function createIssuesCollection(workspaceId: string, teamId: string) {
  return createCollection(
    electricCollectionOptions<SyncedIssue>({
      id: `issues-${workspaceId}-${teamId}`,
      getKey: (issue) => issue.id,
      shapeOptions: shapeOptions(`/api/sync/w/${workspaceId}/teams/${teamId}/issues`),
      onUpdate: async ({ transaction, collection }) => {
        const mutation = transaction.mutations[0];
        if (!mutation) return;
        const { txid } = await apiFetch<{ txid: number }>(
          `/api/w/${workspaceId}/issues/${mutation.key}`,
          { method: 'PATCH', body: JSON.stringify(toIssueUpdate(mutation.changes)) },
        );
        // Resolving before the write comes back through Electric would drop the optimistic state too early.
        await collection.utils.awaitTxId(txid, TXID_TIMEOUT_MS);
      },
    }),
  );
}

// One live collection per shape for the life of the page, so going back to a team does not restart its sync.
// Sign-out reloads the page, which is what drops them.
const teams = new Map<string, ReturnType<typeof createTeamsCollection>>();
const issues = new Map<string, ReturnType<typeof createIssuesCollection>>();
const members = new Map<string, ReturnType<typeof createMembersCollection>>();
const teamMembers = new Map<string, ReturnType<typeof createTeamMembersCollection>>();

export function teamsCollection(workspaceId: string) {
  let collection = teams.get(workspaceId);
  if (!collection) {
    collection = createTeamsCollection(workspaceId);
    teams.set(workspaceId, collection);
  }
  return collection;
}

export function issuesCollection(workspaceId: string, teamId: string) {
  const key = `${workspaceId}:${teamId}`;
  let collection = issues.get(key);
  if (!collection) {
    collection = createIssuesCollection(workspaceId, teamId);
    issues.set(key, collection);
  }
  return collection;
}

export function membersCollection(workspaceId: string) {
  let collection = members.get(workspaceId);
  if (!collection) {
    collection = createMembersCollection(workspaceId);
    members.set(workspaceId, collection);
  }
  return collection;
}

export function teamMembersCollection(workspaceId: string, teamId: string) {
  const key = `${workspaceId}:${teamId}`;
  let collection = teamMembers.get(key);
  if (!collection) {
    collection = createTeamMembersCollection(workspaceId, teamId);
    teamMembers.set(key, collection);
  }
  return collection;
}

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
