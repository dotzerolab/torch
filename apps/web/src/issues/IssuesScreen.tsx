import type { Locale } from '@torch/shared/i18n';
import { t } from '@torch/shared/i18n';
import type { IssueUpdateInput } from '@torch/shared/mutations/issue';
import { DEFAULT_DISPLAY } from '@torch/shared/views';
import { useCallback, useMemo, useState } from 'react';
import { mutationErrorMessage } from '../errors.ts';
import { useLocation } from '../navigation.ts';
import { parseRoute } from '../routes.ts';
import { useShell } from '../shell/ShellContext.ts';
import type { SyncedTeam } from '../sync/collections.ts';
import { useShape } from '../sync/shapes.ts';
import { useIssueRows, useTeamData } from './data.ts';
import { IssueList } from './IssueList.tsx';
import { localDay } from './model/day.ts';
import { buildSections, type IssueRow } from './model/engine.ts';
import { updateIssue } from './mutate.ts';
import { SelectionProvider } from './SelectionContext.tsx';

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
  const display = DEFAULT_DISPLAY;

  const sections = useMemo(
    () => buildSections(rows, {}, display, { meId: memberId, today, states: data.statesById }),
    [rows, memberId, today, data.statesById],
  );

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
    <section className="issues" aria-label={team.name}>
      {error && (
        <p className="issues__error" role="alert" data-testid="mutation-error">
          {error}
        </p>
      )}
      {rows.length === 0 ? (
        <p className="issues__note">{t(locale, 'workspace.noIssues')}</p>
      ) : (
        <SelectionProvider>
          <IssueList
            sections={sections}
            display={display}
            data={data}
            meId={memberId}
            today={today}
            teamKey={team.key}
            onOpen={open}
            onRename={rename}
            onUpdate={update}
          />
        </SelectionProvider>
      )}
    </section>
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
