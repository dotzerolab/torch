// What the leader tab of a workspace tells the follower tabs (see `tabs.ts`). A follower collection opens no request: it
// asks the leader for the rows of a shape (`hello`), gets them in one message, then every change the leader applies to
// its own collection, in order. The leader keeps the shape open while a follower reads it (`demand`), and a follower
// that writes asks the leader to wait for the write's `txid` (the leader owns the stream that brings it back).
//
// The tap sits on the OUTSIDE of the collection's sync (after the persistence layer), so it sees what the collection
// really received: rows read back from the device, the server's changes, and truncates alike.
import { syncWriteNamesWholeRow } from '@tanstack/react-db';
import { browserTabs, liveTabs, type TabPlatform, tabId } from './tabs.ts';

type Row = Record<string, unknown>;
type Key = string | number;

/** One change to the rows of a shape, as the follower applies it. */
export type MirrorOp = { k: 'set'; row: Row } | { k: 'del'; key: Key } | { k: 'clear' };

type Message =
  | { t: 'hello'; shape: string; tab: string }
  | { t: 'bye'; shape: string; tab: string }
  | { t: 'await'; id: string; shape: string; txid: number; timeoutMs: number }
  | { t: 'awaited'; id: string; ok: boolean }
  | { t: 'epoch'; shape: string; epoch: string }
  | {
      t: 'snapshot';
      shape: string;
      to: string;
      epoch: string;
      seq: number;
      rows: Row[];
      ready: boolean;
    }
  | { t: 'ops'; shape: string; epoch: string; seq: number; ops: MirrorOp[] }
  | { t: 'ready'; shape: string; epoch: string; seq: number }
  | { t: 'leader' };

/** How often a follower asks again while no answer came (the leader may still be opening its store). */
const HELLO_RETRY_MS = 1000;
/** How often the leader looks for followers whose tab is gone. */
const PRUNE_EVERY_MS = 5000;

/** What a follower collection implements. */
export type FollowerSink = {
  /** All the rows of the shape, replacing whatever was there; `ready` when the leader's shape is up to date. */
  snapshot(rows: Row[], ready: boolean): void;
  ops(ops: MirrorOp[]): void;
  ready(): void;
};

/** What the leader provides: the shapes a follower reads must stay open, and a write's txid must be awaited. */
export type LeaderHandlers = {
  /** Keeps the shape open (and starts it); returns the release. Called once per follower tab and shape. */
  demand(shape: string): () => void;
  awaitTxId(shape: string, txid: number, timeoutMs: number): Promise<unknown>;
};

/** What the leader's tap of one shape instance does. */
export type Publisher = {
  write(message: { type: string; key?: Key; value?: Row; [name: symbol]: unknown }): void;
  truncate(): void;
  commit(): void;
  ready(): void;
  end(): void;
};

type PublisherState = {
  epoch: string;
  seq: number;
  rows: Map<Key, Row>;
  ready: boolean;
};

export function createHub(workspaceId: string, platform: TabPlatform = browserTabs) {
  const channel = platform.channel(`sync:${workspaceId}`);
  // ---- leader
  let handlers: LeaderHandlers | null = null;
  const publishers = new Map<string, PublisherState>();
  // Per shape: the follower tabs that read it, and the release of the leader's own hold on it.
  const demand = new Map<string, { tabs: Set<string>; release: () => void }>();
  let pruneTimer: ReturnType<typeof setInterval> | undefined;
  // ---- follower
  type Follow = {
    shape: string;
    sink: FollowerSink;
    epoch: string | null;
    seq: number;
    retry?: ReturnType<typeof setInterval>;
  };
  const follows = new Set<Follow>();
  const pending = new Map<
    string,
    { resolve: (ok: boolean) => void; timer: ReturnType<typeof setTimeout> }
  >();

  const post = (message: Message) => {
    try {
      channel.postMessage(message);
    } catch {
      // A row that cannot be cloned or a closed channel: the follower asks again.
    }
  };

  function snapshotFor(shape: string, to: string) {
    const state = publishers.get(shape);
    if (!state) return;
    post({
      t: 'snapshot',
      shape,
      to,
      epoch: state.epoch,
      seq: state.seq,
      rows: [...state.rows.values()],
      ready: state.ready,
    });
  }

  function release(shape: string, tab: string) {
    const entry = demand.get(shape);
    if (!entry) return;
    entry.tabs.delete(tab);
    if (entry.tabs.size === 0) {
      demand.delete(shape);
      entry.release();
    }
    if (demand.size === 0) {
      clearInterval(pruneTimer);
      pruneTimer = undefined;
    }
  }

  async function prune() {
    const alive = await liveTabs(platform);
    if (!alive) return;
    for (const [shape, entry] of [...demand]) {
      for (const tab of [...entry.tabs]) if (!alive.has(tab)) release(shape, tab);
    }
  }

  function onLeaderMessage(message: Message) {
    if (!handlers) return;
    if (message.t === 'hello') {
      let entry = demand.get(message.shape);
      if (!entry) {
        entry = { tabs: new Set(), release: handlers.demand(message.shape) };
        demand.set(message.shape, entry);
        pruneTimer ??= setInterval(() => void prune(), PRUNE_EVERY_MS);
      }
      entry.tabs.add(message.tab);
      snapshotFor(message.shape, message.tab);
    } else if (message.t === 'bye') {
      release(message.shape, message.tab);
    } else if (message.t === 'await') {
      const { id } = message;
      handlers.awaitTxId(message.shape, message.txid, message.timeoutMs).then(
        () => post({ t: 'awaited', id, ok: true }),
        () => post({ t: 'awaited', id, ok: false }),
      );
    }
  }

  /** Asks the leader for the rows of the shape, and again every second until they came. */
  function ask(follow: Follow) {
    follow.epoch = null;
    post({ t: 'hello', shape: follow.shape, tab: tabId });
    follow.retry ??= setInterval(
      () => post({ t: 'hello', shape: follow.shape, tab: tabId }),
      HELLO_RETRY_MS,
    );
  }

  function onFollowerMessage(message: Message) {
    if (message.t === 'awaited') {
      const waiter = pending.get(message.id);
      if (waiter) {
        clearTimeout(waiter.timer);
        pending.delete(message.id);
        waiter.resolve(message.ok);
      }
      return;
    }
    if (message.t === 'leader') {
      // A new leader: whatever the old one told is over, ask again.
      for (const follow of follows) ask(follow);
      return;
    }
    for (const follow of [...follows]) {
      if (!('shape' in message) || follow.shape !== message.shape) continue;
      if (message.t === 'hello' || message.t === 'bye' || message.t === 'await') continue;
      if (message.t === 'epoch') {
        // The leader started the shape over: its rows may differ, ask for them.
        // (A follower that is still waiting for its rows asks anyway.)
        if (follow.epoch !== null && message.epoch !== follow.epoch) ask(follow);
      } else if (message.t === 'snapshot') {
        if (message.to !== tabId) continue;
        follow.epoch = message.epoch;
        follow.seq = message.seq;
        clearInterval(follow.retry);
        follow.retry = undefined;
        follow.sink.snapshot(message.rows, message.ready);
      } else if (follow.epoch === null) {
        // Waiting for the rows: the retry is running.
      } else if (message.epoch !== follow.epoch || message.seq > follow.seq + 1) {
        // Changes of an instance this follower never got the rows of, or one went missing: ask for the rows again.
        ask(follow);
      } else if (message.seq > follow.seq) {
        follow.seq = message.seq;
        if (message.t === 'ops') follow.sink.ops(message.ops);
        else follow.sink.ready();
      }
    }
  }

  channel.onmessage = (event: MessageEvent<Message>) => {
    onLeaderMessage(event.data);
    onFollowerMessage(event.data);
  };

  return {
    /** This tab leads the workspace: it answers followers. Tells them, so those that waited ask again. */
    lead(next: LeaderHandlers) {
      handlers = next;
      post({ t: 'leader' });
    },

    /** This tab stops answering (sign-out): the shapes it kept open for followers are released. */
    stopLeading() {
      handlers = null;
      for (const [shape, entry] of demand) {
        demand.delete(shape);
        entry.release();
      }
      clearInterval(pruneTimer);
      pruneTimer = undefined;
    },

    /**
     * The leader's tap on one instance of a shape. `getKey` names a row. A new instance announces itself, so followers of
     * the one it replaces ask for its rows.
     */
    publish(shape: string, getKey: (row: Row) => Key): Publisher {
      const state: PublisherState = {
        epoch: `${tabId}:${crypto.randomUUID()}`,
        seq: 0,
        rows: new Map(),
        ready: false,
      };
      publishers.set(shape, state);
      post({ t: 'epoch', shape, epoch: state.epoch });
      let buffer: MirrorOp[] = [];
      const send = () => {
        if (buffer.length === 0) return;
        state.seq += 1;
        const ops = buffer;
        buffer = [];
        post({ t: 'ops', shape, epoch: state.epoch, seq: state.seq, ops });
      };
      return {
        write(message) {
          const key = message.key ?? (message.value ? getKey(message.value) : undefined);
          if (key === undefined) return;
          if (message.type === 'delete') {
            state.rows.delete(key);
            buffer.push({ k: 'del', key });
            return;
          }
          if (!message.value) return;
          // A partial update names only the columns that changed; a whole row replaces the old one.
          const whole = message.type === 'insert' || message[syncWriteNamesWholeRow] === true;
          const row = whole ? { ...message.value } : { ...state.rows.get(key), ...message.value };
          state.rows.set(key, row);
          buffer.push({ k: 'set', row });
        },
        truncate() {
          state.rows.clear();
          buffer = [{ k: 'clear' }];
        },
        commit: send,
        ready() {
          send();
          state.ready = true;
          state.seq += 1;
          post({ t: 'ready', shape, epoch: state.epoch, seq: state.seq });
        },
        end() {
          if (publishers.get(shape) === state) publishers.delete(shape);
        },
      };
    },

    /**
     * A follower collection reads `shape`. Asks the leader until it answers; `sink` gets the rows, then every change.
     * Returns the stop.
     */
    follow(shape: string, sink: FollowerSink): () => void {
      const follow: Follow = { shape, sink, epoch: null, seq: 0 };
      follows.add(follow);
      ask(follow);
      return () => {
        clearInterval(follow.retry);
        follows.delete(follow);
        if (![...follows].some((other) => other.shape === shape))
          post({ t: 'bye', shape, tab: tabId });
      };
    },

    /** Asks the leader to wait for the write with this txid on `shape`; false when it did not come in time. */
    awaitTxId(shape: string, txid: number, timeoutMs: number): Promise<boolean> {
      const id = crypto.randomUUID();
      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve(false);
        }, timeoutMs + 1000);
        pending.set(id, { resolve, timer });
        post({ t: 'await', id, shape, txid, timeoutMs });
      });
    },

    close() {
      this.stopLeading();
      for (const follow of follows) clearInterval(follow.retry);
      follows.clear();
      for (const waiter of pending.values()) clearTimeout(waiter.timer);
      pending.clear();
      channel.close();
    },
  };
}

export type Hub = ReturnType<typeof createHub>;

const hubs = new Map<string, Hub>();

/** The hub of a workspace in this tab, opened on first use. */
export function hubFor(workspaceId: string, platform: TabPlatform = browserTabs): Hub {
  let hub = hubs.get(workspaceId);
  if (!hub) {
    hub = createHub(workspaceId, platform);
    hubs.set(workspaceId, hub);
  }
  return hub;
}

/** Test helper. */
export function resetHubsForTests() {
  for (const hub of hubs.values()) hub.close();
  hubs.clear();
}
