import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHub, type FollowerSink, type MirrorOp } from './mirror.ts';
import type { TabPlatform } from './tabs.ts';

// Two hubs of one workspace in one process stand for two tabs: Node's BroadcastChannel delivers between channel objects.
const platform: TabPlatform = {
  locks: undefined,
  channel: (name) => new BroadcastChannel(name),
};

type Row = { id: string; title: string; n?: number };
const getKey = (row: Record<string, unknown>) => String(row.id);

function sink() {
  const seen = {
    rows: new Map<string, Row>(),
    ready: false,
    snapshots: 0,
  };
  const apply = (ops: MirrorOp[]) => {
    for (const op of ops) {
      if (op.k === 'clear') seen.rows.clear();
      else if (op.k === 'set') seen.rows.set(String(op.row.id), op.row as Row);
      else seen.rows.delete(String(op.key));
    }
  };
  const target: FollowerSink = {
    snapshot: (rows, ready) => {
      seen.snapshots += 1;
      seen.rows.clear();
      apply(rows.map((row): MirrorOp => ({ k: 'set', row })));
      seen.ready = ready;
    },
    ops: apply,
    ready: () => {
      seen.ready = true;
    },
  };
  return { seen, target };
}

const hubs: ReturnType<typeof createHub>[] = [];
async function pair() {
  const leader = createHub('w1', platform);
  const follower = createHub('w1', platform);
  hubs.push(leader, follower);
  const demand = vi.fn(() => vi.fn());
  const awaitTxId = vi.fn(async () => {});
  leader.lead({ demand, awaitTxId });
  // The leader's announcement is on the channel; a follower that asks before it arrives would ask twice.
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { leader, follower, demand, awaitTxId };
}
afterEach(() => {
  for (const hub of hubs.splice(0)) hub.close();
});

describe('mirror', () => {
  it('gives a follower the rows the leader holds, then every change in order', async () => {
    const { leader, follower } = await pair();
    const tap = leader.publish('issues:w1:t1', getKey);
    tap.write({ type: 'insert', value: { id: 'a', title: 'A' } });
    tap.write({ type: 'insert', value: { id: 'b', title: 'B' } });
    tap.commit();
    tap.ready();
    const { seen, target } = sink();
    follower.follow('issues:w1:t1', target);
    await vi.waitFor(() => expect(seen.ready).toBe(true));
    expect([...seen.rows.keys()].sort()).toEqual(['a', 'b']);

    tap.write({ type: 'update', value: { id: 'a', title: 'A2' } });
    tap.write({ type: 'delete', value: { id: 'b', title: 'B' } });
    tap.write({ type: 'insert', value: { id: 'c', title: 'C' } });
    tap.commit();
    await vi.waitFor(() => expect([...seen.rows.keys()].sort()).toEqual(['a', 'c']));
    expect(seen.rows.get('a')?.title).toBe('A2');
    expect(seen.snapshots).toBe(1);
  });

  it('completes a partial update with the columns the leader already holds', async () => {
    const { leader, follower } = await pair();
    const tap = leader.publish('issues:w1:t1', getKey);
    tap.write({ type: 'insert', value: { id: 'a', title: 'A', n: 1 } });
    tap.commit();
    tap.ready();
    const { seen, target } = sink();
    follower.follow('issues:w1:t1', target);
    await vi.waitFor(() => expect(seen.ready).toBe(true));
    tap.write({ type: 'update', value: { id: 'a', title: 'A2' } });
    tap.commit();
    await vi.waitFor(() => expect(seen.rows.get('a')?.title).toBe('A2'));
    expect(seen.rows.get('a')?.n).toBe(1);
  });

  it('a truncate empties the follower in the same step as the rows that follow', async () => {
    const { leader, follower } = await pair();
    const tap = leader.publish('issues:w1:t1', getKey);
    tap.write({ type: 'insert', value: { id: 'a', title: 'A' } });
    tap.commit();
    tap.ready();
    const { seen, target } = sink();
    follower.follow('issues:w1:t1', target);
    await vi.waitFor(() => expect(seen.rows.size).toBe(1));
    tap.truncate();
    tap.write({ type: 'insert', value: { id: 'z', title: 'Z' } });
    tap.commit();
    await vi.waitFor(() => expect([...seen.rows.keys()]).toEqual(['z']));
  });

  it('asks again when the leader starts the shape over (a new instance, other rows)', async () => {
    const { leader, follower } = await pair();
    const first = leader.publish('issues:w1:t1', getKey);
    first.write({ type: 'insert', value: { id: 'old', title: 'Old' } });
    first.commit();
    first.ready();
    const { seen, target } = sink();
    follower.follow('issues:w1:t1', target);
    await vi.waitFor(() => expect(seen.rows.has('old')).toBe(true));

    first.end();
    const second = leader.publish('issues:w1:t1', getKey);
    second.write({ type: 'insert', value: { id: 'new', title: 'New' } });
    second.commit();
    await vi.waitFor(() => expect([...seen.rows.keys()]).toEqual(['new']));
    expect(seen.snapshots).toBe(2);
  });

  it('keeps a shape open for the leader while a follower reads it, once per follower, and lets go on bye', async () => {
    const { follower, demand } = await pair();
    const release = vi.fn();
    demand.mockReturnValue(release);
    const stop = follower.follow('issues:w1:t1', sink().target);
    const stopAgain = follower.follow('issues:w1:t1', sink().target);
    await vi.waitFor(() => expect(demand).toHaveBeenCalledWith('issues:w1:t1'));
    expect(demand).toHaveBeenCalledTimes(1);
    stop();
    // Another reader of the same shape in this tab: still wanted.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(release).not.toHaveBeenCalled();
    stopAgain();
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
  });

  it('asks the leader to wait for the txid of a write, and says when it did not come', async () => {
    const { follower, awaitTxId } = await pair();
    await expect(follower.awaitTxId('issues:w1:t1', 42, 500)).resolves.toBe(true);
    expect(awaitTxId).toHaveBeenCalledWith('issues:w1:t1', 42, 500);
    awaitTxId.mockRejectedValueOnce(new Error('timeout'));
    await expect(follower.awaitTxId('issues:w1:t1', 43, 500)).resolves.toBe(false);
  });

  it('a follower that asked before any leader answered gets its rows when one comes', async () => {
    const leader = createHub('w2', platform);
    const follower = createHub('w2', platform);
    hubs.push(leader, follower);
    const { seen, target } = sink();
    follower.follow('teams:w2', target);
    const tap = leader.publish('teams:w2', getKey);
    tap.write({ type: 'insert', value: { id: 't', title: 'T' } });
    tap.commit();
    tap.ready();
    leader.lead({ demand: () => () => {}, awaitTxId: async () => {} });
    await vi.waitFor(() => expect(seen.ready).toBe(true));
    expect([...seen.rows.keys()]).toEqual(['t']);
  });
});
