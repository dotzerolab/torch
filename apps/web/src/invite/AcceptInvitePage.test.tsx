// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Brand } from '@torch/shared/brand';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AcceptInvitePage } from './AcceptInvitePage.tsx';

const brand: Brand = {
  productName: 'Acme Tasks',
  logoLight: '/l.svg',
  logoDark: '/d.svg',
  favicon: '/f.svg',
  accentColor: '#3366ff',
  emailSenderName: 'Acme Tasks',
  emailSenderAddress: 'no-reply@acme.example',
};
const preview = {
  workspaceName: 'Demo',
  email: 'new-guest@example.test',
  role: 'guest',
  teams: [{ key: 'ENG', name: 'Engineering' }],
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  window.history.replaceState({}, '', '/invite#token=abc123');
});
afterEach(() => vi.unstubAllGlobals());

describe('AcceptInvitePage', () => {
  it('removes the token from the address bar on mount, before anything is shown', () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(<AcceptInvitePage brand={brand} locale="en" />);

    expect(window.location.hash).toBe('');
    expect(window.location.pathname).toBe('/invite');
  });

  it('previews the invite with the token in the body, never in the URL', async () => {
    fetchMock.mockResolvedValueOnce(json(preview));
    render(<AcceptInvitePage brand={brand} locale="en" />);

    expect(await screen.findByText('Join Demo on Acme Tasks.')).toBeVisible();
    expect(screen.getByText('You will join as Guest.')).toBeVisible();
    expect(screen.getByText('Invitation for new-guest@example.test.')).toBeVisible();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/invites/preview');
    expect(init.body).toBe(JSON.stringify({ token: 'abc123' }));
  });

  it('accepts with the name typed and goes to the workspace', async () => {
    fetchMock
      .mockResolvedValueOnce(json(preview))
      .mockResolvedValueOnce(json({ workspaces: [{ id: 'w1' }] }));
    render(<AcceptInvitePage brand={brand} locale="en" />);

    await userEvent.type(await screen.findByLabelText('Your name'), 'Nora Guest');
    await userEvent.click(screen.getByRole('button', { name: 'Join the workspace' }));

    await waitFor(() => expect(window.location.pathname).toBe('/'));
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('/api/invites/accept');
    expect(init.body).toBe(JSON.stringify({ token: 'abc123', name: 'Nora Guest' }));
  });

  it('says the link is not valid for an invite the server refuses', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'invite_invalid', message: 'x' }, 400));
    render(<AcceptInvitePage brand={brand} locale="en" />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This invitation link is not valid. It may have expired or been used already. Ask for a new one.',
    );
  });

  it('says the link is not valid when there is no token at all', async () => {
    window.history.replaceState({}, '', '/invite');
    render(<AcceptInvitePage brand={brand} locale="en" />);

    expect(await screen.findByRole('alert')).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
