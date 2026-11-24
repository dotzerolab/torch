// Keeps the device copy of a COLD shape honest after its first copy (see `persisted` in collections.ts). The live instance
// lives in memory and the copy is a headless instance that ends once written, so a row the server removes later (access
// revoked, an issue deleted) would stay on the device and be the first thing the next visit shows. The follower watches
// the live key set at every answer of the server and asks for another pass of the copy ("refresh") when a row left or the
// shape was truncated (a must-refetch). A refresh runs the same headless instance over the populated store: the library
// itself applies the server's deletes to it, and an ordinary delete resumes from the stored offset.
//
// One job at a time per shape: while one runs a further request only marks that one more pass is due.

export type DeviceFollowerDeps = {
  /** The key set of the live instance, current when the shape has just settled. */
  keys: () => Iterable<string | number>;
  /** Queues the first copy; resolves when it ended. */
  copy: () => Promise<void>;
  /** Queues a refresh pass; resolves when it ended. */
  refresh: () => Promise<void>;
  /** The follower was cancelled: end the job that is running. */
  onCancel?: () => void;
};

export function createDeviceFollower(deps: DeviceFollowerDeps) {
  let known: Set<string> | null = null;
  let truncated = false;
  let cancelled = false;
  let running = false;
  let pending = false;

  function run(job: () => Promise<void>) {
    if (cancelled) return;
    if (running) {
      pending = true;
      return;
    }
    running = true;
    const done = () => {
      running = false;
      if (pending && !cancelled) {
        pending = false;
        run(deps.refresh);
      }
    };
    // A failed pass must not wedge the follower: the next change asks again.
    job().then(done, done);
  }

  return {
    /** The shape applied an answer of the server (every `up-to-date`). The first one starts the first copy. */
    settled() {
      if (cancelled) return;
      const now = new Set(Array.from(deps.keys(), String));
      if (known === null) {
        known = now;
        truncated = false;
        run(deps.copy);
        return;
      }
      let left = false;
      for (const key of known) {
        if (!now.has(key)) {
          left = true;
          break;
        }
      }
      known = now;
      const wasTruncated = truncated;
      truncated = false;
      if (left || wasTruncated) run(deps.refresh);
    },
    /** The shape started over (`must-refetch`); what it holds after the next answer replaces everything. */
    truncated() {
      if (!cancelled && known !== null) truncated = true;
    },
    /** The instance ended (restart, drop, pause): no job starts or continues for it. */
    cancel() {
      cancelled = true;
      pending = false;
      deps.onCancel?.();
    },
    get cancelled() {
      return cancelled;
    },
  };
}
