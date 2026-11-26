// One list of issues with its toolbar: the filter, the display options, the count, and what to say when nothing shows.
// The rows and the reference data come from the screen (a team, My Issues); the view state is the address and the device.
import type { IssueUpdateInput } from '@torch/shared/mutations/issue';
import type { ViewDisplay } from '@torch/shared/views';
import { useMemo } from 'react';
import { Button } from '../design/components/Button.tsx';
import { useT } from '../design/locale.tsx';
import { DisplayMenu } from './DisplayMenu.tsx';
import type { TeamData } from './data.ts';
import { FilterBar } from './FilterBar.tsx';
import { IssueList } from './IssueList.tsx';
import { buildSections, type IssueRow } from './model/engine.ts';
import { SelectionProvider } from './SelectionContext.tsx';
import type { ViewState } from './useViewState.ts';

export function IssuesView({
  rows,
  data,
  meId,
  today,
  teamKey,
  teamName,
  names,
  view,
  groups,
  error,
  initialRect,
  revealId,
  onOpen,
  onRename,
  onUpdate,
}: {
  rows: IssueRow[];
  data: TeamData;
  meId: string;
  today: string;
  teamKey: string;
  /** Names the region for assistive technology. */
  teamName: string;
  /** Names of members and teams, to order and title the groups; members' names by default. */
  names?: ReadonlyMap<string, string>;
  view: ViewState;
  groups?: readonly ViewDisplay['group'][];
  error: string | null;
  initialRect?: { width: number; height: number };
  revealId?: string;
  onOpen: (row: IssueRow) => void;
  onRename: (row: IssueRow, title: string) => void;
  onUpdate: (row: IssueRow, patch: IssueUpdateInput) => void;
}) {
  const t = useT();
  const { filter, display } = view;
  const groupNames = useMemo(
    () => names ?? new Map([...data.membersById].map(([id, member]) => [id, member.name])),
    [names, data.membersById],
  );
  const sections = useMemo(
    () =>
      buildSections(rows, filter, display, {
        meId,
        today,
        states: data.statesById,
        names: groupNames,
      }),
    [rows, filter, display, meId, today, data.statesById, groupNames],
  );
  const shown = useMemo(
    () => sections.reduce((sum, section) => sum + section.rows.length, 0),
    [sections],
  );
  const total = useMemo(
    () => rows.filter((row) => display.showArchived || row.issue.archived_at === null).length,
    [rows, display.showArchived],
  );
  const filtering = Object.keys(filter).length > 0;

  return (
    <section className="issues" aria-label={teamName}>
      <div className="issues__toolbar">
        <FilterBar filter={filter} onChange={view.setFilter} data={data} meId={meId} />
        <DisplayMenu display={display} onChange={view.setDisplay} groups={groups} />
      </div>
      {filtering ? (
        <p className="issues__count" data-testid="issue-total">
          {t('issues.total', { shown: String(shown), total: String(total) })}
        </p>
      ) : null}
      {error && (
        <p className="issues__error" role="alert" data-testid="mutation-error">
          {error}
        </p>
      )}
      {shown === 0 ? (
        <div className="issues__note">
          {filtering ? (
            <>
              <p>{t('issues.noMatch')}</p>
              <Button size="sm" onClick={() => view.setFilter({})}>
                {t('filter.clear')}
              </Button>
            </>
          ) : (
            <p>{t('workspace.noIssues')}</p>
          )}
        </div>
      ) : (
        <SelectionProvider>
          <IssueList
            sections={sections}
            display={display}
            data={data}
            meId={meId}
            today={today}
            teamKey={teamKey}
            names={groupNames}
            initialRect={initialRect}
            revealId={revealId}
            onOpen={onOpen}
            onRename={onRename}
            onUpdate={onUpdate}
          />
        </SelectionProvider>
      )}
    </section>
  );
}
