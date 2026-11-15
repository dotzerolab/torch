// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { SessionWorkspace } from '../auth/useSession.ts';
import { LocaleProvider } from '../design/locale.tsx';
import { MembersPage } from './MembersPage.tsx';
import { SettingsLayout } from './SettingsLayout.tsx';

const workspace = (role: SessionWorkspace['role']): SessionWorkspace => ({
  id: 'w1',
  name: 'Demo',
  slug: 'demo',
  memberId: 'm1',
  role,
});

beforeEach(() => window.history.replaceState({}, '', '/settings/profile'));

describe('SettingsLayout', () => {
  it.each(['owner', 'admin'] as const)('lists the members section for %s', (role) => {
    render(
      <LocaleProvider locale="en">
        <SettingsLayout workspace={workspace(role)}>
          <p>page</p>
        </SettingsLayout>
      </LocaleProvider>,
    );
    expect(screen.getByRole('link', { name: 'Members' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Profile' })).toHaveAttribute('aria-current', 'page');
  });

  it.each(['member', 'guest'] as const)('hides the members section from a %s', (role) => {
    render(
      <LocaleProvider locale="en">
        <SettingsLayout workspace={workspace(role)}>
          <p>page</p>
        </SettingsLayout>
      </LocaleProvider>,
    );
    expect(screen.queryByRole('link', { name: 'Members' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Teams' })).toBeVisible();
  });
});

describe('MembersPage', () => {
  it.each(['member', 'guest'] as const)(
    'shows a no-access state to a %s, and nothing else',
    (role) => {
      render(
        <LocaleProvider locale="en">
          <MembersPage workspace={workspace(role)} />
        </LocaleProvider>,
      );
      expect(screen.getByTestId('no-access')).toHaveTextContent(
        'You do not have access to this page',
      );
      expect(screen.queryByTestId('members-table')).toBeNull();
      expect(screen.queryByRole('button', { name: /Invite people/ })).toBeNull();
    },
  );
});
