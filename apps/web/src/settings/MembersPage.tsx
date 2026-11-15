import { useLiveQuery } from '@tanstack/react-db';
import { canManageMembers } from '@torch/shared/permissions';
import { Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { SessionWorkspace } from '../auth/useSession.ts';
import { Badge } from '../design/components/Badge.tsx';
import { Button } from '../design/components/Button.tsx';
import { Dialog } from '../design/components/Dialog.tsx';
import { useToast } from '../design/components/Toast.tsx';
import { useLocale, useT } from '../design/locale.tsx';
import { adminFailureMessage } from '../errors.ts';
import { useTeams } from '../shell/useTeams.ts';
import { awaitSynced } from '../sync/collections.ts';
import { useShape } from '../sync/shapes.ts';
import { actorOf, assignableRoles } from './access.ts';
import { type AdminInvite, adminApi } from './admin-api.ts';
import { InvitePanel } from './InvitePanel.tsx';
import { type MemberRow, MembersTable } from './MembersTable.tsx';
import { NoAccess } from './NoAccess.tsx';
import { useRest } from './useRest.ts';

type Confirm = { row: MemberRow; reactivate: boolean };

/** Members, pending invitations and the invite form: owners and admins only (the server decides again on every call). */
export function MembersPage({ workspace }: { workspace: SessionWorkspace }) {
  const actor = actorOf(workspace);
  if (!canManageMembers(actor)) return <NoAccess />;
  return <MembersAdmin workspace={workspace} />;
}

function MembersAdmin({ workspace }: { workspace: SessionWorkspace }) {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const actor = actorOf(workspace);
  const wsId = workspace.id;
  const collection = useShape({ kind: 'members', workspaceId: wsId });
  const { teams } = useTeams(wsId);

  // The rows come from the synced `member` shape (live: a deactivation by another admin shows up at once); the
  // emails, which never travel in a shape, come from the admin list and are matched by id.
  const synced = useLiveQuery({
    query: (q) =>
      q
        .from({ member: collection })
        .orderBy(({ member }) => member.created_at)
        .orderBy(({ member }) => member.name),
  });
  const list = useRest(() => adminApi.members(wsId));
  const invites = useRest(() => adminApi.invites(wsId));
  const emails = useMemo(
    () =>
      new Map(
        list.state.status === 'ready' ? list.state.data.members.map((m) => [m.id, m.email]) : [],
      ),
    [list.state],
  );
  const rows: MemberRow[] = synced.data.map((member) => ({
    id: member.id,
    name: member.name,
    handle: member.handle,
    email: emails.get(member.id) ?? '',
    role: member.role,
    deactivatedAt: member.deactivated_at,
  }));

  const [inviteOpen, setInviteOpen] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function changeRole(row: MemberRow, role: MemberRow['role']) {
    try {
      const { txid } = await adminApi.changeRole(wsId, row.id, role);
      await awaitSynced(collection, txid);
      await list.reload();
      toast.show({ message: t('settings.members.roleChanged') });
    } catch (failure) {
      toast.show({ message: adminFailureMessage(locale, failure), tone: 'error' });
    }
  }

  async function runConfirmed() {
    if (!confirm || busy) return;
    setBusy(true);
    setConfirmError(null);
    try {
      const { txid } = await adminApi.setActive(wsId, confirm.row.id, confirm.reactivate);
      await awaitSynced(collection, txid);
      await list.reload();
      toast.show({
        message: t(
          confirm.reactivate
            ? 'settings.members.reactivated.done'
            : 'settings.members.deactivated.done',
          { name: confirm.row.name },
        ),
      });
      setConfirm(null);
    } catch (failure) {
      setConfirmError(adminFailureMessage(locale, failure));
    } finally {
      setBusy(false);
    }
  }

  async function invite(input: Parameters<typeof adminApi.createInvite>[1]) {
    await adminApi.createInvite(wsId, input);
    await invites.reload();
    setInviteOpen(false);
    toast.show({ message: t('settings.invite.sent', { email: input.email }) });
  }

  async function resend(item: AdminInvite) {
    try {
      await adminApi.resendInvite(wsId, item.id);
      await invites.reload();
      toast.show({ message: t('settings.invites.resent', { email: item.email }) });
    } catch (failure) {
      toast.show({ message: adminFailureMessage(locale, failure), tone: 'error' });
    }
  }

  async function revoke(item: AdminInvite) {
    try {
      await adminApi.revokeInvite(wsId, item.id);
      await invites.reload();
      toast.show({ message: t('settings.invites.revoked', { email: item.email }) });
    } catch (failure) {
      toast.show({ message: adminFailureMessage(locale, failure), tone: 'error' });
    }
  }

  const dates = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });
  const teamKey = (id: string) => teams.find((team) => team.id === id)?.key ?? '';

  return (
    <div className="settings-page" data-testid="members-page">
      <div className="settings-page__head">
        <h2 className="settings-page__title">{t('settings.members.title')}</h2>
        <Button variant="primary" onClick={() => setInviteOpen(true)} data-testid="invite-open">
          <Plus size={14} aria-hidden="true" />
          {t('settings.members.invite')}
        </Button>
      </div>

      {!synced.isReady ? (
        <p className="settings-note" aria-busy="true">
          {t('settings.loading')}
        </p>
      ) : (
        <MembersTable
          rows={rows}
          actor={actor}
          onChangeRole={(row, role) => void changeRole(row, role)}
          onToggleActive={(row) => {
            setConfirmError(null);
            setConfirm({ row, reactivate: row.deactivatedAt !== null });
          }}
        />
      )}

      <section className="settings-section" aria-labelledby="invites-title">
        <h3 className="settings-section__title" id="invites-title">
          {t('settings.invites.title')}
        </h3>
        {invites.state.status === 'error' ? (
          <p className="settings-note" role="alert">
            {adminFailureMessage(locale, invites.state.error)}
          </p>
        ) : invites.state.status === 'ready' && invites.state.data.invites.length === 0 ? (
          <p className="settings-note">{t('settings.invites.none')}</p>
        ) : invites.state.status === 'ready' ? (
          <ul className="invite-list" data-testid="invite-list">
            {invites.state.data.invites.map((item) => (
              <li key={item.id} className="invite-list__row" data-testid={`invite-${item.email}`}>
                <span className="invite-list__email">{item.email}</span>
                <Badge tone="accent">{t(`settings.role.${item.role}`)}</Badge>
                <span className="invite-list__teams">
                  {item.teamIds.map(teamKey).filter(Boolean).join(', ')}
                </span>
                <span className="invite-list__expires">
                  {t('settings.invites.expires', { date: dates.format(new Date(item.expiresAt)) })}
                </span>
                <span className="invite-list__actions">
                  <Button size="sm" onClick={() => void resend(item)}>
                    {t('settings.invites.resend')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void revoke(item)}>
                    {t('settings.invites.revoke')}
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <Dialog open={inviteOpen} onOpenChange={setInviteOpen} title={t('settings.invite.title')}>
        <InvitePanel
          teams={teams.map(({ id, key, name }) => ({ id, key, name }))}
          roles={assignableRoles(actor)}
          onSubmit={invite}
        />
      </Dialog>

      <Dialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        title={
          confirm
            ? t(
                confirm.reactivate
                  ? 'settings.members.reactivateTitle'
                  : 'settings.members.deactivateTitle',
                {
                  name: confirm.row.name,
                },
              )
            : ''
        }
        description={
          confirm
            ? t(
                confirm.reactivate
                  ? 'settings.members.reactivateBody'
                  : 'settings.members.deactivateBody',
                {
                  name: confirm.row.name,
                },
              )
            : undefined
        }
      >
        {confirmError ? (
          <p className="form__error" role="alert">
            {confirmError}
          </p>
        ) : null}
        <div className="form__actions">
          <Button onClick={() => setConfirm(null)}>{t('common.cancel')}</Button>
          <Button
            variant={confirm?.reactivate ? 'primary' : 'danger'}
            loading={busy}
            onClick={() => void runConfirmed()}
            data-testid="confirm-toggle"
          >
            {t(confirm?.reactivate ? 'settings.members.reactivate' : 'settings.members.deactivate')}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
