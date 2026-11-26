import { describe, expect, it, vi } from 'vitest';
import { saveDescription, setArchived, setSubscribed } from './mutate.ts';

const issue = { id: 'i1', workspace_id: 'w1', team_id: 't1' };
const deps = () => ({
  enqueue: vi.fn().mockResolvedValue({ txid: 1 }),
  refresh: vi.fn(),
});

describe('writes of the issue panel', () => {
  it('a description is a PATCH of the issue, and its snapshot is read again', async () => {
    const d = deps();
    await saveDescription(issue, 'Line 1\nLine 2', d);
    expect(d.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'w1',
        teamId: 't1',
        method: 'PATCH',
        path: '/api/w/w1/issues/i1',
        body: { description: 'Line 1\nLine 2' },
        idempotencyKey: expect.any(String),
      }),
    );
    expect(d.refresh).toHaveBeenCalledWith('w1', 't1', ['issueDetail']);
  });

  it('a refused description rejects with the refusal and reads nothing again', async () => {
    const d = deps();
    d.enqueue.mockRejectedValue(new Error('refused'));
    await expect(saveDescription(issue, 'x', d)).rejects.toThrow('refused');
    expect(d.refresh).not.toHaveBeenCalled();
  });

  it('subscribing is a PUT and unsubscribing a DELETE of the member under the issue', async () => {
    const d = deps();
    await setSubscribed(issue, 'm1', true, d);
    expect(d.enqueue).toHaveBeenLastCalledWith(
      expect.objectContaining({ method: 'PUT', path: '/api/w/w1/issues/i1/subscribers/m1' }),
    );
    await setSubscribed(issue, 'm1', false, d);
    expect(d.enqueue).toHaveBeenLastCalledWith(
      expect.objectContaining({ method: 'DELETE', path: '/api/w/w1/issues/i1/subscribers/m1' }),
    );
    expect(d.refresh).toHaveBeenLastCalledWith('w1', 't1', ['issueSubscribers']);
  });

  it('archive and unarchive are POSTs', async () => {
    const d = deps();
    await setArchived(issue, true, d);
    expect(d.enqueue).toHaveBeenLastCalledWith(
      expect.objectContaining({ method: 'POST', path: '/api/w/w1/issues/i1/archive' }),
    );
    await setArchived(issue, false, d);
    expect(d.enqueue).toHaveBeenLastCalledWith(
      expect.objectContaining({ method: 'POST', path: '/api/w/w1/issues/i1/unarchive' }),
    );
  });
});
