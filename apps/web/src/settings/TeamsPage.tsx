import { teamCreateInput } from '@torch/shared/mutations/admin';
import { canListPrivateTeams, canManageTeams } from '@torch/shared/permissions';
import { Lock, Plus, Users } from 'lucide-react';
import { type FormEvent, useEffect, useId, useState } from 'react';
import type { SessionWorkspace } from '../auth/useSession.ts';
import { Badge } from '../design/components/Badge.tsx';
import { Button } from '../design/components/Button.tsx';
import { Dialog } from '../design/components/Dialog.tsx';
import { EmptyState } from '../design/components/EmptyState.tsx';
import { Input } from '../design/components/Input.tsx';
import { useToast } from '../design/components/Toast.tsx';
import { useLocale, useT } from '../design/locale.tsx';
import { adminFailureMessage } from '../errors.ts';
import { useTeams } from '../shell/useTeams.ts';
import { awaitSynced, type SyncedTeam } from '../sync/collections.ts';
import { membersCollection, teamsCollection } from '../sync/shapes.ts';
import { actorOf } from './access.ts';
import { adminApi, type DirectoryTeam } from './admin-api.ts';
import { TeamMembersDialog } from './TeamMembersDialog.tsx';
import { useRest } from './useRest.ts';

function NewTeamDialog({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const ids = useId();
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [isPrivate, setPrivate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError(null);
    const input = teamCreateInput.safeParse({
      key: key.trim().toUpperCase(),
      name,
      private: isPrivate,
    });
    if (!input.success) {
      setError(t('settings.teams.invalid'));
      return;
    }
    setBusy(true);
    try {
      const { txid } = await adminApi.createTeam(workspaceId, input.data);
      // A private team is not in the shape this page already has open (the shape follows the memberships the page
      // loaded with), so it shows up with the next refresh of the shape; waiting for it here would only hold the dialog.
      if (!input.data.private) await awaitSynced(teamsCollection(workspaceId), txid);
      toast.show({ message: t('settings.teams.created', { name: input.data.name }) });
      onClose();
    } catch (failure) {
      setError(adminFailureMessage(locale, failure));
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t('settings.teams.newTitle')}
    >
      <form className="form" onSubmit={submit} noValidate data-testid="new-team-form">
        <div className="form__row">
          <label className="form__label" htmlFor={`${ids}-key`}>
            {t('settings.teams.key')}
          </label>
          <Input
            id={`${ids}-key`}
            value={key}
            maxLength={7}
            autoComplete="off"
            className="field--mono"
            onChange={(event) => setKey(event.target.value.toUpperCase())}
          />
          <p className="form__hint">{t('settings.teams.keyHint')}</p>
        </div>
        <div className="form__row">
          <label className="form__label" htmlFor={`${ids}-name`}>
            {t('settings.teams.name')}
          </label>
          <Input
            id={`${ids}-name`}
            value={name}
            maxLength={80}
            autoComplete="off"
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <label className="checklist__item">
          <input
            type="checkbox"
            checked={isPrivate}
            onChange={(event) => setPrivate(event.target.checked)}
          />
          <span>{t('settings.teams.private')}</span>
        </label>
        <p className="form__hint">{t('settings.teams.privateHint')}</p>
        {error ? (
          <p className="form__error" role="alert" data-testid="new-team-error">
            {error}
          </p>
        ) : null}
        <div className="form__actions">
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" variant="primary" loading={busy} data-testid="new-team-submit">
            {t('settings.teams.create')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function PrivateTeamDirectory({
  workspace,
  teams,
}: {
  workspace: SessionWorkspace;
  teams: DirectoryTeam[];
}) {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const directory = useRest(() => adminApi.privateTeams(workspace.id));
  const shown = directory.state.status === 'ready' ? directory.state.data.teams : teams;

  async function join(team: DirectoryTeam) {
    setBusy(team.id);
    try {
      await adminApi.addTeamMember(workspace.id, team.id, workspace.memberId);
      // The team joins the sidebar with the next refresh of the teams shape (it follows the memberships the page
      // loaded with), not at once: the directory below already shows the new state.
      await directory.reload();
      toast.show({ message: t('settings.teams.directory.joinedNow', { name: team.name }) });
    } catch (failure) {
      toast.show({ message: adminFailureMessage(locale, failure), tone: 'error' });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section
      className="settings-section"
      aria-labelledby="directory-title"
      data-testid="private-directory"
    >
      <h3 className="settings-section__title" id="directory-title">
        {t('settings.teams.directory.title')}
      </h3>
      <p className="form__hint">{t('settings.teams.directory.description')}</p>
      {directory.state.status === 'error' ? (
        <p className="settings-note" role="alert">
          {adminFailureMessage(locale, directory.state.error)}
        </p>
      ) : shown.length === 0 ? (
        <EmptyState title={t('settings.teams.directory.empty')} />
      ) : (
        <ul className="team-list">
          {shown.map((team) => (
            <li key={team.id} className="team-list__row" data-testid={`directory-${team.key}`}>
              <span className="team-list__key">{team.key}</span>
              <span className="team-list__name">{team.name}</span>
              <span className="team-list__count">
                {t('settings.teams.directory.count', { count: String(team.memberCount) })}
              </span>
              <span className="team-list__actions">
                {team.isMember ? (
                  <Badge tone="success">{t('settings.teams.directory.joined')}</Badge>
                ) : (
                  <Button size="sm" loading={busy === team.id} onClick={() => void join(team)}>
                    {t('settings.teams.directory.join')}
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function TeamRow({
  workspaceId,
  team,
  canManage,
  onEditMembers,
}: {
  workspaceId: string;
  team: SyncedTeam;
  canManage: boolean;
  onEditMembers: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function setPrivate(next: boolean) {
    setBusy(true);
    try {
      const { txid } = await adminApi.updateTeam(workspaceId, team.id, { private: next });
      await awaitSynced(teamsCollection(workspaceId), txid);
    } catch (failure) {
      toast.show({ message: adminFailureMessage(locale, failure), tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="team-list__row" data-testid={`team-row-${team.key}`}>
      <span className="team-list__key">{team.key}</span>
      <span className="team-list__name">{team.name}</span>
      {canManage ? null : (
        <span className="team-list__count">
          {team.private ? (
            <Badge>
              <Lock size={11} aria-hidden="true" /> {t('settings.teams.private')}
            </Badge>
          ) : null}
        </span>
      )}
      {canManage ? (
        <span className="team-list__actions">
          <label className="switch">
            <input
              type="checkbox"
              role="switch"
              aria-checked={team.private}
              checked={team.private}
              disabled={busy}
              aria-label={t('settings.teams.privacyOf', { name: team.name })}
              onChange={(event) => void setPrivate(event.target.checked)}
            />
            <span className="switch__track" aria-hidden="true" />
            <span className="switch__label" aria-hidden="true">
              {t('settings.teams.private')}
            </span>
          </label>
          <Button size="sm" onClick={onEditMembers} data-testid={`team-members-open-${team.key}`}>
            <Users size={14} aria-hidden="true" />
            {t('settings.teams.members')}
          </Button>
        </span>
      ) : null}
    </li>
  );
}

/** The teams of the workspace: everybody reads the list; owners and admins create teams, flip privacy and edit members. */
export function TeamsPage({ workspace }: { workspace: SessionWorkspace }) {
  const t = useT();
  const actor = actorOf(workspace);
  const canManage = canManageTeams(actor);
  const { teams, ready } = useTeams(workspace.id);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const editedTeam = teams.find((team) => team.id === editing) ?? null;
  // Start the members shape while the list is on screen, so the member picker has its people when the dialog opens.
  useEffect(() => {
    if (canManage) void membersCollection(workspace.id).preload();
  }, [canManage, workspace.id]);

  return (
    <div className="settings-page" data-testid="teams-page">
      <div className="settings-page__head">
        <h2 className="settings-page__title">{t('settings.teams.title')}</h2>
        {canManage ? (
          <Button variant="primary" onClick={() => setCreating(true)} data-testid="new-team-open">
            <Plus size={14} aria-hidden="true" />
            {t('settings.teams.new')}
          </Button>
        ) : null}
      </div>

      {!ready ? (
        <p className="settings-note" aria-busy="true">
          {t('settings.loading')}
        </p>
      ) : teams.length === 0 ? (
        <EmptyState title={t('settings.teams.empty')} />
      ) : (
        <ul className="team-list" data-testid="team-list">
          {teams.map((team) => (
            <TeamRow
              key={team.id}
              workspaceId={workspace.id}
              team={team}
              canManage={canManage}
              onEditMembers={() => setEditing(team.id)}
            />
          ))}
        </ul>
      )}

      {canListPrivateTeams(actor) ? (
        <PrivateTeamDirectory workspace={workspace} teams={[]} />
      ) : null}

      {creating ? (
        <NewTeamDialog workspaceId={workspace.id} onClose={() => setCreating(false)} />
      ) : null}
      {editedTeam ? (
        <TeamMembersDialog
          workspaceId={workspace.id}
          team={editedTeam}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}
