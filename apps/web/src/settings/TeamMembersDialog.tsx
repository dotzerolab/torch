import { useLiveQuery } from '@tanstack/react-db';
import { X } from 'lucide-react';
import { useState } from 'react';
import { Avatar } from '../design/components/Avatar.tsx';
import { Button } from '../design/components/Button.tsx';
import { Dialog } from '../design/components/Dialog.tsx';
import { IconButton } from '../design/components/IconButton.tsx';
import { Select } from '../design/components/Select.tsx';
import { useLocale, useT } from '../design/locale.tsx';
import { adminFailureMessage } from '../errors.ts';
import {
  awaitSynced,
  membersCollection,
  type SyncedTeam,
  teamMembersCollection,
} from '../sync/collections.ts';
import { adminApi } from './admin-api.ts';

/** Who is in one team, with a way to add and remove people. Opened only for people who may manage the team. */
export function TeamMembersDialog({
  workspaceId,
  team,
  onClose,
}: {
  workspaceId: string;
  team: SyncedTeam;
  onClose: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const memberRows = membersCollection(workspaceId);
  const teamRows = teamMembersCollection(workspaceId, team.id);
  const people = useLiveQuery({
    query: (q) => q.from({ member: memberRows }).orderBy(({ member }) => member.name),
  });
  const inTeam = useLiveQuery({ query: (q) => q.from({ row: teamRows }) });
  const [picked, setPicked] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const memberIds = new Set(inTeam.data.map((row) => row.member_id));
  const current = people.data.filter((member) => memberIds.has(member.id));
  const candidates = people.data.filter(
    (member) => !memberIds.has(member.id) && !member.deactivated_at,
  );

  async function run(write: () => Promise<{ txid: number }>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { txid } = await write();
      await awaitSynced(teamRows, txid);
    } catch (failure) {
      setError(adminFailureMessage(locale, failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t('settings.teams.membersOf', { name: team.name })}
      description={t('settings.teams.membersDescription')}
    >
      <div className="team-members" data-testid={`team-members-${team.key}`}>
        {inTeam.isReady && current.length === 0 ? (
          <p className="form__hint">{t('settings.teams.noMembers')}</p>
        ) : (
          <ul className="team-members__list">
            {current.map((member) => (
              <li key={member.id} className="team-members__row">
                <Avatar name={member.name} size="sm" />
                <span className="team-members__name">{member.name}</span>
                <IconButton
                  label={t('settings.teams.removeFor', { name: member.name })}
                  icon={<X size={14} aria-hidden="true" />}
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void run(() => adminApi.removeTeamMember(workspaceId, team.id, member.id))
                  }
                />
              </li>
            ))}
          </ul>
        )}
        <div className="team-members__add">
          {candidates.length === 0 ? (
            <p className="form__hint">{t('settings.teams.nobodyToAdd')}</p>
          ) : (
            <>
              <Select
                label={t('settings.teams.addMember')}
                placeholder={t('settings.teams.addMember')}
                value={picked}
                onValueChange={setPicked}
                options={candidates.map((member) => ({ value: member.id, label: member.name }))}
              />
              <Button
                variant="primary"
                disabled={picked === '' || busy}
                onClick={() =>
                  void run(async () => {
                    const written = await adminApi.addTeamMember(workspaceId, team.id, picked);
                    setPicked('');
                    return written;
                  })
                }
              >
                {t('settings.teams.add')}
              </Button>
            </>
          )}
        </div>
        {error ? (
          <p className="form__error" role="alert" data-testid="team-members-error">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
