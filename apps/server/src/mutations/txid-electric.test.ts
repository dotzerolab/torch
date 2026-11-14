// The contract the web client relies on (ADR 0001 section 1): the txid the mutation answers is the txid Electric
// reports on the change message of the same write, so `awaitTxId` can confirm it. Needs a running Electric,
// which reads the dev database (`torch`) itself: the fixture is created there and removed afterwards.
import type { Brand } from '@torch/shared/brand';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.ts';
import { createDb } from '../db.ts';
import { createWorkspaceFixture } from '../test/fixtures.ts';
import {
  headerActorResolver,
  TEST_APP_CONFIG,
  TEST_MEMBER_HEADER,
  TEST_ORIGIN,
} from '../test/header-actor-resolver.ts';

const databaseUrl = process.env.DATABASE_URL;
const electricUrl = process.env.ELECTRIC_URL;

if (!databaseUrl || !electricUrl) {
  console.warn(
    '[txid-electric.test] SKIPPED the awaitTxId contract test: DATABASE_URL and ELECTRIC_URL are not both set. ' +
      'Start `docker compose -f docker-compose.dev.yml up -d --wait postgres electric` (see .env.example).',
  );
}

const brand: Brand = {
  productName: 'Acme Tasks',
  logoLight: '/acme/logo-light.svg',
  logoDark: '/acme/logo-dark.svg',
  favicon: '/acme/favicon.svg',
  accentColor: '#3366ff',
  emailSenderName: 'Acme Tasks',
  emailSenderAddress: 'no-reply@acme.example',
};

type Message = {
  value?: Record<string, unknown>;
  headers: { operation?: string; txids?: number[] };
};

describe.skipIf(!databaseUrl || !electricUrl)('mutation txid and Electric', () => {
  it('Electric reports the mutation txid on the live change of that issue', async () => {
    const db = createDb(databaseUrl as string);
    const f = await createWorkspaceFixture(db.orm);
    try {
      const auth = headerActorResolver(db.orm);
      const app = createApp({
        brand,
        db,
        electric: {
          url: electricUrl as string,
          secret: process.env.ELECTRIC_SECRET ?? 'dev-electric-secret',
        },
        auth,
        config: TEST_APP_CONFIG,
      });
      const who = { [TEST_MEMBER_HEADER]: f.members.member.id };
      const target = f.issues.eng[0];
      if (!target) throw new Error('fixture has no issue');
      const shape = `http://localhost/api/sync/w/${f.workspaceId}/teams/${f.teams.eng.id}/issues`;

      // 1. Initial snapshot: the handle and offset the live request continues from.
      const initial = await app.fetch(new Request(`${shape}?offset=-1`, { headers: who }));
      expect(initial.status).toBe(200);
      const handle = initial.headers.get('electric-handle');
      const offset = initial.headers.get('electric-offset');
      expect(handle).toBeTruthy();
      expect(offset).toBeTruthy();

      // 2. Start waiting for the next change, then write.
      const live = app.fetch(
        new Request(`${shape}?offset=${offset}&handle=${handle}&live=true`, {
          headers: who,
          signal: AbortSignal.timeout(20_000),
        }),
      );
      const write = await app.fetch(
        new Request(`http://localhost/api/w/${f.workspaceId}/issues/${target.id}`, {
          method: 'PATCH',
          headers: { ...who, 'content-type': 'application/json', origin: TEST_ORIGIN },
          body: JSON.stringify({ title: 'Renamed through the mutation' }),
        }),
      );
      expect(write.status).toBe(200);
      const { txid } = (await write.json()) as { txid: number };

      // 3. The change message of that write carries the same txid.
      const liveRes = await live;
      expect(liveRes.status).toBe(200);
      const messages = (await liveRes.json()) as Message[];
      const change = messages.find((m) => m.value?.id === target.id);
      expect(change?.headers.operation).toBe('update');
      expect(change?.value?.title).toBe('Renamed through the mutation');
      expect(change?.headers.txids).toContain(txid);
    } finally {
      for (const table of ['issue', 'workflow_state', 'team_member', 'team', 'member']) {
        await db.pool.query(`delete from ${table} where workspace_id = $1`, [f.workspaceId]);
      }
      await db.pool.query('delete from workspace where id = $1', [f.workspaceId]);
      await db.close();
    }
  }, 30_000);
});
