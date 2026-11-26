// One list of issues with its toolbar: the filter, the display options, the count, and what to say when nothing shows.
// The rows and the reference data come from the screen (a team, My Issues); the view state is the address and the device.
import type { IssueUpdateInput } from '@torch/shared/mutations/issue';
import { GROUPS, type ViewDisplay } from '@torch/shared/views';
import { type ReactNode, useEffect, useMemo, useRef } from 'react';
import { Button } from '../design/components/Button.tsx';
import { useT } from '../design/locale.tsx';
import { DisplayMenu } from './DisplayMenu.tsx';
import type { TeamData } from './data.ts';
import { FilterBar } from './FilterBar.tsx';
import { IssueBoard } from './IssueBoard.tsx';
import { IssueList } from './IssueList.tsx';
import { buildSections, type IssueRow } from './model/engine.ts';
import { SelectionProvider } from './SelectionContext.tsx';
import type { ViewState } from './useViewState.ts';

/** A board has a column per state, assignee or priority; any other grouping of the list shows as columns by state. */
const BOARD_GROUPS = ['state', 'assignee', 'priority'] as const;
const onBoard = (group: ViewDisplay['group']) =>
  (BOARD_GROUPS as readonly string[]).includes(group);

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
  aside,
  peekOpen,
  onOpen,
  onPeek,
  onClosePeek,
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
  /** A side panel drawn beside the list (the issue preview). */
  aside?: ReactNode;
  peekOpen?: boolean;
  onOpen: (row: IssueRow) => void;
  onPeek?: (row: IssueRow) => void;
  onClosePeek?: () => void;
  onRename: (row: IssueRow, title: string) => void;
  onUpdate: (row: IssueRow, patch: IssueUpdateInput) => void;
}) {
  const t = useT();
  const { filter, display: chosen } = view;
  const board = chosen.layout === 'board';
  const display = useMemo<ViewDisplay>(
    () => (board && !onBoard(chosen.group) ? { ...chosen, group: 'state' } : chosen),
    [board, chosen],
  );
  const menuGroups = useMemo(
    () => (board ? (groups ?? GROUPS).filter(onBoard) : groups),
    [board, groups],
  );
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

  // The list and the board each keep where they were scrolled while the other is shown.
  const host = useRef<HTMLDivElement>(null);
  const scrolled = useRef<Record<string, { top: number; left: number }>>({});
  const layout = display.layout;
  const empty = shown === 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `empty` re-attaches when the scrolling element appears
  useEffect(() => {
    const element = host.current?.querySelector<HTMLElement>(
      layout === 'board' ? '.board' : '.issue-list',
    );
    if (!element) return;
    const saved = scrolled.current[layout];
    if (saved) {
      element.scrollTop = saved.top;
      element.scrollLeft = saved.left;
    }
    const remember = () => {
      scrolled.current[layout] = { top: element.scrollTop, left: element.scrollLeft };
    };
    element.addEventListener('scroll', remember, { passive: true });
    return () => element.removeEventListener('scroll', remember);
  }, [layout, empty]);

  return (
    <section className="issues" aria-label={teamName}>
      <div className="issues__toolbar">
        <FilterBar filter={filter} onChange={view.setFilter} data={data} meId={meId} />
        <DisplayMenu display={chosen} onChange={view.setDisplay} groups={menuGroups} />
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
      <div className="issues__stage">
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
          <div ref={host} className="issues__body">
            <SelectionProvider>
              {board ? (
                <IssueBoard
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
                  onPeek={onPeek}
                  peekOpen={peekOpen}
                  onClosePeek={onClosePeek}
                  onRename={onRename}
                  onUpdate={onUpdate}
                />
              ) : (
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
                  onPeek={onPeek}
                  peekOpen={peekOpen}
                  onClosePeek={onClosePeek}
                  onRename={onRename}
                  onUpdate={onUpdate}
                />
              )}
            </SelectionProvider>
          </div>
        )}
        {aside}
      </div>
    </section>
  );
}
