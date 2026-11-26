// @vitest-environment jsdom
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { REACTION_EMOJI } from '@torch/shared/mutations/comment';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api.ts';
import { LocaleProvider } from '../design/index.ts';
import { ShellContext, type ShellState } from '../shell/ShellContext.ts';
import type { SyncedComment, SyncedIssue, SyncedMember } from '../sync/collections.ts';
import { manualCollection } from '../test/collections.ts';

const mocks = vi.hoisted(() => ({
  collections: {} as Record<string, unknown>,
  enqueue: vi.fn(),
  apiFetch: vi.fn(),
}));
vi.mock('../sync/shapes.ts', () => ({
  syncRegistry: { get: () => ({}), refresh: () => {} },
  useShape: (key: { kind: string }) => mocks.collections[key.kind],
}));
vi.mock('../sync/outbox.ts', () => ({ enqueueWrite: mocks.enqueue }));
vi.mock('../api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api.ts')>()),
  apiFetch: mocks.apiFetch,
}));

import { CommentThread } from './CommentThread.tsx';
import { resetPendingForTests } from './pending.ts';

const ME = 'aaaaaaaa-0000-4000-8000-000000000001';
const OTHER = 'aaaaaaaa-0000-4000-8000-000000000002';
const ADMIN = 'aaaaaaaa-0000-4000-8000-000000000003';
const GONE = 'aaaaaaaa-0000-4000-8000-000000000009';
const C1 = 'cccccccc-0000-4000-8000-000000000001';
const C2 = 'cccccccc-0000-4000-8000-000000000002';
const C3 = 'cccccccc-0000-4000-8000-000000000003';

const member = (id: string, name: string, role: SyncedMember['role'] = 'member'): SyncedMember => ({
  id,
  workspace_id: 'w1',
  name,
  handle: name.toLowerCase(),
  role,
  locale: 'en',
  deactivated_at: null,
  created_at: '2026-11-01T10:00:00Z',
});

const comment = (id: string, over: Partial<SyncedComment> = {}): SyncedComment => ({
  id,
  workspace_id: 'w1',
  team_id: 't1',
  issue_id: 'i1',
  parent_id: null,
  author_id: OTHER,
  body: `Body of ${id}`,
  reactions: {},
  created_at: '2026-11-26T10:00:00Z',
  edited_at: null,
  resolved_at: null,
  resolved_by: null,
  deleted_at: null,
  ...over,
});

const shell = (role: ShellState['workspace']['role'], memberId: string): ShellState => {
  const teams = [{ id: 't1', workspace_id: 'w1', key: 'ENG', name: 'Engineering', private: false }];
  return {
    workspace: { id: 'w1', name: 'Demo', slug: 'demo', memberId, role },
    teams,
    teamsReady: true,
    team: teams[0] ?? null,
  };
};

async function setup(
  rows: SyncedComment[],
  {
    role = 'member',
    memberId = ME,
    readOnly = false,
    compact = false,
  }: {
    role?: ShellState['workspace']['role'];
    memberId?: string;
    readOnly?: boolean;
    compact?: boolean;
  } = {},
) {
  const comments = manualCollection<SyncedComment>(`comments-${Math.random()}`, (row) => row.id);
  const members = manualCollection<SyncedMember>(`members-${Math.random()}`, (row) => row.id);
  const issues = manualCollection<SyncedIssue>(`issues-${Math.random()}`, (row) => row.id);
  mocks.collections.issueComments = comments.collection;
  mocks.collections.members = members.collection;
  mocks.collections.issues = issues.collection;
  members.set(member(ME, 'Mia'), member(OTHER, 'Olivia'), member(ADMIN, 'Adam', 'admin'));
  members.ready();
  issues.ready();
  comments.set(...rows);
  comments.ready();
  const user = userEvent.setup();
  const view = render(
    <LocaleProvider locale="en">
      <ShellContext.Provider value={shell(role, memberId)}>
        <CommentThread
          workspaceId="w1"
          teamId="t1"
          issueId="i1"
          issueIdentifier="ENG-12"
          readOnly={readOnly}
          compact={compact}
        />
      </ShellContext.Provider>
    </LocaleProvider>,
  );
  await screen.findByTestId('comment-thread');
  return { user, comments, view };
}

const typeAndSend = async (
  user: ReturnType<typeof userEvent.setup>,
  text: string,
  name = 'Write a comment',
) => {
  await user.type(screen.getByRole('textbox', { name }), text);
  await user.keyboard('{Control>}{Enter}{/Control}');
};

beforeEach(() => {
  resetPendingForTests();
  sessionStorage.clear();
  mocks.enqueue.mockReset();
  mocks.apiFetch.mockReset();
  mocks.enqueue.mockResolvedValue({ txid: 1, comment: { id: C3 } });
});

describe('CommentThread: reading', () => {
  it('lists threads oldest first with replies under their comment, names from the members shape', async () => {
    await setup([
      comment(C2, { created_at: '2026-11-26T10:05:00Z', author_id: ME, body: 'Second' }),
      comment(C1, { created_at: '2026-11-26T10:00:00Z', body: 'First' }),
      comment('cccccccc-0000-4000-8000-0000000000a1', {
        parent_id: C1,
        author_id: ME,
        body: 'A reply',
        created_at: '2026-11-26T10:01:00Z',
      }),
    ]);
    const threads = screen
      .getAllByRole('listitem')
      .filter((li) => li.dataset.testid?.startsWith('thread-'));
    expect(threads.map((t) => t.dataset.testid)).toEqual([`thread-${C1}`, `thread-${C2}`]);
    const first = within(threads[0] as HTMLElement);
    expect(first.getByText('First')).toBeInTheDocument();
    expect(first.getByText('A reply')).toBeInTheDocument();
    expect(first.getAllByText('Olivia').length).toBeGreaterThan(0);
    expect(first.getAllByText('Mia').length).toBeGreaterThan(0);
  });

  it('shows "Former member" for an author the members shape does not hold', async () => {
    await setup([comment(C1, { author_id: GONE })]);
    expect(screen.getByText('Former member')).toBeInTheDocument();
  });

  it('shows a removed comment as a tombstone and keeps its replies', async () => {
    await setup([
      comment(C1, { body: '', deleted_at: '2026-11-26T12:00:00Z' }),
      comment(C2, { parent_id: C1, body: 'Still here', created_at: '2026-11-26T10:01:00Z' }),
    ]);
    expect(screen.getByText('Comment removed')).toBeInTheDocument();
    expect(screen.getByText('Still here')).toBeInTheDocument();
    const tomb = screen.getByTestId(`comment-${C1}`);
    expect(within(tomb).queryByRole('button', { name: 'More actions' })).toBeNull();
  });

  it('says so when there are no comments', async () => {
    await setup([]);
    expect(screen.getByText('No comments yet.')).toBeInTheDocument();
  });

  it('marks an @handle that belongs to a member and leaves another as plain text', async () => {
    await setup([comment(C1, { body: 'cc @mia and @stranger' })]);
    const marks = [...document.querySelectorAll('.md-mention')].map((el) => el.textContent);
    expect(marks).toEqual(['@mia']);
    expect(screen.getByText(/@stranger/)).toBeInTheDocument();
  });

  it('renders the text of a comment through the inert renderer', async () => {
    await setup([comment(C1, { body: '<img src=x onerror=1> [x](javascript:alert(1)) **bold**' })]);
    const thread = screen.getByTestId(`comment-${C1}`);
    expect(thread.querySelector('img')).toBeNull();
    expect(thread.querySelector('a')).toBeNull();
    expect(thread.querySelector('strong')?.textContent).toBe('bold');
  });
});

describe('CommentThread: who may do what', () => {
  it('a guest sees no delete and no edit on the comments of others', async () => {
    const { user } = await setup([comment(C1, { author_id: OTHER })], { role: 'guest' });
    expect(screen.queryByRole('button', { name: 'More actions' })).toBeNull();
    // A guest still comments, reacts and resolves.
    expect(screen.getByRole('textbox', { name: 'Write a comment' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reply' })).toBeInTheDocument();
    void user;
  });

  it('an author may edit and delete their own comment, and no one else may edit it', async () => {
    const { user } = await setup([comment(C1, { author_id: ME })]);
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    expect(await screen.findByRole('menuitem', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument();
  });

  it('an admin may delete the comment of someone else but not edit it', async () => {
    const { user } = await setup([comment(C1, { author_id: OTHER })], {
      role: 'admin',
      memberId: ADMIN,
    });
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    expect(await screen.findByRole('menuitem', { name: 'Delete' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Edit' })).toBeNull();
  });

  it('a read-only thread (an archived issue) has no composer, no reply, no resolve and no reactions to add', async () => {
    await setup([comment(C1, { author_id: ME, reactions: { '👍': [OTHER] } })], { readOnly: true });
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByTestId('composer-note')).toHaveTextContent(
      'This issue is archived, so its comments are read-only.',
    );
    expect(screen.queryByRole('button', { name: 'Reply' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Resolve thread' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add reaction' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'More actions' })).toBeNull();
    // The reactions that exist stay visible, and cannot be pressed.
    expect(screen.getByRole('button', { name: /React with 👍/ })).toBeDisabled();
  });
});

describe('CommentThread: writing', () => {
  it('Ctrl+Enter sends a POST with the text, clears the box and the draft, and shows the comment before the server answers', async () => {
    let answer!: (value: unknown) => void;
    mocks.enqueue.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const { user } = await setup([]);
    await typeAndSend(user, 'Hello team');

    await waitFor(() => expect(mocks.enqueue).toHaveBeenCalledTimes(1));
    expect(mocks.enqueue.mock.calls[0]?.[0]).toMatchObject({
      workspaceId: 'w1',
      teamId: 't1',
      method: 'POST',
      path: '/api/w/w1/issues/i1/comments',
      body: { body: 'Hello team' },
    });
    expect(typeof mocks.enqueue.mock.calls[0]?.[0].idempotencyKey).toBe('string');
    expect(screen.getByRole('textbox', { name: 'Write a comment' })).toHaveValue('');
    expect(sessionStorage.getItem('ui-comment-draft-i1')).toBeNull();
    // Before the txid: the comment is on screen, marked as being sent.
    const sent = await screen.findByText('Hello team');
    expect(
      within(sent.closest('article') as HTMLElement).getByText('Sending…'),
    ).toBeInTheDocument();

    await act(async () => answer({ txid: 4, comment: { id: C3 } }));
  });

  it("a refused write takes the comment back, shows why in the person's language, and returns the text", async () => {
    mocks.enqueue.mockRejectedValue(
      new ApiError(409, 'issue_archived', 'An archived issue cannot be changed.'),
    );
    const { user } = await setup([]);
    await typeAndSend(user, 'Too late');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This issue is archived. Unarchive it to change its comments.',
    );
    await waitFor(() => expect(screen.queryByText('Sending…')).toBeNull());
    expect(screen.queryByTestId(/^comment-pending/)).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Write a comment' })).toHaveValue('Too late');
  });

  it('an unknown refusal falls back to the general message', async () => {
    mocks.enqueue.mockRejectedValue(new ApiError(500, 'weird', 'boom'));
    const { user } = await setup([]);
    await typeAndSend(user, 'Hm');
    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
  });

  it('keeps the draft per issue in this tab, and starts from it again', async () => {
    const { user, view } = await setup([]);
    await user.type(screen.getByRole('textbox', { name: 'Write a comment' }), 'Half a thought');
    expect(sessionStorage.getItem('ui-comment-draft-i1')).toBe('Half a thought');
    view.unmount();
    await setup([]);
    expect(screen.getByRole('textbox', { name: 'Write a comment' })).toHaveValue('Half a thought');
  });

  it('a reply is a POST with the parent', async () => {
    const { user } = await setup([comment(C1)]);
    await user.click(screen.getByRole('button', { name: 'Reply' }));
    await typeAndSend(user, 'Agreed', 'Reply to Olivia');
    await waitFor(() => expect(mocks.enqueue).toHaveBeenCalledTimes(1));
    expect(mocks.enqueue.mock.calls[0]?.[0].body).toEqual({ body: 'Agreed', parentId: C1 });
  });

  it('resolves a thread, shows it collapsed with who resolved it, and reopens it', async () => {
    const { user, comments } = await setup([comment(C1, { author_id: ME })]);
    await user.click(screen.getByRole('button', { name: 'Resolve thread' }));
    await waitFor(() => expect(mocks.enqueue).toHaveBeenCalledTimes(1));
    expect(mocks.enqueue.mock.calls[0]?.[0]).toMatchObject({
      method: 'POST',
      path: `/api/w/w1/comments/${C1}/resolve`,
    });
    // The overlay collapses it at once, naming the person who resolved it.
    expect(await screen.findByText('Resolved by Mia')).toBeInTheDocument();
    expect(screen.queryByText(`Body of ${C1}`)).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Show thread' }));
    expect(screen.getByText(`Body of ${C1}`)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Hide thread' }));
    mocks.enqueue.mockClear();
    await user.click(screen.getByRole('button', { name: 'Reopen thread' }));
    await waitFor(() => expect(mocks.enqueue).toHaveBeenCalledTimes(1));
    expect(mocks.enqueue.mock.calls[0]?.[0].path).toBe(`/api/w/w1/comments/${C1}/unresolve`);
    void comments;
  });

  it('toggles a reaction with its count: a PUT to add, a DELETE to take it back', async () => {
    const { user } = await setup([comment(C1, { reactions: { '👍': [OTHER] } })]);
    const chip = screen.getByRole('button', { name: 'React with 👍 (1)' });
    expect(chip).toHaveAttribute('aria-pressed', 'false');

    await user.click(chip);
    await waitFor(() => expect(mocks.enqueue).toHaveBeenCalledTimes(1));
    expect(mocks.enqueue.mock.calls[0]?.[0]).toMatchObject({
      method: 'PUT',
      path: `/api/w/w1/comments/${C1}/reactions/${encodeURIComponent('👍')}`,
    });
    // The count and the pressed state follow at once.
    const mine = await screen.findByRole('button', { name: 'React with 👍 (2)' });
    expect(mine).toHaveAttribute('aria-pressed', 'true');

    await user.click(mine);
    await waitFor(() => expect(mocks.enqueue).toHaveBeenCalledTimes(2));
    expect(mocks.enqueue.mock.calls[1]?.[0].method).toBe('DELETE');
  });

  it('adds a reaction from the picker, which offers the fixed set', async () => {
    const { user } = await setup([comment(C1)]);
    await user.click(screen.getByRole('button', { name: 'Add reaction' }));
    const picks = await screen.findAllByRole('button', { name: /^React with / });
    expect(picks).toHaveLength(REACTION_EMOJI.length);
    await user.click(screen.getByRole('button', { name: 'React with 🎉' }));
    await waitFor(() => expect(mocks.enqueue).toHaveBeenCalledTimes(1));
    expect(mocks.enqueue.mock.calls[0]?.[0].method).toBe('PUT');
  });

  it('edits an own comment with a PATCH, and the new text shows at once', async () => {
    const { user } = await setup([comment(C1, { author_id: ME, body: 'Typo' })]);
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Edit' }));
    const box = screen.getByRole('textbox', { name: 'Edit' });
    expect(box).toHaveValue('Typo');
    await user.clear(box);
    await user.type(box, 'Fixed');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mocks.enqueue).toHaveBeenCalledTimes(1));
    expect(mocks.enqueue.mock.calls[0]?.[0]).toMatchObject({
      method: 'PATCH',
      path: `/api/w/w1/comments/${C1}`,
      body: { body: 'Fixed' },
    });
    expect(await screen.findByText('Fixed')).toBeInTheDocument();
    expect(screen.getByText('edited')).toBeInTheDocument();
  });

  it('asks before deleting, then sends the DELETE', async () => {
    const { user } = await setup([comment(C1, { author_id: ME })]);
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete comment' }));
    await waitFor(() => expect(mocks.enqueue).toHaveBeenCalledTimes(1));
    expect(mocks.enqueue.mock.calls[0]?.[0]).toMatchObject({
      method: 'DELETE',
      path: `/api/w/w1/comments/${C1}`,
    });
    expect(await screen.findByText('Comment removed')).toBeInTheDocument();
  });
});

describe('CommentThread: edit history', () => {
  it('an edited comment opens its history, earlier texts oldest first and the current one last', async () => {
    mocks.apiFetch.mockResolvedValue({
      edits: [
        { id: 'e1', body: 'First draft', editedBy: ME, createdAt: '2026-11-26T10:10:00Z' },
        { id: 'e2', body: 'Second draft', editedBy: ME, createdAt: '2026-11-26T10:20:00Z' },
      ],
    });
    const { user } = await setup([
      comment(C1, { author_id: ME, body: 'Final text', edited_at: '2026-11-26T10:30:00Z' }),
    ]);
    await user.click(screen.getByRole('button', { name: /edited/ }));
    const history = await screen.findByTestId('edit-history');
    expect(mocks.apiFetch).toHaveBeenCalledWith(
      `/api/w/w1/comments/${C1}/history`,
      expect.anything(),
    );
    await waitFor(() => expect(within(history).getByText('First draft')).toBeInTheDocument());
    const items = within(history)
      .getAllByRole('listitem')
      .map((li) => li.textContent ?? '');
    expect(items[0]).toContain('First draft');
    expect(items[1]).toContain('Second draft');
    expect(items[2]).toContain('Final text');
    expect(items[2]).toContain('Current version');
  });

  it('says when the history cannot be loaded', async () => {
    mocks.apiFetch.mockRejectedValue(new ApiError(0, 'network', 'down'));
    const { user } = await setup([comment(C1, { edited_at: '2026-11-26T10:30:00Z' })]);
    await user.click(screen.getByRole('button', { name: /edited/ }));
    expect(await screen.findByText('The history could not be loaded.')).toBeInTheDocument();
  });
});

describe('CommentThread: compact', () => {
  it('collapses the composer to one line until it is used, and offers no history', async () => {
    const { user } = await setup([comment(C1, { edited_at: '2026-11-26T10:30:00Z' })], {
      compact: true,
    });
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /edited/ })).toBeNull();
    expect(screen.getByText('edited')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add a comment…' }));
    expect(screen.getByRole('textbox', { name: 'Write a comment' })).toBeInTheDocument();
  });
});
