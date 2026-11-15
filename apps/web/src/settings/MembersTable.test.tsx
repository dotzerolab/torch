// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Actor } from '@torch/shared/permissions';
import { describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '../design/locale.tsx';
import { type MemberRow, MembersTable } from './MembersTable.tsx';

const row = (
  id: string,
  name: string,
  role: MemberRow['role'],
  extra: Partial<MemberRow> = {},
) => ({
  id,
  name,
  handle: name.toLowerCase(),
  email: `${name.toLowerCase()}@example.test`,
  role,
  deactivatedAt: null,
  ...extra,
});
const rows: MemberRow[] = [
  row('m-owner', 'Olivia', 'owner'),
  row('m-admin', 'Adam', 'admin'),
  row('m-member', 'Mia', 'member'),
  row('m-guest', 'Gus', 'guest', { deactivatedAt: '2026-11-01T10:00:00.000Z' }),
];
const actorOf = (role: Actor['role'], memberId: string): Actor => ({
  workspaceId: 'w1',
  memberId,
  role,
  teamIds: new Set(),
});

function renderTable(actor: Actor, handlers = {}) {
  const props = { onChangeRole: vi.fn(), onToggleActive: vi.fn(), ...handlers };
  render(
    <LocaleProvider locale="en">
      <MembersTable rows={rows} actor={actor} {...props} />
    </LocaleProvider>,
  );
  return props;
}

async function optionsOf(name: string): Promise<string[]> {
  await userEvent.click(screen.getByRole('combobox', { name }));
  const list = await screen.findByRole('listbox');
  const labels = within(list)
    .getAllByRole('option')
    .map((option) => option.textContent ?? '');
  await userEvent.keyboard('{Escape}');
  return labels;
}

describe('MembersTable', () => {
  it('offers an admin member and guest only, on a member', async () => {
    renderTable(actorOf('admin', 'm-admin'));
    expect(await optionsOf('Role of Mia')).toEqual(['Member', 'Guest']);
  });

  it('offers an owner all four roles', async () => {
    renderTable(actorOf('owner', 'm-owner'));
    expect(await optionsOf('Role of Mia')).toEqual(['Owner', 'Admin', 'Member', 'Guest']);
  });

  it('disables the select on the own row', () => {
    renderTable(actorOf('owner', 'm-owner'));
    expect(screen.getByRole('combobox', { name: 'Role of Olivia' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Role of Mia' })).toBeEnabled();
  });

  it('disables the select on an admin and an owner for an admin', () => {
    renderTable(actorOf('admin', 'm-admin'));
    expect(screen.getByRole('combobox', { name: 'Role of Olivia' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Role of Adam' })).toBeDisabled();
  });

  it('reports the chosen role with the member', async () => {
    const { onChangeRole } = renderTable(actorOf('admin', 'm-admin'));
    await userEvent.click(screen.getByRole('combobox', { name: 'Role of Mia' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Guest' }));
    expect(onChangeRole).toHaveBeenCalledWith(expect.objectContaining({ id: 'm-member' }), 'guest');
  });

  it('shows who is deactivated and offers reactivation instead of deactivation', async () => {
    const { onToggleActive } = renderTable(actorOf('owner', 'm-owner'));
    expect(within(screen.getByRole('row', { name: /Gus/ })).getByText('Deactivated')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Actions for Gus' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Reactivate' }));
    expect(onToggleActive).toHaveBeenCalledWith(expect.objectContaining({ id: 'm-guest' }));
  });

  it('has no actions menu on the own row nor on rows the actor may not change', () => {
    renderTable(actorOf('admin', 'm-admin'));
    expect(screen.queryByRole('button', { name: 'Actions for Adam' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Actions for Olivia' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Actions for Mia' })).toBeVisible();
  });
});
