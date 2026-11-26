// A collection a test fills by hand: the rows it holds, when it is ready, and the changes that follow. For components and
// hooks that read a shape through `useShape`, which a test replaces with one of these.
import { createCollection } from '@tanstack/react-db';

type Controls<Row> = {
  begin(): void;
  write(message: { type: 'insert' | 'update' | 'delete'; value: Row }): void;
  commit(): void;
  markReady(): void;
  truncate(): void;
};

export function manualCollection<Row extends object>(id: string, getKey: (row: Row) => string) {
  let controls!: Controls<Row>;
  const collection = createCollection<Row, string>({
    id,
    getKey,
    sync: {
      sync: (params) => {
        controls = params as unknown as Controls<Row>;
      },
    },
    startSync: true,
  });
  const known = new Set<string>();
  return {
    collection,
    /** Inserts rows that are new and updates those already held. */
    set(...rows: Row[]) {
      controls.begin();
      for (const row of rows) {
        const key = getKey(row);
        controls.write({ type: known.has(key) ? 'update' : 'insert', value: row });
        known.add(key);
      }
      controls.commit();
    },
    remove(...rows: Row[]) {
      controls.begin();
      for (const row of rows) {
        controls.write({ type: 'delete', value: row });
        known.delete(getKey(row));
      }
      controls.commit();
    },
    ready() {
      controls.markReady();
    },
  };
}
