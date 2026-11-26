// When a screen needs its snapshot shapes (`SNAPSHOT_KINDS` in `registry.ts`) read again. A snapshot holds no connection,
// so nothing tells it that its table changed; these are the moments that do: a screen opening after a while, the page
// coming back online or into focus, this person's own write, and a change of the live `issues` shape of the team (every
// change to labels, relations, links or subscribers moves the issue's `updated_at`, so it is a reliable change feed).
// The refresher (`snapshots.ts`) turns bursts of these into at most one read per shape every few seconds.
import { isTeamKey, type ShapeKey, type ShapeKind, shapeId } from './registry.ts';

/** A change of the issues asks for a snapshot only when it was read this long ago or longer: a fresh read is current. */
export const MIN_REFRESH_GAP_MS = 3000;

/** A screen opening a snapshot that was read this long ago or longer reads it again. */
export const MOUNT_STALE_MS = 60_000;

type Request = (key: ShapeKey, options?: { now?: boolean }) => void;

export type SnapshotWatchOptions = {
  /** `refresher.request`: asks for a read, coalesced per shape. */
  request: Request;
  /** The clock, in ms. */
  now?: () => number;
  /** Where `online` and `focus` arrive: the window. */
  target?: EventTarget;
};

export type OwnWrite = {
  workspaceId: string;
  /** Absent for a write of the workspace itself. */
  teamId?: string;
  /** The snapshot kinds the write can change; all the kinds watched in the scope when absent. */
  kinds?: ShapeKind[];
};

export function createSnapshotWatch({
  request,
  now = () => Date.now(),
  target = typeof window === 'undefined' ? new EventTarget() : window,
}: SnapshotWatchOptions) {
  // The snapshots a screen holds right now, by shape id, with how many screens hold each.
  const held = new Map<string, { key: ShapeKey; readers: number }>();
  // When each snapshot was last read (or asked to be), by shape id.
  const readAt = new Map<string, number>();
  // When a screen first held each snapshot: what the issues do just after that is their first load.
  const opened = new Map<string, number>();

  const each = (visit: (key: ShapeKey) => void) => {
    for (const { key } of [...held.values()]) visit(key);
  };

  const onOnline = () => each((key) => request(key, { now: true }));
  const onFocus = () => each((key) => request(key, { now: false }));
  target.addEventListener('online', onOnline);
  target.addEventListener('focus', onFocus);

  return {
    /**
     * A screen reads this snapshot. It is read again at once when the last read is `MOUNT_STALE_MS` old or older.
     * Returns the function to call when the screen stops reading it.
     */
    mount(key: ShapeKey): () => void {
      const id = shapeId(key);
      const entry = held.get(id) ?? { key, readers: 0 };
      entry.readers += 1;
      held.set(id, entry);
      const last = readAt.get(id);
      if (last === undefined) {
        readAt.set(id, now());
        opened.set(id, now());
      } else if (now() - last >= MOUNT_STALE_MS) {
        readAt.set(id, now());
        request(key, { now: true });
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const current = held.get(id);
        if (!current) return;
        current.readers -= 1;
        if (current.readers <= 0) held.delete(id);
      };
    },

    /** This person wrote something: the held snapshots it can change are read again at once. */
    ownWrite({ workspaceId, teamId, kinds }: OwnWrite) {
      each((key) => {
        if (key.workspaceId !== workspaceId) return;
        const inScope =
          teamId === undefined ? !isTeamKey(key) : isTeamKey(key) && key.teamId === teamId;
        if (!inScope || (kinds && !kinds.includes(key.kind))) return;
        readAt.set(shapeId(key), now());
        request(key, { now: true });
      });
    },

    /** The live `issues` shape of the team changed: the team's held snapshots (its issues' included) are asked for. */
    issuesChanged(workspaceId: string, teamId: string) {
      each((key) => {
        if (key.workspaceId !== workspaceId || !isTeamKey(key) || key.teamId !== teamId) return;
        // The first load of the issues is a stream of changes: the snapshots were read at the same time.
        if (now() - (opened.get(shapeId(key)) ?? 0) < MIN_REFRESH_GAP_MS) return;
        readAt.set(shapeId(key), now());
        request(key, { now: false });
      });
    },

    dispose() {
      target.removeEventListener('online', onOnline);
      target.removeEventListener('focus', onFocus);
      held.clear();
      readAt.clear();
      opened.clear();
    },
  };
}

export type SnapshotWatch = ReturnType<typeof createSnapshotWatch>;
