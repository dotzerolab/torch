// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api.ts';
import { LocaleProvider } from '../design/index.ts';

const mocks = vi.hoisted(() => ({ enqueue: vi.fn() }));
vi.mock('../sync/shapes.ts', () => ({
  syncRegistry: { get: () => ({}), refresh: () => {} },
  useShape: () => ({}),
}));
vi.mock('../sync/outbox.ts', () => ({
  enqueueWrite: mocks.enqueue,
  pendingCount: () => 0,
  subscribePending: () => () => {},
}));

import { DocumentEditor } from './DocumentEditor.tsx';

type Props = Partial<React.ComponentProps<typeof DocumentEditor>>;
const view = (props: Props = {}) => (
  <LocaleProvider locale="en">
    <DocumentEditor
      workspaceId="w1"
      teamId="t1"
      documentId="d1"
      title="Plan"
      body="Original text"
      readOnly={false}
      {...props}
    />
  </LocaleProvider>
);
const titleField = () => screen.getByRole('textbox', { name: 'Title' });
const bodyField = () => screen.getByRole('textbox', { name: 'Document text' });

beforeEach(() => {
  mocks.enqueue.mockReset();
  mocks.enqueue.mockResolvedValue({ txid: 1 });
});

describe('DocumentEditor: saving', () => {
  it('leaving the text field sends a PATCH with only what changed, once', async () => {
    const user = userEvent.setup();
    render(view());
    await user.type(bodyField(), ' and more');
    await user.tab();
    await waitFor(() => expect(mocks.enqueue).toHaveBeenCalledTimes(1));
    expect(mocks.enqueue.mock.calls[0]?.[0]).toMatchObject({
      workspaceId: 'w1',
      teamId: 't1',
      method: 'PATCH',
      path: '/api/w/w1/documents/d1',
      body: { body: 'Original text and more' },
    });
    expect(typeof mocks.enqueue.mock.calls[0]?.[0].idempotencyKey).toBe('string');

    // Leaving it again, or pressing the key, with nothing new to send, sends nothing.
    await user.click(bodyField());
    await user.tab();
    await user.keyboard('{Control>}s{/Control}');
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  });

  it('Ctrl+S saves the title, trimmed', async () => {
    const user = userEvent.setup();
    render(view());
    await user.clear(titleField());
    await user.type(titleField(), '  New plan  ');
    await user.keyboard('{Control>}s{/Control}');
    await waitFor(() => expect(mocks.enqueue).toHaveBeenCalledTimes(1));
    expect(mocks.enqueue.mock.calls[0]?.[0].body).toEqual({ title: 'New plan' });
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  it('shows an unsaved change and the save button until it is sent', async () => {
    const user = userEvent.setup();
    render(view());
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await user.type(bodyField(), '!');
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('a refused save keeps the draft, says why, and the next save sends the difference again', async () => {
    mocks.enqueue.mockRejectedValueOnce(new ApiError(409, 'document_archived', 'archived'));
    const user = userEvent.setup();
    render(view());
    await user.type(bodyField(), ' edit');
    await user.tab();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This document is archived. Unarchive it to edit.',
    );
    expect(bodyField()).toHaveValue('Original text edit');

    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mocks.enqueue).toHaveBeenCalledTimes(2));
    expect(mocks.enqueue.mock.calls[1]?.[0].body).toEqual({ body: 'Original text edit' });
  });

  it('a blank title is refused before any request', async () => {
    const user = userEvent.setup();
    render(view());
    await user.clear(titleField());
    await user.tab();
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The title or the text is not valid.',
    );
  });
});

describe('DocumentEditor: preview and read-only', () => {
  it('previews through the inert renderer', async () => {
    const user = userEvent.setup();
    const { container } = render(
      view({
        body: '**bold** <script>alert(1)</script> [x](javascript:alert(1)) <img src=x onerror=1>',
      }),
    );
    await user.click(screen.getByRole('tab', { name: 'Preview' }));
    expect(container.querySelector('strong')?.textContent).toBe('bold');
    for (const tag of ['script', 'img', 'a']) expect(container.querySelector(tag)).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Document text' })).toBeNull();
    await user.click(screen.getByRole('tab', { name: 'Write' }));
    expect(bodyField()).toBeInTheDocument();
  });

  it('a read-only document shows its text and no field', () => {
    render(view({ readOnly: true, body: '# Heading\n\ntext' }));
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Plan' })).toBeInTheDocument();
    expect(screen.getByText('text')).toBeInTheDocument();
  });
});

describe('DocumentEditor: what others save, and restored versions', () => {
  it('takes the text others saved while the person has changed nothing', async () => {
    const { rerender } = render(view());
    rerender(view({ title: 'Plan v2', body: 'Remote text' }));
    await waitFor(() => expect(bodyField()).toHaveValue('Remote text'));
    expect(titleField()).toHaveValue('Plan v2');
  });

  it('keeps the draft over what others saved while the person has unsaved changes', async () => {
    const user = userEvent.setup();
    const { rerender } = render(view());
    await user.type(bodyField(), ' mine');
    rerender(view({ body: 'Remote text' }));
    expect(bodyField()).toHaveValue('Original text mine');
  });

  it('a restored version fills the fields and is not saved by itself', async () => {
    const { rerender } = render(view());
    await act(async () => {
      rerender(view({ restored: { title: 'Old plan', body: 'Old text', at: 1 } }));
    });
    expect(titleField()).toHaveValue('Old plan');
    expect(bodyField()).toHaveValue('Old text');
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
  });
});
