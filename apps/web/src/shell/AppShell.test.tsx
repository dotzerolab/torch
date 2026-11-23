// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Brand } from '@torch/shared/brand';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionWorkspace } from '../auth/useSession.ts';
import { THEME_STORAGE_KEY } from '../design/theme.ts';
import { AppShell } from './AppShell.tsx';

vi.mock('./useDeviceStore.ts', () => ({ useDeviceStore: () => true }));
vi.mock('./useDeviceSession.ts', () => ({ useDeviceSession: () => true }));
vi.mock('./useSignOutElsewhere.ts', () => ({ useSignOutElsewhere: () => {} }));
vi.mock('./useMembershipWatcher.ts', () => ({ useMembershipWatcher: () => {} }));
vi.mock('./useOutboxEvents.ts', () => ({ useOutboxEvents: () => {} }));
vi.mock('./useTeams.ts', () => ({
  useTeams: () => ({
    ready: true,
    teams: [
      { id: 't1', workspace_id: 'w1', key: 'ENG', name: 'Engineering', private: false },
      { id: 't2', workspace_id: 'w1', key: 'OPS', name: 'Operations', private: false },
    ],
  }),
}));

const brand: Brand = {
  productName: 'Acme Tasks',
  logoLight: '/acme/logo-light.svg',
  logoDark: '/acme/logo-dark.svg',
  favicon: '/acme/favicon.svg',
  accentColor: '#3366ff',
  emailSenderName: 'Acme Tasks',
  emailSenderAddress: 'no-reply@acme.example',
};
const workspaces: SessionWorkspace[] = [
  { id: 'w1', name: 'Demo', slug: 'demo', memberId: 'm1', role: 'owner' },
];

/** matchMedia that answers the width queries from window.innerWidth and the colour scheme from `dark`. */
function stubViewport({ width, dark = false }: { width: number; dark?: boolean }) {
  window.innerWidth = width;
  window.matchMedia = ((query: string) => ({
    matches: query.includes('prefers-color-scheme')
      ? dark
      : query.includes('max-width')
        ? width < 768
        : false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
}

function renderShell() {
  return render(
    <AppShell brand={brand} workspaces={workspaces} locale="en">
      <p>Page content</p>
    </AppShell>,
  );
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  window.history.replaceState({}, '', '/');
  stubViewport({ width: 1280 });
});
afterEach(() => localStorage.clear());

describe('AppShell on a desktop', () => {
  it('shows the brand logo with the product name as its alt text', () => {
    renderShell();
    const logo = screen.getByRole('img', { name: 'Acme Tasks' });
    expect(logo).toHaveAttribute('src', '/acme/logo-light.svg');
  });

  it('shows the dark logo when the theme resolves to dark', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    renderShell();
    expect(screen.getByRole('img', { name: 'Acme Tasks' })).toHaveAttribute(
      'src',
      '/acme/logo-dark.svg',
    );
  });

  it('puts a skip link first in the tab order, pointing at the main region', async () => {
    renderShell();
    await userEvent.tab();
    const skip = screen.getByRole('link', { name: 'Skip to content' });
    expect(skip).toHaveFocus();
    expect(skip).toHaveAttribute('href', '#main');
    const main = screen.getByRole('main');
    expect(main).toHaveAttribute('id', 'main');
    expect(main).toHaveTextContent('Page content');
  });

  it('lists the synced teams as links and the placeholders as disabled', () => {
    renderShell();
    const eng = screen.getByRole('link', { name: /Engineering/ });
    expect(eng).toHaveAttribute('href', '/teams/ENG');
    expect(screen.getByRole('link', { name: /Operations/ })).toHaveAttribute('href', '/teams/OPS');
    expect(screen.getByText('My issues').closest('[aria-disabled]')).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByText('Inbox').closest('[aria-disabled]')).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('marks the team of the current address and names it in the header', () => {
    window.history.replaceState({}, '', '/teams/OPS');
    renderShell();
    expect(screen.getByRole('link', { name: /Operations/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Operations');
    expect(screen.getByTestId('workspace-name')).toHaveTextContent('Demo');
  });

  it('hides and shows the sidebar with mod+/', () => {
    renderShell();
    expect(screen.getByRole('navigation', { name: 'Sidebar' })).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: '/', ctrlKey: true });
    expect(screen.queryByRole('navigation', { name: 'Sidebar' })).not.toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: '/', ctrlKey: true });
    expect(screen.getByRole('navigation', { name: 'Sidebar' })).toBeInTheDocument();
  });

  it('applies a theme choice from the theme menu and stores it', async () => {
    renderShell();
    screen.getByRole('button', { name: 'Theme' }).focus();
    await userEvent.keyboard('{ArrowDown}');
    await userEvent.click(await screen.findByRole('menuitem', { name: /Dark/ }));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'));
  });

  it('opens the shortcut list with ?', async () => {
    renderShell();
    fireEvent.keyDown(document.body, { key: '?', shiftKey: true });
    expect(await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })).toHaveTextContent(
      'Toggle sidebar',
    );
  });
});

describe('AppShell on a phone', () => {
  beforeEach(() => stubViewport({ width: 375 }));

  it('keeps the sidebar out until the header button opens it as a dialog', async () => {
    renderShell();
    expect(screen.queryByRole('navigation', { name: 'Sidebar' })).not.toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: 'Open sidebar' });
    await userEvent.click(toggle);
    const dialog = await screen.findByRole('dialog', { name: 'Sidebar' });
    expect(dialog).toHaveTextContent('Engineering');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(toggle).toHaveFocus());
  });

  it('closes the drawer after a team is chosen', async () => {
    renderShell();
    await userEvent.click(screen.getByRole('button', { name: 'Open sidebar' }));
    await userEvent.click(await screen.findByRole('link', { name: /Engineering/ }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(window.location.pathname).toBe('/teams/ENG');
  });
});

describe('AppShell language', () => {
  it('speaks Italian when asked to', () => {
    act(() => {});
    render(
      <AppShell brand={brand} workspaces={workspaces} locale="it">
        <p>Contenuto</p>
      </AppShell>,
    );
    expect(screen.getByRole('link', { name: 'Vai al contenuto' })).toHaveAttribute('href', '#main');
  });
});
