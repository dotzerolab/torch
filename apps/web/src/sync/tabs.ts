// Which tab of a browser profile syncs a workspace (ADR 0001 section 6). The tabs of one profile share one origin, one
// device store and one connection budget (about six per origin on HTTP/1.1), so ONE tab per workspace, the leader, holds
// the shapes open and writes the device store; the others, followers, read what the leader mirrors to them (`mirror.ts`).
//
// Leadership is a Web Lock per workspace: the browser hands it to the next waiting tab the moment the holder's page ends,
// however it ends (closed, crashed, discarded), so a follower takes over without a heartbeat. A browser without Web Locks
// leaves every tab its own leader: the old behaviour, one connection set per tab.

export type Role = 'leader' | 'follower';

/** What the tabs need of the browser; tests replace it. */
export type TabPlatform = {
  locks: Pick<LockManager, 'request' | 'query'> | undefined;
  channel(name: string): BroadcastChannel;
};

export const browserTabs: TabPlatform = {
  locks: typeof navigator === 'undefined' ? undefined : navigator.locks,
  channel: (name) => new BroadcastChannel(name),
};

/** Names carry no product name: the same origin may host other apps. */
const leaderLock = (workspaceId: string) => `sync-leader:${workspaceId}`;
const TAB_LOCK_PREFIX = 'sync-tab:';

/** This page, for the messages it sends to the other tabs. */
export const tabId = typeof crypto === 'undefined' ? 'tab' : crypto.randomUUID();

const claims = new Map<string, Promise<Role>>();
const roles = new Map<string, Role>();
const promotions = new Map<string, Set<() => void>>();
const releases = new Map<string, () => void>();
const waiting = new Map<string, AbortController>();
let joined = false;

/** The role of this tab for a workspace once it was claimed. A tab that never claimed one syncs on its own. */
export const roleOf = (workspaceId: string): Role => roles.get(workspaceId) ?? 'leader';

/**
 * Takes part in the workspace: the lock of the leader is taken if it is free, else this tab follows and waits its turn.
 * Resolves once the role is known. A tab that is a follower becomes leader later by itself: `onPromoted` says when.
 */
export function claimRole(workspaceId: string, platform: TabPlatform = browserTabs): Promise<Role> {
  const known = claims.get(workspaceId);
  if (known) return known;
  const claim = (async (): Promise<Role> => {
    const { locks } = platform;
    if (!locks) {
      roles.set(workspaceId, 'leader');
      return 'leader';
    }
    joinTabs(platform);
    const name = leaderLock(workspaceId);
    const role = await new Promise<Role>((resolve) => {
      void locks.request(name, { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve('follower');
          return undefined;
        }
        roles.set(workspaceId, 'leader');
        resolve('leader');
        // Held until this page ends (or `releaseLeadership`).
        return new Promise<void>((release) => releases.set(workspaceId, release));
      });
    });
    roles.set(workspaceId, role);
    if (role === 'follower') {
      const waitingFor = new AbortController();
      waiting.set(workspaceId, waitingFor);
      void locks
        .request(name, { signal: waitingFor.signal }, () => {
          roles.set(workspaceId, 'leader');
          for (const listener of [...(promotions.get(workspaceId) ?? [])]) listener();
          return new Promise<void>((release) => releases.set(workspaceId, release));
        })
        .catch(() => {});
    }
    return role;
  })();
  claims.set(workspaceId, claim);
  return claim;
}

/** `listener` is called when this tab, a follower, became the leader of the workspace. */
export function onPromoted(workspaceId: string, listener: () => void): () => void {
  const set = promotions.get(workspaceId) ?? new Set();
  promotions.set(workspaceId, set);
  set.add(listener);
  return () => {
    set.delete(listener);
  };
}

/** Gives the lock up (or stops waiting for it): the next tab leads. Sign-out and tests. */
export function releaseLeadership(workspaceId: string) {
  waiting.get(workspaceId)?.abort();
  waiting.delete(workspaceId);
  releases.get(workspaceId)?.();
  releases.delete(workspaceId);
}

/** Every tab that takes part holds a lock of its own, so the leader can tell which followers are still there. */
function joinTabs(platform: TabPlatform) {
  if (joined || !platform.locks) return;
  joined = true;
  void platform.locks
    .request(`${TAB_LOCK_PREFIX}${tabId}`, () => new Promise<void>(() => {}))
    .catch(() => {});
}

/** The ids of the tabs of this origin that take part, or null when the browser cannot tell. */
export async function liveTabs(platform: TabPlatform = browserTabs): Promise<Set<string> | null> {
  if (!platform.locks) return null;
  try {
    const { held } = await platform.locks.query();
    return new Set(
      (held ?? []).flatMap((lock) =>
        lock.name?.startsWith(TAB_LOCK_PREFIX) ? [lock.name.slice(TAB_LOCK_PREFIX.length)] : [],
      ),
    );
  } catch {
    return null;
  }
}

// ---- Sign-out of the whole profile -----------------------------------------------------------------------------------

const SESSION_CHANNEL = 'sync-session';

type SessionMessage =
  | { t: 'ending'; from: string }
  | { t: 'closed'; to: string }
  | { t: 'ended'; from: string };

/** How long the tab that signs out waits for the others to let go of their device store. */
const CLOSE_WAIT_MS = 3000;
/** How long a tab that was told about a sign-out waits for the end of it before it leaves anyway. */
const END_WAIT_MS = 15_000;

/**
 * The tab that signs out tells the others first, so the one that holds the device store closes it (the files cannot be
 * removed under an open connection), and tells them again when the session and the device copy are gone. Resolves when
 * every other tab answered, or after `CLOSE_WAIT_MS`.
 */
export async function announceSignOut(platform: TabPlatform = browserTabs): Promise<void> {
  const others = await liveTabs(platform);
  const expected = others ? [...others].filter((id) => id !== tabId).length : 0;
  if (expected === 0) return;
  const channel = platform.channel(SESSION_CHANNEL);
  await new Promise<void>((resolve) => {
    let answered = 0;
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, CLOSE_WAIT_MS);
    channel.onmessage = (event: MessageEvent<SessionMessage>) => {
      if (event.data.t === 'closed' && event.data.to === tabId && ++answered >= expected) done();
    };
    channel.postMessage({ t: 'ending', from: tabId } satisfies SessionMessage);
  });
  // The channel stays open for `announceSignedOut`.
  endingChannel = channel;
}

let endingChannel: BroadcastChannel | null = null;

/** The session and the device copy are gone: the other tabs may leave. */
export function announceSignedOut(platform: TabPlatform = browserTabs) {
  const channel = endingChannel ?? platform.channel(SESSION_CHANNEL);
  channel.postMessage({ t: 'ended', from: tabId } satisfies SessionMessage);
  endingChannel = null;
}

/**
 * Listens for a sign-out in another tab. `letGo` closes what this tab holds of the device (the answer to the first
 * message); `leave` runs when the sign-out is over, or after a while if it never is.
 */
export function listenForSignOut(
  letGo: () => Promise<void>,
  leave: () => void,
  platform: TabPlatform = browserTabs,
): () => void {
  if (!platform.locks) return () => {};
  const channel = platform.channel(SESSION_CHANNEL);
  let timer: ReturnType<typeof setTimeout> | undefined;
  channel.onmessage = (event: MessageEvent<SessionMessage>) => {
    const message = event.data;
    if (message.t === 'ending' && message.from !== tabId) {
      timer ??= setTimeout(leave, END_WAIT_MS);
      void letGo()
        .catch(() => {})
        .then(() =>
          channel.postMessage({ t: 'closed', to: message.from } satisfies SessionMessage),
        );
    } else if (message.t === 'ended' && message.from !== tabId) {
      leave();
    }
  };
  return () => {
    clearTimeout(timer);
    channel.close();
  };
}

/** Test helper: forget every claim without touching a lock. */
export function resetTabsForTests() {
  for (const listeners of promotions.values()) listeners.clear();
  promotions.clear();
  claims.clear();
  roles.clear();
  releases.clear();
  for (const controller of waiting.values()) controller.abort();
  waiting.clear();
  joined = false;
  endingChannel = null;
}
