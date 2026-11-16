// Pins what the pinned `@tanstack/db` does with `subscribeChanges`, because the access watcher and the device copy used
// to rest on a wrong reading of it. A subscription reports the inserts that come after it and the deletes of rows it has
// itself seen; a row that was already in the collection when it subscribed (every row of the first sync) never reports
// its delete or its truncate. The watcher therefore reads key sets when a shape settles instead (membership.ts). When
// this file fails after an upgrade, the library changed: re-check that decision.
import { createCollection } from '@tanstack/react-db';
import { describe, expect, it } from 'vitest';

type Row = { id: string };

function manualCollection() {
  let controls!: {
    begin(): void;
    write(message: { type: 'insert' | 'delete'; value: Row }): void;
    commit(): void;
    markReady(): void;
    truncate(): void;
  };
  const collection = createCollection<Row, string>({
    id: `pin-${Math.random().toString(36).slice(2)}`,
    getKey: (row) => row.id,
    sync: {
      sync: (params) => {
        controls = params as unknown as typeof controls;
      },
    },
    startSync: true,
  });
  const apply = (...messages: Array<{ type: 'insert' | 'delete'; id: string }>) => {
    controls.begin();
    for (const { type, id } of messages) controls.write({ type, value: { id } });
    controls.commit();
  };
  return { collection, controls: () => controls, apply };
}

const later = () => new Promise<void>((resolve) => setTimeout(resolve, 60));

describe('subscribeChanges (pinned library behaviour)', () => {
  it('reports a later insert and its delete, but never the delete of rows present at subscribe time', async () => {
    const { collection, controls, apply } = manualCollection();
    apply({ type: 'insert', id: 'a' }, { type: 'insert', id: 'b' });
    controls().markReady();
    const seen: string[] = [];
    collection.subscribeChanges((changes) => {
      for (const change of changes) seen.push(`${change.type}:${change.key}`);
    });

    apply({ type: 'insert', id: 'c' });
    await later();
    apply({ type: 'delete', id: 'a' }, { type: 'delete', id: 'b' }, { type: 'delete', id: 'c' });
    await later();

    expect(seen).toEqual(['insert:c', 'delete:c']);
    expect([...collection.keys()]).toEqual([]);
  });

  it('reports nothing for the rows a truncate removes', async () => {
    const { collection, controls, apply } = manualCollection();
    apply({ type: 'insert', id: 'a' }, { type: 'insert', id: 'b' });
    controls().markReady();
    const seen: string[] = [];
    collection.subscribeChanges((changes) => {
      for (const change of changes) seen.push(`${change.type}:${change.key}`);
    });

    controls().begin();
    controls().truncate();
    controls().commit();
    await later();

    expect(seen).toEqual([]);
    expect([...collection.keys()]).toEqual([]);
  });

  it('has the new key set the moment the sync calls markReady after its commit', () => {
    const { collection, controls, apply } = manualCollection();
    apply({ type: 'insert', id: 'a' }, { type: 'insert', id: 'b' });
    controls().markReady();
    apply({ type: 'delete', id: 'a' });
    controls().markReady();
    expect([...collection.keys()]).toEqual(['b']);
  });
});
