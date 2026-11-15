// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api.ts';
import { LocaleProvider } from '../design/locale.tsx';
import { InvitePanel } from './InvitePanel.tsx';

const teams = [
  { id: '11111111-1111-4111-8111-111111111111', key: 'ENG', name: 'Engineering' },
  { id: '22222222-2222-4222-8222-222222222222', key: 'DOCS', name: 'Docs' },
];

function renderPanel(locale: 'en' | 'it' = 'en', onSubmit = vi.fn().mockResolvedValue(undefined)) {
  render(
    <LocaleProvider locale={locale}>
      <InvitePanel teams={teams} roles={['member', 'guest']} onSubmit={onSubmit} />
    </LocaleProvider>,
  );
  return onSubmit;
}

describe('InvitePanel', () => {
  it('blocks a guest without a team and says why', async () => {
    const onSubmit = renderPanel();
    await userEvent.type(screen.getByLabelText('Email'), 'new-guest@example.test');
    await userEvent.click(screen.getByRole('combobox', { name: 'Role' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Guest' }));
    await userEvent.click(screen.getByRole('button', { name: 'Send invitation' }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Pick at least one team for a guest.',
    );
  });

  it('sends a guest with a team, lower-casing the email', async () => {
    const onSubmit = renderPanel();
    await userEvent.type(screen.getByLabelText('Email'), 'New-Guest@Example.test');
    await userEvent.click(screen.getByRole('combobox', { name: 'Role' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Guest' }));
    await userEvent.click(screen.getByRole('checkbox', { name: /Engineering/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Send invitation' }));

    expect(onSubmit).toHaveBeenCalledWith({
      email: 'new-guest@example.test',
      role: 'guest',
      teamIds: [teams[0]?.id],
      locale: 'en',
    });
  });

  it('shows the translated text of a refusal, not the server text', async () => {
    const onSubmit = renderPanel(
      'it',
      vi.fn().mockRejectedValue(new ApiError(409, 'already_member', 'server developer text')),
    );
    await userEvent.type(screen.getByLabelText('Email'), 'member@example.test');
    await userEvent.click(screen.getByRole('button', { name: 'Invia invito' }));

    expect(onSubmit).toHaveBeenCalled();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Questa email appartiene già a un membro dello spazio di lavoro.',
    );
  });

  it('rejects an address that is not an email without calling the server', async () => {
    const onSubmit = renderPanel();
    await userEvent.type(screen.getByLabelText('Email'), 'not-an-email');
    await userEvent.click(screen.getByRole('button', { name: 'Send invitation' }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter a valid email address.');
  });
});
