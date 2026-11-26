// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api.ts';
import { LocaleProvider } from '../design/locale.tsx';
import { IssuePanelView } from './IssuePanelView.tsx';
import { makeData, makeRow } from './testing.ts';

function setup(extra: Partial<Parameters<typeof IssuePanelView>[0]> = {}) {
  const props = {
    row: makeRow(3, { priority: 2, assignee_id: 'm2' }, ['l1']),
    data: makeData(),
    teamName: 'Engineering',
    teamKey: 'ENG',
    meId: 'me',
    today: '2026-11-26',
    variant: 'peek' as const,
    description: 'First line\nSecond line',
    subscribed: false,
    error: null,
    onUpdate: vi.fn(),
    onSaveDescription: vi.fn().mockResolvedValue(undefined),
    onToggleSubscribe: vi.fn(),
    onSetArchived: vi.fn(),
    onCopy: vi.fn(),
    onClose: vi.fn(),
    ...extra,
  };
  const user = userEvent.setup();
  render(
    <LocaleProvider locale="en">
      <IssuePanelView {...props} />
    </LocaleProvider>,
  );
  return { user, props };
}

describe('IssuePanelView', () => {
  it('shows the issue: identifier, title, description kept in lines, and its properties', () => {
    setup();
    expect(screen.getByText('ENG-3')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Title of ENG-3/ })).toHaveValue('Issue 3');
    expect(screen.getByTestId('issue-description')).toHaveTextContent('First line Second line');
    expect(screen.getByTestId('issue-description')).toHaveStyle({ whiteSpace: 'pre-wrap' });
    const props = screen.getByRole('group', { name: 'Properties' });
    expect(within(props).getByRole('button', { name: /State/ })).toHaveTextContent('Todo');
    expect(within(props).getByRole('button', { name: /Priority/ })).toHaveTextContent('High');
    expect(within(props).getByRole('button', { name: /Assignee/ })).toHaveTextContent('Bo Sample');
    expect(within(props).getByRole('button', { name: /Labels/ })).toHaveTextContent('Bug');
  });

  it('a title edit is sent on Enter, and not when nothing changed', async () => {
    const { user, props } = setup();
    const title = screen.getByRole('textbox', { name: /Title of ENG-3/ });
    await user.click(title);
    await user.keyboard('{Enter}');
    expect(props.onUpdate).not.toHaveBeenCalled();
    await user.clear(title);
    await user.type(title, 'New title{Enter}');
    expect(props.onUpdate).toHaveBeenCalledWith({ title: 'New title' });
  });

  it('Escape puts the old title back', async () => {
    const { user, props } = setup();
    const title = screen.getByRole('textbox', { name: /Title of ENG-3/ });
    await user.clear(title);
    await user.type(title, 'Oops');
    await user.keyboard('{Escape}');
    expect(title).toHaveValue('Issue 3');
    expect(props.onUpdate).not.toHaveBeenCalled();
  });

  it('a property picker sends its change', async () => {
    const { user, props } = setup();
    await user.click(screen.getByRole('button', { name: /Priority/ }));
    await user.click(await screen.findByRole('option', { name: /^Urgent/ }));
    expect(props.onUpdate).toHaveBeenCalledWith({ priority: 1 });
  });

  it('a description edit sends the text and leaves the editor', async () => {
    const { user, props } = setup();
    await user.click(screen.getByTestId('issue-description'));
    const box = screen.getByRole('textbox', { name: 'Description' });
    await user.clear(box);
    await user.type(box, 'New text');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(props.onSaveDescription).toHaveBeenCalledWith('New text');
    await screen.findByTestId('issue-description');
  });

  it('a refused description write shows a message and keeps the text being edited', async () => {
    const onSaveDescription = vi.fn().mockRejectedValue(new ApiError(403, 'forbidden', 'no'));
    const { user } = setup({ onSaveDescription });
    await user.click(screen.getByTestId('issue-description'));
    const box = screen.getByRole('textbox', { name: 'Description' });
    await user.type(box, ' more');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Description' })).toHaveValue(
      'First line\nSecond line more',
    );
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByTestId('issue-description')).toBeInTheDocument();
  });

  it('an empty description offers to add one', async () => {
    const { user } = setup({ description: '' });
    await user.click(screen.getByRole('button', { name: 'Add a description…' }));
    expect(screen.getByRole('textbox', { name: 'Description' })).toBeInTheDocument();
  });

  it('an archived issue is read-only, says so, and can be unarchived', async () => {
    const { user, props } = setup({
      row: makeRow(3, { archived_at: '2026-11-20T00:00:00Z' }),
    });
    expect(screen.getByText('This issue is archived and read-only.')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Title of ENG-3/ })).toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: /Priority/ })).toBeDisabled();
    await user.click(screen.getByTestId('issue-description'));
    expect(screen.queryByRole('textbox', { name: 'Description' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Unarchive' }));
    expect(props.onSetArchived).toHaveBeenCalledWith(false);
  });

  it('subscribe toggles', async () => {
    const first = setup();
    await first.user.click(screen.getByRole('button', { name: 'Subscribe' }));
    expect(first.props.onToggleSubscribe).toHaveBeenCalledOnce();
  });

  it('a follower sees Unsubscribe, pressed', () => {
    setup({ subscribed: true });
    expect(screen.getByRole('button', { name: 'Unsubscribe' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('the peek closes from its button; the page has a way back to the team instead', async () => {
    const { user, props } = setup();
    await user.click(screen.getByRole('button', { name: 'Close preview' }));
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it('the page shows the team in a breadcrumb', () => {
    setup({ variant: 'page' });
    expect(screen.getByRole('link', { name: 'Engineering' })).toHaveAttribute('href', '/teams/ENG');
    expect(screen.queryByRole('button', { name: 'Close preview' })).not.toBeInTheDocument();
  });

  it('a pending issue (no number yet) is read-only until the server answers', () => {
    setup({ row: { ...makeRow(0), identifier: '', pending: true } });
    expect(screen.getByRole('textbox', { name: /Title of/ })).toHaveAttribute('readonly');
  });
});
