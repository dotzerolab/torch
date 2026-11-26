// The shapes of comments, attachments and documents: what each is allowed to contain, and the proxy routes that serve
// them (a fake Electric, the real database): every route authorises on the STORED parent and answers one 404 for a
// parent that is unknown, malformed, of another workspace or invisible.

import { Shape, ShapeStream } from '@electric-sql/client';
import type { Brand } from '@torch/shared/brand';
import { attachment, comment, document, teamMember } from '@torch/shared/db/schema';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.ts';
import { createComment, deleteComment, editComment } from '../comments/service.ts';
import { createDb, type Db } from '../db.ts';
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
  withTempDatabase,
} from '../test/fixtures.ts';
import {
  headerActorResolver,
  TEST_APP_CONFIG,
  TEST_MEMBER_HEADER,
  TEST_ORIGIN,
} from '../test/header-actor-resolver.ts';
import { actorOf } from '../test/issue-helpers.ts';
import { type AccessBus, createAccessBus } from './access-bus.ts';
import {
  documentContentShape,
  issueAttachmentsShape,
  issueCommentsShape,
  teamDocumentsShape,
} from './shapes.ts';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.warn(
    '[sync/comment-file-shapes.test] SKIPPED the shape proxy tests: DATABASE_URL is not set. ' +
      'Start `docker compose -f docker-compose.dev.yml up -d --wait postgres` and set DATABASE_URL (see .env.example).',
  );
}

const ID = '3f2b8c1e-9d4a-4e6b-8a7c-1b2d3e4f5a6b';

describe('shape definitions', () => {
  it('comments: one issue and its generation, every column of the row that is safe to sync, the text included', () => {
    expect(issueCommentsShape(ID, 3)).toEqual({
      table: 'comment',
      // The second parameter is the generation: always true, but it is part of what Electric calls the shape.
      where: 'issue_id = $1 AND $2::int4 >= 0',
      params: [ID, '3'],
      columns: [
        'id',
        'workspace_id',
        'team_id',
        'issue_id',
        'parent_id',
        'author_id',
        'body',
        'reactions',
        'created_at',
        'edited_at',
        'resolved_at',
        'resolved_by',
        'deleted_at',
      ],
    });
  });

  it('comments: another generation is another shape, the same one is the same shape', () => {
    expect(issueCommentsShape(ID, 0)).toEqual(issueCommentsShape(ID, 0));
    expect(issueCommentsShape(ID, 0).params).not.toEqual(issueCommentsShape(ID, 1).params);
    expect(issueCommentsShape(ID, 0).where).toBe(issueCommentsShape(ID, 1).where);
  });

  it('attachments: ready files of one issue, never the storage key or the status', () => {
    const shape = issueAttachmentsShape(ID);

    expect(shape).toEqual({
      table: 'attachment',
      where: "issue_id = $1 AND status = 'ready'",
      params: [ID],
      columns: [
        'id',
        'workspace_id',
        'team_id',
        'issue_id',
        'uploader_id',
        'file_name',
        'content_type',
        'size_bytes',
        'created_at',
      ],
    });
    expect(shape.columns).not.toContain('storage_key');
    expect(shape.columns).not.toContain('status');
  });

  it('documents of a team: the titles, never the body', () => {
    const shape = teamDocumentsShape(ID);

    expect(shape).toEqual({
      table: 'document',
      where: 'team_id = $1',
      params: [ID],
      columns: [
        'id',
        'workspace_id',
        'team_id',
        'title',
        'created_by',
        'updated_by',
        'created_at',
        'updated_at',
        'archived_at',
      ],
    });
    expect(shape.columns).not.toContain('body');
  });

  it('document content: the body of one document and nothing else', () => {
    expect(documentContentShape(ID)).toEqual({
      table: 'document',
      where: 'id = $1',
      params: [ID],
      columns: ['id', 'workspace_id', 'team_id', 'body'],
    });
  });

  it('every where is a constant template: values travel as parameters only', () => {
    const hostile = `1' OR '1'='1`;
    for (const shape of [
      issueCommentsShape(hostile, 0),
      issueAttachmentsShape(hostile),
      teamDocumentsShape(hostile),
      documentContentShape(hostile),
    ]) {
      expect(shape.where).not.toContain('OR');
      expect(shape.params[0]).toEqual(hostile);
    }
  });
});

// ---- the routes ----

const brand: Brand = {
  productName: 'Acme Tasks',
  logoLight: '/acme/logo-light.svg',
  logoDark: '/acme/logo-dark.svg',
  favicon: '/acme/favicon.svg',
  accentColor: '#3366ff',
  emailSenderName: 'Acme Tasks',
  emailSenderAddress: 'no-reply@acme.example',
};
const UPSTREAM = 'http://electric.test:3000';
const UNKNOWN_UUID = '99999999-9999-4999-8999-999999999999';

type Call = { url: URL; init: RequestInit | undefined };

function fakeUpstream(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchUpstream: typeof fetch = async (input, init) => {
    const call = { url: new URL(input instanceof Request ? input.url : String(input)), init };
    calls.push(call);
    return respond(call);
  };
  return { calls, fetchUpstream };
}
const emptyShape = () =>
  new Response('[{"headers":{"control":"up-to-date"}}]', {
    status: 200,
    headers: { 'content-type': 'application/json', 'electric-handle': 'h-1' },
  });
const sentParams = (call: Call | undefined) =>
  [...(call?.url.searchParams.entries() ?? [])]
    .filter(([name]) => name.startsWith('params['))
    .map(([, value]) => value);

function buildApp(db: Db, fetchUpstream?: typeof fetch, accessBus?: AccessBus) {
  return createApp({
    brand,
    db,
    electric: { url: UPSTREAM, secret: 'TOPSECRET-server-side-value' },
    auth: headerActorResolver(db.orm),
    config: TEST_APP_CONFIG,
    fetchUpstream,
    accessBus,
  });
}
const as = (memberId: string | undefined, init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: { ...(memberId ? { [TEST_MEMBER_HEADER]: memberId } : {}), ...init.headers },
});
const get = (app: ReturnType<typeof createApp>, path: string, init?: RequestInit) =>
  app.fetch(new Request(`http://localhost${path}`, init));

/** A document in each team of the fixture. */
async function seedDocuments(db: Db, f: WorkspaceFixture) {
  const make = async (teamId: string) => {
    const [row] = await db.orm
      .insert(document)
      .values({
        workspaceId: f.workspaceId,
        teamId,
        title: 'Handbook',
        body: 'text',
        createdBy: f.members.owner.id,
        updatedBy: f.members.owner.id,
      })
      .returning({ id: document.id });
    if (!row) throw new Error('document insert returned no row');
    return row.id;
  };
  return { eng: await make(f.teams.eng.id), ops: await make(f.teams.ops.id) };
}

type Docs = { eng: string; ops: string };
type Route = {
  name: string;
  table: string;
  where: string;
  /** Parameters after the parent id (the comments shape adds its generation). */
  extra?: string[];
  columns: string;
  path: (f: WorkspaceFixture, parent: string) => string;
  parent: (f: WorkspaceFixture, docs: Docs, team: 'eng' | 'ops') => string;
};
const base = (f: WorkspaceFixture) => `/api/sync/w/${f.workspaceId}`;
const ROUTES: Route[] = [
  {
    name: 'issue comments',
    table: 'comment',
    where: 'issue_id = $1 AND $2::int4 >= 0',
    extra: ['0'],
    columns: issueCommentsShape(ID, 0).columns.join(','),
    path: (f, id) => `${base(f)}/issues/${id}/comments`,
    parent: (f, _docs, team) => f.issues[team][0]?.id as string,
  },
  {
    name: 'issue attachments',
    table: 'attachment',
    where: "issue_id = $1 AND status = 'ready'",
    columns: issueAttachmentsShape(ID).columns.join(','),
    path: (f, id) => `${base(f)}/issues/${id}/attachments`,
    parent: (f, _docs, team) => f.issues[team][0]?.id as string,
  },
  {
    name: 'team documents',
    table: 'document',
    where: 'team_id = $1',
    columns: teamDocumentsShape(ID).columns.join(','),
    path: (f, id) => `${base(f)}/teams/${id}/documents`,
    parent: (f, _docs, team) => f.teams[team].id,
  },
  {
    name: 'document content',
    table: 'document',
    where: 'id = $1',
    columns: documentContentShape(ID).columns.join(','),
    path: (f, id) => `${base(f)}/documents/${id}/content`,
    parent: (_f, docs, team) => docs[team],
  },
];

describe.skipIf(!databaseUrl)(
  'GET /api/sync comments, attachments and documents (fake Electric)',
  () => {
    it('a visible parent is served with params[1] = its stored id', async () => {
      await withTempDatabase(async (db) => {
        const f = await createWorkspaceFixture(db.orm);
        const docs = await seedDocuments(db, f);
        const upstream = fakeUpstream(emptyShape);
        const app = buildApp(db, upstream.fetchUpstream);

        for (const route of ROUTES) {
          for (const [who, team] of [
            ['guest', 'eng'],
            ['member', 'ops'],
            ['owner', 'ops'],
          ] as const) {
            upstream.calls.length = 0;
            const parent = route.parent(f, docs, team);

            const res = await get(app, `${route.path(f, parent)}?offset=-1`, as(f.members[who].id));

            expect(res.status, `${route.name} ${who} ${team}`).toBe(200);
            const q = upstream.calls[0]?.url.searchParams;
            expect(q?.get('table')).toBe(route.table);
            expect(q?.get('where')).toBe(route.where);
            expect(sentParams(upstream.calls[0])).toEqual([parent, ...(route.extra ?? [])]);
            expect(q?.get('columns')).toBe(route.columns);
            expect(q?.get('secret')).toBe('TOPSECRET-server-side-value');
            expect(res.headers.get('cache-control')).toBe('private, no-cache');
          }
        }
      });
    });

    it('the comments shape carries the number of deleted comments of the issue as its generation', async () => {
      await withTempDatabase(async (db) => {
        const f = await createWorkspaceFixture(db.orm);
        const target = f.issues.eng[0];
        if (!target) throw new Error('fixture issue missing');
        const other = f.issues.eng[1] ?? f.issues.ops[0];
        if (!other) throw new Error('fixture has no second issue');
        const upstream = fakeUpstream(emptyShape);
        const app = buildApp(db, upstream.fetchUpstream);
        const author = await actorOf(db, f, 'member');
        const make = async (issueId: string) => {
          const created = await createComment(db.orm, author, issueId, { body: 'text' });
          if (!created.ok) throw new Error(`refused ${created.code}`);
          return created.value.id;
        };
        const generation = async () => {
          upstream.calls.length = 0;
          await get(
            app,
            `${base(f)}/issues/${target.id}/comments?offset=-1`,
            as(f.members.owner.id),
          );
          return sentParams(upstream.calls[0]).slice(1);
        };
        const first = await make(target.id);
        const second = await make(target.id);
        const elsewhere = await make(other.id);

        const none = await generation();
        await deleteComment(db.orm, author, first);
        const one = await generation();
        await deleteComment(db.orm, author, first);
        const stillOne = await generation();
        await deleteComment(db.orm, author, second);
        const two = await generation();
        await deleteComment(db.orm, author, elsewhere);
        const unmoved = await generation();

        expect([none, one, stillOne, two, unmoved]).toEqual([['0'], ['1'], ['1'], ['2'], ['2']]);
      });
    });

    it('hidden team: a private-team parent answers 404 for the admin outside it, the guest and the outsider', async () => {
      await withTempDatabase(async (db) => {
        const f = await createWorkspaceFixture(db.orm);
        const docs = await seedDocuments(db, f);
        const upstream = fakeUpstream(emptyShape);
        const app = buildApp(db, upstream.fetchUpstream);
        const body = JSON.stringify({ error: 'not_found' });

        for (const route of ROUTES) {
          for (const who of ['admin', 'guest', 'outsider'] as const) {
            const res = await get(
              app,
              `${route.path(f, route.parent(f, docs, 'ops'))}?offset=-1`,
              as(f.members[who].id),
            );

            expect(res.status, `${route.name} ${who}`).toBe(404);
            expect(await res.text(), `${route.name} ${who}`).toBe(body);
          }
        }
        expect(upstream.calls).toHaveLength(0);
      });
    });

    it('an unknown, foreign, malformed or upper-case parent answers the same 404 and Electric is not called; no session is 401', async () => {
      await withTempDatabase(async (db) => {
        const f = await createWorkspaceFixture(db.orm);
        const other = await createWorkspaceFixture(db.orm);
        const docs = await seedDocuments(db, f);
        const otherDocs = await seedDocuments(db, other);
        const upstream = fakeUpstream(emptyShape);
        const app = buildApp(db, upstream.fetchUpstream);
        const body = JSON.stringify({ error: 'not_found' });

        for (const route of ROUTES) {
          const own = route.parent(f, docs, 'eng');
          const attempts: [string, string][] = [
            ['unknown', UNKNOWN_UUID],
            ['foreign', route.parent(other, otherDocs, 'eng')],
            ['malformed', 'not-a-uuid'],
            ['upper-case', own.toUpperCase()],
          ];
          for (const [what, parent] of attempts) {
            const res = await get(
              app,
              `${route.path(f, parent)}?offset=-1`,
              as(f.members.owner.id),
            );

            expect(res.status, `${route.name} ${what}`).toBe(404);
            expect(await res.text(), `${route.name} ${what}`).toBe(body);
          }
          const anonymous = await get(app, route.path(f, own));
          expect(anonymous.status, route.name).toBe(401);
          const foreignSession = await get(app, route.path(f, own), as(other.members.owner.id));
          expect(foreignSession.status, route.name).toBe(401);
        }
        expect(upstream.calls).toHaveLength(0);
      });
    });

    it('only GET is served', async () => {
      await withTempDatabase(async (db) => {
        const f = await createWorkspaceFixture(db.orm);
        const docs = await seedDocuments(db, f);
        const upstream = fakeUpstream(emptyShape);
        const app = buildApp(db, upstream.fetchUpstream);

        for (const route of ROUTES) {
          const path = route.path(f, route.parent(f, docs, 'eng'));
          for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
            const res = await get(app, path, {
              method,
              headers: { [TEST_MEMBER_HEADER]: f.members.owner.id, origin: TEST_ORIGIN },
            });
            expect(res.status, `${method} ${route.name}`).toBeGreaterThanOrEqual(404);
            expect(res.status, `${method} ${route.name}`).toBeLessThan(500);
          }
          const head = await get(app, path, as(f.members.owner.id, { method: 'HEAD' }));
          expect(head.status, `HEAD ${route.name}`).toBe(405);
        }
        expect(upstream.calls).toHaveLength(0);
      });
    });

    it('only the protocol query parameters reach Electric', async () => {
      await withTempDatabase(async (db) => {
        const f = await createWorkspaceFixture(db.orm);
        const docs = await seedDocuments(db, f);
        const upstream = fakeUpstream(emptyShape);
        const app = buildApp(db, upstream.fetchUpstream);

        for (const route of ROUTES) {
          upstream.calls.length = 0;
          const path = route.path(f, route.parent(f, docs, 'eng'));

          await get(
            app,
            `${path}?offset=5_1&handle=h-1&where=true&table=member&columns=email&subset__where=1%3D1&params[1]=x`,
            as(f.members.owner.id),
          );

          const q = upstream.calls[0]?.url.searchParams;
          expect(q?.get('table')).toBe(route.table);
          expect(q?.get('where')).toBe(route.where);
          expect(q?.get('columns')).toBe(route.columns);
          expect(q?.get('offset')).toBe('5_1');
          expect(q?.get('handle')).toBe('h-1');
          expect(q?.has('subset__where')).toBe(false);
          expect(sentParams(upstream.calls[0])).toEqual([
            route.parent(f, docs, 'eng'),
            ...(route.extra ?? []),
          ]);
        }
      });
    });

    it('a guest who joins the private team reads its comment shape, and loses it on removal', async () => {
      await withTempDatabase(async (db) => {
        const f = await createWorkspaceFixture(db.orm);
        const upstream = fakeUpstream(emptyShape);
        const app = buildApp(db, upstream.fetchUpstream);
        const path = `${base(f)}/issues/${f.issues.ops[0]?.id}/comments?offset=-1`;

        expect((await get(app, path, as(f.members.guest.id))).status).toBe(404);
        await db.orm.insert(teamMember).values({
          workspaceId: f.workspaceId,
          teamId: f.teams.ops.id,
          memberId: f.members.guest.id,
        });
        expect((await get(app, path, as(f.members.guest.id))).status).toBe(200);
        await db.orm
          .delete(teamMember)
          .where(
            and(eq(teamMember.teamId, f.teams.ops.id), eq(teamMember.memberId, f.members.guest.id)),
          );
        expect((await get(app, path, as(f.members.guest.id))).status).toBe(404);
      });
    });

    it('membership change ends an open comments shape', async () => {
      await withTempDatabase(async (db) => {
        const f = await createWorkspaceFixture(db.orm);
        const bus = createAccessBus();
        const hanging = fakeUpstream(
          (call) =>
            new Promise<Response>((_resolve, reject) => {
              call.init?.signal?.addEventListener('abort', () =>
                reject(new DOMException('aborted', 'AbortError')),
              );
            }),
        );
        const app = buildApp(db, hanging.fetchUpstream, bus);
        const path = `${base(f)}/issues/${f.issues.eng[0]?.id}/comments?offset=5_1&handle=h-1&cursor=77&live=true`;

        const pending = get(app, path, as(f.members.member.id));
        await vi.waitFor(() => expect(bus.tracked()).toBe(1));
        bus.accessChanged(f.workspaceId, [f.members.member.id]);
        const res = await pending;

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual([{ headers: { control: 'up-to-date' } }]);
        expect(res.headers.get('electric-handle')).toBe('h-1');
        expect(bus.tracked()).toBe(0);
      });
    });
  },
);

// ---- the real Electric of the dev compose: the new tables replicate and the column lists hold ----

const electricUrl = process.env.ELECTRIC_URL;
const electricSecret = process.env.ELECTRIC_SECRET ?? 'dev-electric-secret';

if (!electricUrl) {
  console.warn(
    '[sync/comment-file-shapes.test] SKIPPED the real-Electric tests: ELECTRIC_URL is not set. ' +
      'Start `docker compose -f docker-compose.dev.yml up -d --wait electric` and set ELECTRIC_URL (see .env.example).',
  );
}

describe.skipIf(!databaseUrl || !electricUrl)(
  'GET /api/sync comments, attachments and documents (real Electric)',
  () => {
    type Message = { value?: Record<string, unknown>; headers: Record<string, unknown> };

    async function withDevWorkspace(fn: (db: Db, f: WorkspaceFixture) => Promise<void>) {
      const db = createDb(databaseUrl as string);
      const f = await createWorkspaceFixture(db.orm);
      try {
        await fn(db, f);
      } finally {
        const where = 'where workspace_id = $1';
        for (const table of [
          'event',
          'comment',
          'attachment',
          'document',
          'issue',
          'workflow_state',
          'team_member',
          'team',
          'member',
        ]) {
          await db.pool.query(`delete from ${table} ${where}`, [f.workspaceId]);
        }
        await db.pool.query('delete from workspace where id = $1', [f.workspaceId]);
        await db.close();
      }
    }

    async function rows(res: Response): Promise<Record<string, unknown>[]> {
      expect(res.status).toBe(200);
      const messages = (await res.json()) as Message[];
      return messages.filter((m) => m.value).map((m) => m.value as Record<string, unknown>);
    }

    /** Everything a reader that starts from nothing is sent: the pages up to the first up-to-date, as raw text. */
    async function readFromNothing(app: ReturnType<typeof createApp>, path: string, who: string) {
      let offset = '-1';
      let handle: string | null = null;
      let text = '';
      for (let page = 0; page < 20; page++) {
        const query = new URLSearchParams({ offset });
        if (handle) query.set('handle', handle);
        const res = await get(app, `${path}?${query}`, as(who));
        expect(res.status, await res.clone().text()).toBe(200);
        text += await res.text();
        handle = res.headers.get('electric-handle');
        offset = res.headers.get('electric-offset') ?? offset;
        if (res.headers.has('electric-up-to-date')) return { text, handle, offset };
      }
      throw new Error('the shape never reached up-to-date');
    }

    it('after a comment is deleted no reader that starts from nothing is ever sent its text or its earlier versions', async () => {
      await withDevWorkspace(async (db, f) => {
        const app = createApp({
          brand,
          db,
          electric: { url: electricUrl as string, secret: electricSecret },
          auth: headerActorResolver(db.orm),
          config: TEST_APP_CONFIG,
        });
        const target = f.issues.eng[0];
        if (!target) throw new Error('fixture issue missing');
        const author = await actorOf(db, f, 'member');
        const original = `original-text-${crypto.randomUUID()}`;
        const revised = `revised-text-${crypto.randomUUID()}`;
        const kept = `kept-text-${crypto.randomUUID()}`;
        const made = await createComment(db.orm, author, target.id, { body: original });
        const other = await createComment(db.orm, author, target.id, { body: kept });
        if (!made.ok || !other.ok) throw new Error('comment create refused');
        const path = `${base(f)}/issues/${target.id}/comments`;
        const guest = f.members.guest.id;

        // A reader asks while the comment lives: Electric takes its snapshot of this shape now and keeps its log.
        const early = await readFromNothing(app, path, guest);
        await editComment(db.orm, author, made.value.id, { body: revised });
        const midway = await readFromNothing(app, path, guest);
        expect(early.text).toContain(original);
        expect(midway.text).toContain(revised);

        const deleted = await deleteComment(db.orm, author, made.value.id);
        expect(deleted.ok).toBe(true);

        for (const reader of [guest, f.members.member.id, f.members.owner.id]) {
          const late = await readFromNothing(app, path, reader);
          expect(late.text).not.toContain(original);
          expect(late.text).not.toContain(revised);
          expect(late.text).toContain(made.value.id);
          expect(late.text).toContain(kept);
          expect(late.handle).not.toBe(early.handle);
        }
      });
    }, 30_000);

    it('a reader that holds the handle of the old shape is told to start over, not served from it', async () => {
      await withDevWorkspace(async (db, f) => {
        const app = createApp({
          brand,
          db,
          electric: { url: electricUrl as string, secret: electricSecret },
          auth: headerActorResolver(db.orm),
          config: TEST_APP_CONFIG,
        });
        const target = f.issues.eng[0];
        if (!target) throw new Error('fixture issue missing');
        const author = await actorOf(db, f, 'member');
        const text = `soon-deleted-${crypto.randomUUID()}`;
        const made = await createComment(db.orm, author, target.id, { body: text });
        if (!made.ok) throw new Error('comment create refused');
        const path = `${base(f)}/issues/${target.id}/comments`;
        const who = f.members.guest.id;
        const early = await readFromNothing(app, path, who);
        await deleteComment(db.orm, author, made.value.id);

        const stale = await get(
          app,
          `${path}?offset=${early.offset}&handle=${early.handle}`,
          as(who),
        );

        expect(stale.status).toBe(409);
        expect(await stale.text()).not.toContain(text);
        expect(stale.headers.get('electric-handle')).not.toBe(early.handle);
      });
    }, 30_000);

    it('the real client that read the comments before the delete ends up with the tombstone and no text', async () => {
      await withDevWorkspace(async (db, f) => {
        const app = createApp({
          brand,
          db,
          electric: { url: electricUrl as string, secret: electricSecret },
          auth: headerActorResolver(db.orm),
          config: TEST_APP_CONFIG,
        });
        const target = f.issues.eng[0];
        if (!target) throw new Error('fixture issue missing');
        const author = await actorOf(db, f, 'member');
        const text = `client-text-${crypto.randomUUID()}`;
        const made = await createComment(db.orm, author, target.id, { body: text });
        if (!made.ok) throw new Error('comment create refused');
        const stop = new AbortController();
        const statuses: number[] = [];
        const stream = new ShapeStream({
          url: `http://localhost${base(f)}/issues/${target.id}/comments`,
          signal: stop.signal,
          fetchClient: async (input, init) => {
            const headers = new Headers(init?.headers);
            headers.set(TEST_MEMBER_HEADER, f.members.guest.id);
            const res = await app.fetch(new Request(input, { ...init, headers }));
            statuses.push(res.status);
            return res;
          },
        });
        const shape = new Shape(stream);
        try {
          expect((await shape.rows).map((row) => row.body)).toEqual([text]);
          const firstHandle = stream.shapeHandle;

          await deleteComment(db.orm, author, made.value.id);

          const deadline = Date.now() + 10_000;
          while (
            !shape.currentRows.some((row) => row.deleted_at) ||
            stream.shapeHandle === firstHandle
          ) {
            if (Date.now() > deadline) throw new Error('the client never moved to the new shape');
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          expect(shape.currentRows.map((row) => row.body)).toEqual(['']);
          expect(statuses).toContain(409);
        } finally {
          stop.abort();
        }
      });
    }, 30_000);

    it('serves the rows of each shape with exactly its columns: no storage key, no pending file, no body in the list', async () => {
      await withDevWorkspace(async (db, f) => {
        const app = createApp({
          brand,
          db,
          electric: { url: electricUrl as string, secret: electricSecret },
          auth: headerActorResolver(db.orm),
          config: TEST_APP_CONFIG,
        });
        const target = f.issues.eng[0];
        if (!target) throw new Error('fixture issue missing');
        const where = { workspaceId: f.workspaceId, teamId: f.teams.eng.id };
        const [root] = await db.orm
          .insert(comment)
          .values({
            ...where,
            issueId: target.id,
            authorId: f.members.member.id,
            body: 'A comment for the shape',
            reactions: { '👍': [f.members.guest.id] },
          })
          .returning();
        const file = {
          ...where,
          issueId: target.id,
          uploaderId: f.members.member.id,
          fileName: 'shot.png',
          contentType: 'image/png',
          sizeBytes: 10,
        };
        await db.orm.insert(attachment).values([
          {
            ...file,
            storageKey: `workspaces/${f.workspaceId}/attachments/ready`,
            status: 'ready',
            readyAt: new Date(),
          },
          {
            ...file,
            fileName: 'pending.png',
            storageKey: `workspaces/${f.workspaceId}/attachments/pending`,
            status: 'pending',
          },
        ]);
        const [doc] = await db.orm
          .insert(document)
          .values({
            ...where,
            title: 'Handbook',
            body: 'The long text of the document',
            createdBy: f.members.owner.id,
            updatedBy: f.members.owner.id,
          })
          .returning();
        if (!root || !doc) throw new Error('inserts returned no row');
        const asGuest = as(f.members.guest.id);

        const comments = await rows(
          await get(app, `${base(f)}/issues/${target.id}/comments?offset=-1`, asGuest),
        );
        const attachments = await rows(
          await get(app, `${base(f)}/issues/${target.id}/attachments?offset=-1`, asGuest),
        );
        const documents = await rows(
          await get(app, `${base(f)}/teams/${f.teams.eng.id}/documents?offset=-1`, asGuest),
        );
        const content = await rows(
          await get(app, `${base(f)}/documents/${doc.id}/content?offset=-1`, asGuest),
        );

        expect(comments).toHaveLength(1);
        expect(comments[0]?.body).toBe('A comment for the shape');
        expect(Object.keys(comments[0] ?? {}).sort()).toEqual(
          [...issueCommentsShape(ID, 0).columns].sort(),
        );
        expect(attachments).toHaveLength(1);
        expect(attachments[0]?.file_name).toBe('shot.png');
        expect(Object.keys(attachments[0] ?? {}).sort()).toEqual(
          [...issueAttachmentsShape(ID).columns].sort(),
        );
        expect(JSON.stringify(attachments)).not.toContain('workspaces/');
        expect(documents).toHaveLength(1);
        expect(documents[0]?.title).toBe('Handbook');
        expect(JSON.stringify(documents)).not.toContain('long text');
        expect(Object.keys(documents[0] ?? {}).sort()).toEqual(
          [...teamDocumentsShape(ID).columns].sort(),
        );
        expect(content).toHaveLength(1);
        expect(content[0]?.body).toBe('The long text of the document');
        expect(Object.keys(content[0] ?? {}).sort()).toEqual(
          [...documentContentShape(ID).columns].sort(),
        );
      });
    });
  },
);
