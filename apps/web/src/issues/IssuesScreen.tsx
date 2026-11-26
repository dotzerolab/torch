import type { Locale } from '@torch/shared/i18n';
import { t } from '@torch/shared/i18n';
import type { IssueUpdateInput } from '@torch/shared/mutations/issue';
import { useCallback, useMemo, useState } from 'react';
import { mutationErrorMessage } from '../errors.ts';
import { useLocation } from '../navigation.ts';
import { parseRoute } from '../routes.ts';
import { useShell } from '../shell/ShellContext.ts';
import type { SyncedTeam } from '../sync/collections.ts';
import { useShape } from '../sync/shapes.ts';
import { useIssueRows, useTeamData } from './data.ts';
import { IssuesView } from './IssuesView.tsx';
import { localDay } from './model/day.ts';
import type { IssueRow } from './model/engine.ts';
import { updateIssue } from './mutate.ts';
import { useViewState } from './useViewState.ts';

/** The issues of one team: its rows, grouped and ordered, in the list. */
function TeamIssues({
  workspaceId,
  memberId,
  team,
  locale,
}: {
  workspaceId: string;
  memberId: string;
  team: SyncedTeam;
  locale: Locale;
}) {
  const issues = useShape({ kind: 'issues', workspaceId, teamId: team.id });
  const data = useTeamData(workspaceId, team.id);
  const { rows, ready } = useIssueRows(workspaceId, team);
  const [error, setError] = useState<string | null>(null);
  const today = useMemo(() => localDay(), []);
  const view = useViewState(team.id);

  const update = useCallback(
    (row: IssueRow, patch: IssueUpdateInput) => {
      setError(null);
      // The change shows at once; a refusal rolls it back by itself and lands here with the server's code.
      updateIssue(issues, row.issue, patch).catch((failure: unknown) => {
        setError(mutationErrorMessage(locale, failure));
      });
    },
    [issues, locale],
  );
  const rename = useCallback((row: IssueRow, title: string) => update(row, { title }), [update]);
  const open = useCallback(() => {}, []);

  if (!ready || !data.statesReady) {
    return (
      <p className="issues__note" aria-busy="true">
        {t(locale, 'workspace.loading')}
      </p>
    );
  }
  return (
    <IssuesView
      rows={rows}
      data={data}
      meId={memberId}
      today={today}
      teamKey={team.key}
      teamName={team.name}
      view={view}
      error={error}
      onOpen={open}
      onRename={rename}
      onUpdate={update}
    />
  );
}

/** The screen of the issue routes: a team's issues, one issue, My Issues. */
export function IssuesScreen({ locale }: { locale: Locale }) {
  const { pathname } = useLocation();
  const route = parseRoute(pathname);
  const { workspace, team, teams, teamsReady } = useShell();
  if (route.name === 'myIssues') {
    return <p className="issues__note">{t(locale, 'shell.myIssues')}</p>;
  }
  if (!teamsReady) {
    return (
      <p className="issues__note" aria-busy="true">
        {t(locale, 'workspace.loading')}
      </p>
    );
  }
  if (teams.length === 0 || !team) {
    return <p className="issues__note">{t(locale, 'workspace.noTeams')}</p>;
  }
  return (
    <TeamIssues
      key={team.id}
      workspaceId={workspace.id}
      memberId={workspace.memberId}
      team={team}
      locale={locale}
    />
  );
}
