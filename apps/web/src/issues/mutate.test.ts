import { describe, expect, it, vi } from 'vitest';
import type { ApiError } from '../api.ts';
import type { SyncedIssue } from '../sync/collections.ts';
import { WriteDropped } from '../sync/outbox.ts';

vi.mock('../sync/snapshot-hooks.ts', () => ({ snapshotWatch: { ownWrite: vi.fn() } }));

const { updateIssue } = await import('./mutate.ts');

const L1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const L2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const STATE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const issue = {
  id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  workspace_id: 'ws1',
  team_id: 'team1',
  title: 'Old',
} as SyncedIssue;

/** A collection that records the draft the update callback produces and settles or fails as told. */
function collection(outcome: 'ok' | Error = 'ok') {
  const drafts: Array<Record<string, unknown>> = [];
  return {
    drafts,
    update: vi.fn((_key: string, change: (draft: Record<string, unknown>) => void) => {
      const draft: Record<string, unknown> = {};
      change(draft);
      drafts.push(draft);
      return {
        when: () => (outcome === 'ok' ? Promise.resolve() : Promise.reject(outcome)),
      };
    }),
  };
}

const deps = () => {
  const order: string[] = [];
  return {
    order,
    enqueue: vi.fn(async (write: { body?: unknown }) => {
      order.push('enqueue');
      void write;
      return { txid: 7 };
    }),
    refreshLabels: vi.fn(() => {
      order.push('refresh');
    }),
    confirmLabels: vi.fn(() => {
      order.push('confirm');
    }),
  };
};

describe('updateIssue', () => {
  it('sends scalar fields through the collection, as column changes', async () => {
    const issues = collection();
    const d = deps();
    await updateIssue(
      issues,
      issue,
      {
        stateId: STATE,
        priority: 2,
        assigneeId: null,
        estimate: 3,
        dueDate: '2026-12-01',
        sortOrder: 1.5,
      },
      d,
    );
    expect(issues.drafts).toEqual([
      {
        state_id: STATE,
        priority: 2,
        assignee_id: null,
        estimate: 3,
        due_date: '2026-12-01',
        sort_order: 1.5,
      },
    ]);
    expect(d.enqueue).not.toHaveBeenCalled();
    expect(d.refreshLabels).not.toHaveBeenCalled();
  });

  it('rolls back on 403 and keeps the code', async () => {
    const refused = new WriteDropped('lost-access', 403, 'forbidden', 'No.');
    const issues = collection(refused);
    const error = await updateIssue(issues, issue, { priority: 1 }, deps()).catch(
      (e: unknown) => e,
    );
    expect(error).toBe(refused);
    expect((error as ApiError).code).toBe('forbidden');
  });

  it('a label edit queues {addLabelIds} and refreshes issueLabels after the txid', async () => {
    const issues = collection();
    const d = deps();
    await updateIssue(issues, issue, { addLabelIds: [L1], removeLabelIds: [L2] }, d);
    expect(issues.update).not.toHaveBeenCalled();
    expect(d.enqueue).toHaveBeenCalledOnce();
    const write = d.enqueue.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(write).toMatchObject({
      workspaceId: 'ws1',
      teamId: 'team1',
      method: 'PATCH',
      path: `/api/w/ws1/issues/${issue.id}`,
      body: { addLabelIds: [L1], removeLabelIds: [L2] },
    });
    expect(typeof write.idempotencyKey).toBe('string');
    // The edit is kept visible before the labels are read again, so no chip blinks out in between.
    expect(d.order).toEqual(['enqueue', 'confirm', 'refresh']);
    expect(d.confirmLabels).toHaveBeenCalledWith({ issueId: issue.id, add: [L1], remove: [L2] });
    expect(d.refreshLabels).toHaveBeenCalledWith('ws1', 'team1');
  });

  it('a refused label edit rejects with the server code and refreshes nothing', async () => {
    const d = deps();
    d.enqueue.mockRejectedValueOnce(new WriteDropped('rejected', 400, 'invalid_input', 'Bad.'));
    const error = await updateIssue(collection(), issue, { addLabelIds: [L1] }, d).catch(
      (e: unknown) => e,
    );
    expect((error as ApiError).code).toBe('invalid_input');
    expect(d.refreshLabels).not.toHaveBeenCalled();
    expect(d.confirmLabels).not.toHaveBeenCalled();
  });

  it('scalar and label parts of one patch both go out', async () => {
    const issues = collection();
    const d = deps();
    await updateIssue(issues, issue, { priority: 4, addLabelIds: [L1] }, d);
    expect(issues.drafts).toEqual([{ priority: 4 }]);
    expect(d.enqueue).toHaveBeenCalledOnce();
    const sent = d.enqueue.mock.calls[0]?.[0] as unknown as { body: unknown };
    expect(sent.body).toEqual({ addLabelIds: [L1] });
  });

  it('refuses an invalid patch before anything is sent', async () => {
    const issues = collection();
    const d = deps();
    const error = await updateIssue(issues, issue, { priority: 9 }, d).catch((e: unknown) => e);
    expect((error as ApiError).code).toBe('invalid_input');
    expect(issues.update).not.toHaveBeenCalled();
    expect(d.enqueue).not.toHaveBeenCalled();
  });

  it('an empty patch is refused', async () => {
    const error = await updateIssue(collection(), issue, {}, deps()).catch((e: unknown) => e);
    expect((error as ApiError).code).toBe('invalid_input');
  });
});
