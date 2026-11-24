// Whose device copy this is. A person is one `member` row per workspace, so the device names carry both: the workspace
// and the member the session signed in as. Another person who signs in on the same browser gets other names and can
// never read, render or resume what the first person left (a session that ended by expiry leaves its files behind).
// The page binds the identities once the session is known, before anything reads the device; until then the names
// cannot be made, so nothing of the device is opened for an unknown person.

const members = new Map<string, string>();

export type SessionIdentity = { id: string; memberId: string };

/** Binds the workspaces (and the member in each) of the session that is signed in. Replaces any earlier binding. */
export function bindSession(workspaces: readonly SessionIdentity[]) {
  members.clear();
  for (const workspace of workspaces) members.set(workspace.id, workspace.memberId);
}

/**
 * The browser opens a database file only when its name is short (about 55 characters; a longer one fails to open and the
 * page would silently work from memory). The workspace id is a whole UUID, so the member is named by the first 8 hex
 * digits of its id: enough to tell the people of one workspace apart on one device.
 */
export const MEMBER_TAG_LENGTH = 8;

/** The prefix of every device name of this person in this workspace (store, outbox, tab channel, leader lock). */
export function deviceScope(workspaceId: string): string {
  const memberId = members.get(workspaceId);
  if (!memberId) throw new Error(`No signed-in member is bound for workspace ${workspaceId}.`);
  return `ws-${workspaceId}-m${memberId.replaceAll('-', '').slice(0, MEMBER_TAG_LENGTH)}`;
}

/** The scope of every workspace of the session, for the cleanup at session start. */
export const sessionScopes = (): string[] => [...members.keys()].map(deviceScope);

/** Test helper. */
export function resetIdentityForTests() {
  members.clear();
}

/** Test helper: binds each id to a member named after it. */
export function bindTestSession(...workspaceIds: string[]) {
  bindSession(workspaceIds.map((id) => ({ id, memberId: `member-of-${id}` })));
}
