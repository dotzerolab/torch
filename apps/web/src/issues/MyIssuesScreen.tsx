// My Issues: the issues the person holds or made, across every team they can see, in the same list and board as a team
// (`IssuesView`). One live shape feeds it; the states and labels of each team that has a row are read as snapshots.
// A click or Enter opens the issue's page: a preview beside the list would read one more team's issues, and a page may
// open only one live shape.
import type { IssueUpdateInput } from '@torch/shared/mutations/issue';
import { GROUPS } from '@torch/shared/views';
import { useCallback, useMemo, useState } from 'react';
import { useLocale, useT } from '../design/locale.tsx';
import { mutationErrorMessage } from '../errors.ts';
import { navigate, useLocation } from '../navigation.ts';
import type { SyncedTeam } from '../sync/collections.ts';
import { useShape } from '../sync/shapes.ts';
import { IssuesView } from './IssuesView.tsx';
import { localDay } from './model/day.ts';
import type { IssueRow } from './model/engine.ts';
import { MY_ISSUES_DISPLAY, MY_TABS, rowsOfTab, tabOf, withTab } from './model/my-issues.ts';
import { updateIssue } from './mutate.ts';
import { useMyIssues } from './useMyIssues.ts';
import { useViewState } from './useViewState.ts';

export function MyIssuesScreen({
  workspaceId,
  memberId,
  teams,
}: {
  workspaceId: string;
  memberId: string;
  teams: readonly SyncedTeam[];
}) {
  const t = useT();
  const locale = useLocale();
  const mine = useShape({ kind: 'myIssues', workspaceId });
  const { rows, data, names, ready } = useMyIssues(workspaceId, teams);
  const view = useViewState('my-issues', MY_ISSUES_DISPLAY);
  const { pathname, search } = useLocation();
  const tab = tabOf(search);
  const tabRows = useMemo(() => rowsOfTab(rows, tab, memberId), [rows, tab, memberId]);
  const today = useMemo(() => localDay(), []);
  const [error, setError] = useState<string | null>(null);

  const update = useCallback(
    (row: IssueRow, patch: IssueUpdateInput) => {
      setError(null);
      // The collection sends the PATCH for the team of the row; a refusal rolls the change back and lands here.
      updateIssue(mine, row.issue, patch).catch((failure: unknown) => {
        setError(mutationErrorMessage(locale, failure));
      });
    },
    [mine, locale],
  );
  const rename = useCallback((row: IssueRow, title: string) => update(row, { title }), [update]);
  // A queued issue has no number to open yet.
  const open = useCallback((row: IssueRow) => {
    if (row.identifier) navigate(`/issues/${row.identifier}`);
  }, []);
  const choose = (next: (typeof MY_TABS)[number]) => {
    if (next !== tab) navigate(`${pathname}${withTab(search, next)}`);
  };

  if (!ready || !data.statesReady) {
    return (
      <p className="issues__note" aria-busy="true">
        {t('workspace.loading')}
      </p>
    );
  }
  return (
    <div className="my-issues">
      <div className="my-issues__tabs" role="tablist" aria-label={t('myIssues.tabs')}>
        {MY_TABS.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={id === tab}
            className={id === tab ? 'my-issues__tab my-issues__tab--active' : 'my-issues__tab'}
            data-testid={`my-issues-tab-${id}`}
            onClick={() => choose(id)}
          >
            {t(`myIssues.tab.${id}`)}
          </button>
        ))}
      </div>
      <IssuesView
        rows={tabRows}
        data={data}
        meId={memberId}
        today={today}
        teamKey=""
        teamName={t('shell.myIssues')}
        names={names}
        groups={GROUPS}
        view={view}
        error={error}
        emptyText={t(`myIssues.empty.${tab}`)}
        onOpen={open}
        onRename={rename}
        onUpdate={update}
      />
    </div>
  );
}
