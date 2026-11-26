// `/issues/ENG-12`: the issue panel as a page. The team comes from the identifier; one the person cannot see is the same
// "not found" as a number that does not exist.
import { useCallback } from 'react';
import { useT } from '../design/locale.tsx';
import { navigate } from '../navigation.ts';
import { splitIdentifier } from '../routes.ts';
import type { SyncedTeam } from '../sync/collections.ts';
import { IssueNotFound, IssuePanel } from './IssuePanel.tsx';

export function IssueDetail({
  workspaceId,
  teams,
  teamsReady,
  identifier,
}: {
  workspaceId: string;
  teams: SyncedTeam[];
  teamsReady: boolean;
  identifier: string;
}) {
  const t = useT();
  const split = splitIdentifier(identifier);
  const team = split ? teams.find((candidate) => candidate.key === split.key) : undefined;
  const back = useCallback(
    () => navigate(team ? `/teams/${encodeURIComponent(team.key)}` : '/', { replace: true }),
    [team],
  );
  if (!teamsReady) {
    return (
      <p className="issues__note" aria-busy="true">
        {t('workspace.loading')}
      </p>
    );
  }
  if (!split || !team) return <IssueNotFound />;
  return (
    <IssuePanel
      key={identifier}
      workspaceId={workspaceId}
      team={team}
      identifier={identifier}
      variant="page"
      onClose={back}
    />
  );
}
