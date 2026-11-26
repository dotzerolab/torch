// @vitest-environment jsdom
import { FetchError, ShapeStream } from '@electric-sql/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api.ts')>()),
  apiFetch: vi.fn(),
}));

import {
  BACKOFF_OPTIONS,
  createIssueActivityCollection,
  createIssueDetailCollection,
  createIssueLabelsCollection,
  createIssueLinksCollection,
  createIssueRelationsCollection,
  createIssueSubscribersCollection,
  createIssuesCollection,
  createLabelsCollection,
  createTeamsCollection,
  createWorkflowStatesCollection,
  createWorkspaceLabelsCollection,
  handleShapeError,
  observeSync,
  type SyncedIssue,
  sendIssueMutations,
} from './collections.ts';
import { bindTestSession, resetIdentityForTests } from './identity.ts';
import type { OutboxWrite } from './outbox.ts';
import type { ShapeContext } from './registry.ts';
import { markSigningOut, resetSigningOut } from './signing-out.ts';

const actions = () => ({ signIn: vi.fn(), dropTeam: vi.fn() });
const fetchError = (status: number) =>
  new FetchError(status, undefined, undefined, {}, 'http://x/', '');

describe('handleShapeError', () => {
  it('sends a 401 to sign-in', () => {
    const a = actions();
    handleShapeError(fetchError(401), { workspaceId: 'w' }, a);
    expect(a.signIn).toHaveBeenCalledOnce();
    expect(a.dropTeam).not.toHaveBeenCalled();
  });

  it('does not send the page to sign-in on a 401 while it signs the person out', () => {
    markSigningOut();
    try {
      const a = actions();
      handleShapeError(fetchError(401), { workspaceId: 'w' }, a);
      expect(a.signIn).not.toHaveBeenCalled();
    } finally {
      resetSigningOut();
    }
  });

  it('drops the team on a 404 of a team-scoped shape', () => {
    const a = actions();
    handleShapeError(fetchError(404), { workspaceId: 'w', teamId: 't' }, a);
    expect(a.dropTeam).toHaveBeenCalledWith('w', 't');
  });

  it('does not drop anything on a 404 of a workspace-scoped shape, and ignores other errors', () => {
    const a = actions();
    handleShapeError(fetchError(404), { workspaceId: 'w' }, a);
    handleShapeError(fetchError(400), { workspaceId: 'w', teamId: 't' }, a);
    handleShapeError(new Error('boom'), { workspaceId: 'w', teamId: 't' }, a);
    expect(a.signIn).not.toHaveBeenCalled();
    expect(a.dropTeam).not.toHaveBeenCalled();
  });
});

describe('429 and 5xx', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('429 waits Retry-After before the client asks again', async () => {
    const upToDate = () =>
      new Response(JSON.stringify([{ headers: { control: 'up-to-date' } }]), {
        status: 200,
        headers: {
          'electric-handle': 'h1',
          'electric-offset': '0_0',
          'electric-schema': '{}',
          'content-type': 'application/json',
        },
      });
    const fetchClient = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '1' } }))
      .mockImplementation(async () => upToDate());
    const onError = vi.fn();
    const stream = new ShapeStream({
      url: 'http://localhost/api/sync/w/x/teams',
      fetchClient,
      backoffOptions: { ...BACKOFF_OPTIONS },
      onError,
      subscribe: false,
    });
    const unsubscribe = stream.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchClient).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(990);
    expect(fetchClient).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(fetchClient.mock.calls.length).toBeGreaterThanOrEqual(2);
    // The throttling never reached the error policy: the client's own backoff absorbed it.
    expect(onError).not.toHaveBeenCalled();
    unsubscribe();
  });
});

describe('sendIssueMutations (M9)', () => {
  const queued = () =>
    vi.fn<(write: OutboxWrite) => Promise<{ txid: number }>>().mockResolvedValue({ txid: 0 });

  it('queues one PATCH per mutation in order and awaits every txid', async () => {
    const enqueue = queued();
    enqueue.mockResolvedValueOnce({ txid: 11 }).mockResolvedValueOnce({ txid: 12 });
    const awaitTxId = vi.fn().mockResolvedValue(true);
    await sendIssueMutations(
      'w1',
      't1',
      [
        { key: 'i1', changes: { title: 'One' } },
        { key: 'i2', changes: { priority: 2 } },
      ],
      awaitTxId,
      enqueue,
    );
    expect(enqueue.mock.calls.map(([w]) => w.path)).toEqual([
      '/api/w/w1/issues/i1',
      '/api/w/w1/issues/i2',
    ]);
    expect(enqueue.mock.calls.map(([w]) => [w.method, w.workspaceId, w.teamId])).toEqual([
      ['PATCH', 'w1', 't1'],
      ['PATCH', 'w1', 't1'],
    ]);
    expect(enqueue.mock.calls[1]?.[0].body).toEqual({ priority: 2 });
    // Each write has its own key, made once here (the outbox keeps it on every replay).
    const keys = enqueue.mock.calls.map(([w]) => w.idempotencyKey);
    expect(new Set(keys).size).toBe(2);
    expect(awaitTxId.mock.calls.map(([txid]) => txid)).toEqual([11, 12]);
  });

  it('stops at the first refused write and awaits nothing', async () => {
    const enqueue = queued();
    enqueue.mockRejectedValueOnce(new Error('refused'));
    const awaitTxId = vi.fn();
    await expect(
      sendIssueMutations(
        'w1',
        't1',
        [
          { key: 'i1', changes: { title: 'A' } },
          { key: 'i2', changes: { title: 'B' } },
        ],
        awaitTxId,
        enqueue,
      ),
    ).rejects.toThrow('refused');
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(awaitTxId).not.toHaveBeenCalled();
  });
});

describe('observeSync', () => {
  /** A sync like the electric one: it reports ready after every answer and truncates on a must-refetch. */
  function fakeSync(result: unknown) {
    const seen: { params?: Parameters<ReturnType<typeof build>['sync']['sync']>[0] } = {};
    const build = () => ({
      id: 'c',
      sync: {
        getSyncMetadata: () => ({ relation: undefined }),
        sync: (params: { markReady: () => void; truncate: () => void; collection: unknown }) => {
          seen.params = params;
          return result;
        },
      },
    });
    return { build, seen };
  }
  const hooks = () => ({ settled: vi.fn(), truncated: vi.fn(), cleanup: vi.fn() });

  it('reports every markReady after the library took it, with the collection', () => {
    const { build, seen } = fakeSync(undefined);
    const h = hooks();
    const order: string[] = [];
    h.settled.mockImplementation(() => order.push('settled'));
    const observed = observeSync(build(), h);
    const collection = { keys: () => ['a'] };
    const markReady = vi.fn(() => order.push('markReady'));
    (observed.sync as { sync: (params: unknown) => unknown }).sync({
      markReady,
      truncate: vi.fn(),
      collection,
    });
    seen.params?.markReady();
    seen.params?.markReady();
    expect(order).toEqual(['markReady', 'settled', 'markReady', 'settled']);
    expect(h.settled).toHaveBeenCalledWith(collection);
  });

  it('reports a truncate and still truncates', () => {
    const { build, seen } = fakeSync(undefined);
    const h = hooks();
    const observed = observeSync(build(), h);
    const truncate = vi.fn();
    (observed.sync as { sync: (params: unknown) => unknown }).sync({
      markReady: vi.fn(),
      truncate,
      collection: {},
    });
    seen.params?.truncate();
    expect(truncate).toHaveBeenCalledOnce();
    expect(h.truncated).toHaveBeenCalledOnce();
  });

  it('keeps the other parts of the sync, and runs both cleanups (object result)', () => {
    const cleanup = vi.fn();
    const loadSubset = vi.fn();
    const { build } = fakeSync({ cleanup, loadSubset });
    const h = hooks();
    const observed = observeSync(build(), h);
    expect((observed.sync as { getSyncMetadata: unknown }).getSyncMetadata).toBeTypeOf('function');
    const result = (observed.sync as { sync: (params: unknown) => unknown }).sync({
      markReady: vi.fn(),
      truncate: vi.fn(),
      collection: {},
    }) as { cleanup: () => void; loadSubset: unknown };
    expect(result.loadSubset).toBe(loadSubset);
    result.cleanup();
    expect(h.cleanup).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('runs both cleanups for a sync that returns a function, and for one that returns nothing', () => {
    const cleanup = vi.fn();
    const fnResult = fakeSync(cleanup);
    const h1 = hooks();
    const run = (o: ReturnType<typeof observeSync>) =>
      (o.sync as { sync: (params: unknown) => unknown }).sync({
        markReady: vi.fn(),
        truncate: vi.fn(),
        collection: {},
      });
    (run(observeSync(fnResult.build(), h1)) as () => void)();
    expect(h1.cleanup).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    const h2 = hooks();
    (run(observeSync(fakeSync(undefined).build(), h2)) as { cleanup: () => void }).cleanup();
    expect(h2.cleanup).toHaveBeenCalledOnce();
  });
});

// ---- snapshot shapes: read to `up-to-date`, then closed ----

const WS = '11111111-1111-4111-8111-111111111111';
const TEAM = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ISSUE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const shapeContext = (over: Partial<ShapeContext> = {}): ShapeContext => ({
  dropTeam: vi.fn(),
  inert: false,
  settled: vi.fn(),
  paused: () => false,
  role: 'leader',
  ...over,
});

/** What the server answers for a shape that holds `rows`: the rows, then `up-to-date`. */
function shapeAnswer(rows: ReadonlyArray<Record<string, unknown>>, handle = 'h1') {
  const messages = [
    ...rows.map((value, index) => ({
      key: `"public"."row"/"${index}"`,
      value,
      headers: { operation: 'insert' },
    })),
    { headers: { control: 'up-to-date' } },
  ];
  return new Response(JSON.stringify(messages), {
    status: 200,
    headers: {
      'electric-handle': handle,
      'electric-offset': '0_0',
      'electric-schema': '{}',
      // What the server sends with the last chunk: the client knows it is caught up, and waits for changes after it unless
      // it was asked not to.
      'electric-up-to-date': '',
      'content-type': 'application/json',
    },
  });
}

/** A fetch that answers the first request with `rows` and leaves any later one hanging, remembering every URL. */
function serve(rows: ReadonlyArray<Record<string, unknown>>) {
  const urls: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    urls.push(input instanceof Request ? input.url : String(input));
    if (urls.length === 1) return shapeAnswer(rows);
    return new Promise<Response>(() => {});
  });
  vi.stubGlobal('fetch', fetchMock);
  return urls;
}

type Preloadable = { preload(): Promise<void>; cleanup(): Promise<void> | void };
const opened: Preloadable[] = [];
const open = async <T extends Preloadable>(collection: T): Promise<T> => {
  opened.push(collection);
  await collection.preload();
  return collection;
};

describe('snapshot shapes', () => {
  beforeEach(() => bindTestSession(WS));
  afterEach(async () => {
    for (const collection of opened.splice(0)) await collection.cleanup();
    vi.unstubAllGlobals();
    resetIdentityForTests();
  });

  const label = {
    id: 'l1',
    workspace_id: WS,
    team_id: TEAM,
    parent_id: null,
    name: 'Bug',
    color: '#ef4444',
    is_group: false,
    archived_at: null,
    created_at: '2026-11-25T10:00:00Z',
  };

  it('snapshot kind passes subscribe false: after up-to-date no request asks to wait for changes', async () => {
    const urls = serve([label]);
    const labels = await open(createLabelsCollection(WS, TEAM, 'labels-t1', shapeContext()));
    // A live shape asks again at once, with `live=true`; give it the time to.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(labels.size).toBe(1);
    expect(urls).toHaveLength(1);
    expect(urls.some((url) => url.includes('live=true'))).toBe(false);
  });

  it('a live kind does keep asking (control for the test above)', async () => {
    const urls = serve([{ id: 't1', workspace_id: WS, key: 'ENG', name: 'Eng', private: false }]);
    await open(createTeamsCollection(WS, 'teams-control', shapeContext()));
    await vi.waitFor(() => expect(urls.length).toBeGreaterThanOrEqual(2));
    expect(urls.some((url) => url.includes('live=true'))).toBe(true);
  });

  const paths: ReadonlyArray<[string, () => Preloadable, string]> = [
    [
      'labels',
      () => createLabelsCollection(WS, TEAM, 'x', shapeContext()),
      `/teams/${TEAM}/labels`,
    ],
    [
      'issueLabels',
      () => createIssueLabelsCollection(WS, TEAM, 'x', shapeContext()),
      `/teams/${TEAM}/issue-labels`,
    ],
    [
      'issueRelations',
      () => createIssueRelationsCollection(WS, TEAM, 'x', shapeContext()),
      `/teams/${TEAM}/issue-relations`,
    ],
    [
      'issueLinks',
      () => createIssueLinksCollection(WS, TEAM, 'x', shapeContext()),
      `/teams/${TEAM}/issue-links`,
    ],
    [
      'issueSubscribers',
      () => createIssueSubscribersCollection(WS, TEAM, 'x', shapeContext()),
      `/teams/${TEAM}/issue-subscribers`,
    ],
    [
      'workflowStates',
      () => createWorkflowStatesCollection(WS, TEAM, 'x', shapeContext()),
      `/teams/${TEAM}/workflow-states`,
    ],
    [
      'workspaceLabels',
      () => createWorkspaceLabelsCollection(WS, 'x', shapeContext()),
      '/workspace-labels',
    ],
    [
      'issueDetail',
      () => createIssueDetailCollection(WS, TEAM, ISSUE, 'x', shapeContext()),
      `/issues/${ISSUE}/detail`,
    ],
    [
      'issueActivity',
      () => createIssueActivityCollection(WS, TEAM, ISSUE, 'x', shapeContext()),
      `/issues/${ISSUE}/activity`,
    ],
  ];

  it.each(paths)('%s reads the route the server serves, once', async (_kind, make, tail) => {
    const urls = serve([]);
    await open(make());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(urls).toHaveLength(1);
    expect(new URL(urls[0] ?? '').pathname).toBe(`/api/sync/w/${WS}${tail}`);
    expect(urls[0]).not.toContain('live=true');
  });

  it('keeps two rows of one issue apart: a join row is keyed by both of its ids', async () => {
    serve([
      { workspace_id: WS, team_id: TEAM, issue_id: ISSUE, label_id: 'l1' },
      { workspace_id: WS, team_id: TEAM, issue_id: ISSUE, label_id: 'l2' },
    ]);
    const joins = await open(createIssueLabelsCollection(WS, TEAM, 'x', shapeContext()));
    expect(joins.size).toBe(2);
    expect(joins.get(`${ISSUE}:l2`)?.label_id).toBe('l2');

    serve([
      { workspace_id: WS, team_id: TEAM, issue_id: ISSUE, member_id: 'm1', created_at: 'x' },
      { workspace_id: WS, team_id: TEAM, issue_id: ISSUE, member_id: 'm2', created_at: 'x' },
    ]);
    const subscribers = await open(createIssueSubscribersCollection(WS, TEAM, 'y', shapeContext()));
    expect(subscribers.size).toBe(2);
    expect(subscribers.get(`${ISSUE}:m1`)?.member_id).toBe('m1');
  });

  it('a follower tab reads a snapshot itself: its own request, nothing from the leader', async () => {
    const urls = serve([label]);
    const context = shapeContext({ role: 'follower' });
    const labels = await open(createLabelsCollection(WS, TEAM, 'mirror-labels-t1', context));
    expect(labels.size).toBe(1);
    expect(urls).toHaveLength(1);
    expect(context.settled).toHaveBeenCalled();
  });

  it('a snapshot of a team that is gone is empty and asks for nothing', async () => {
    const urls = serve([label]);
    const labels = await open(
      createLabelsCollection(WS, TEAM, 'labels-t1', shapeContext({ inert: true })),
    );
    expect(labels.size).toBe(0);
    expect(urls).toHaveLength(0);
  });

  it('a 404 of a team snapshot drops the team; a 404 of one issue or of the workspace labels does not', async () => {
    const notFound = () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('', { status: 404 })),
      );
    };
    const dropTeam = vi.fn();
    notFound();
    const labels = createLabelsCollection(WS, TEAM, 'labels-t1', shapeContext({ dropTeam }));
    opened.push(labels);
    void labels.preload().catch(() => {});
    await vi.waitFor(() => expect(dropTeam).toHaveBeenCalledWith(WS, TEAM));

    // The issue is unknown or hidden: that says nothing about the team.
    const quiet = vi.fn();
    notFound();
    const detail = createIssueDetailCollection(
      WS,
      TEAM,
      ISSUE,
      'd',
      shapeContext({ dropTeam: quiet }),
    );
    const activity = createIssueActivityCollection(
      WS,
      TEAM,
      ISSUE,
      'a',
      shapeContext({ dropTeam: quiet }),
    );
    const workspaceLabels = createWorkspaceLabelsCollection(
      WS,
      'w',
      shapeContext({ dropTeam: quiet }),
    );
    for (const collection of [detail, activity, workspaceLabels]) {
      opened.push(collection);
      void collection.preload().catch(() => {});
    }
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(quiet).not.toHaveBeenCalled();
  });

  it('issue row keeps the new columns', async () => {
    serve([
      {
        id: ISSUE,
        workspace_id: WS,
        team_id: TEAM,
        number: 7,
        title: 'Seven',
        state_id: 's1',
        priority: 2,
        assignee_id: null,
        creator_id: 'm1',
        created_at: '2026-11-25T10:00:00Z',
        updated_at: '2026-11-25T10:00:00Z',
        archived_at: null,
        estimate: 3,
        due_date: '2026-12-01',
        parent_id: 'p1',
        sort_order: 1.5,
        started_at: '2026-11-25T11:00:00Z',
        completed_at: null,
        canceled_at: null,
      },
    ]);
    const issues = await open(createIssuesCollection(WS, TEAM, 'issues-t1', shapeContext()));
    const row: SyncedIssue | undefined = issues.get(ISSUE);
    expect(row?.sort_order).toBe(1.5);
    expect(row?.estimate).toBe(3);
    expect(row?.due_date).toBe('2026-12-01');
    expect(row?.parent_id).toBe('p1');
    expect(row?.started_at).toBe('2026-11-25T11:00:00Z');
    expect(row?.completed_at).toBeNull();
    expect(row?.canceled_at).toBeNull();
  });
});
