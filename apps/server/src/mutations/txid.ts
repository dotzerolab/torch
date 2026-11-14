// The Postgres transaction id Electric reports for a transaction's rows; the client waits for it (`awaitTxId`).
import { sql } from 'drizzle-orm';
import type { Tx } from '../db.ts';

/** Id of the current transaction as a number, to be returned from the same transaction that wrote the rows. */
export async function currentTxid(tx: Tx): Promise<number> {
  const { rows } = await tx.execute<{ txid: string }>(
    sql`select pg_current_xact_id()::xid::text as txid`,
  );
  return Number(rows[0]?.txid);
}
