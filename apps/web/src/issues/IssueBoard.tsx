// The board: one column per group (state, assignee or priority), cards that scroll inside their column, and the same
// selection and keys as the list, with the arrows also crossing columns. The columns are the sections the view engine
// built, so a filter and an order mean the same thing here as in the list.
import type { IssueUpdateInput } from '@torch/shared/mutations/issue';
import type { ViewDisplay } from '@torch/shared/views';
import {
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useT } from '../design/locale.tsx';
import { BoardColumn, CARD_HEIGHT } from './BoardColumn.tsx';
import type { TeamData } from './data.ts';
import { IssueCard } from './IssueCard.tsx';
import type { RowHandlers } from './IssueRow.tsx';
import type { IssueRow as Row, Section } from './model/engine.ts';
import { useSelection } from './SelectionContext.tsx';
import { sectionTitle } from './sections.ts';
import { type PickerKind, useListKeys } from './useListKeys.ts';

export function IssueBoard({
  sections,
  display,
  data,
  meId,
  today,
  teamKey,
  names,
  initialRect,
  revealId,
  renderHeaderAction,
  onOpen,
  onPeek,
  peekOpen,
  onClosePeek,
  onRename,
  onUpdate,
}: {
  sections: Section[];
  display: ViewDisplay;
  data: TeamData;
  meId: string;
  today: string;
  teamKey: string;
  names?: ReadonlyMap<string, string>;
  initialRect?: { width: number; height: number };
  revealId?: string;
  /** The "+" of a column (creating an issue in it) arrives with the create flow. */
  renderHeaderAction?: (section: Section) => ReactNode;
  onOpen: (row: Row) => void;
  /** A click or Space previews the issue; without it a click opens it. */
  onPeek?: (row: Row) => void;
  /** The preview is open: Escape closes it before it clears the selection. */
  peekOpen?: boolean;
  onClosePeek?: () => void;
  onRename: (row: Row, title: string) => void;
  onUpdate: (row: Row, patch: IssueUpdateInput) => void;
}) {
  const t = useT();
  const selection = useSelection();
  const rows = useMemo(() => sections.flatMap((section) => section.rows), [sections]);
  const rowIds = useMemo(() => rows.map((row) => row.id), [rows]);
  const where = useMemo(() => {
    const map = new Map<string, { column: number; index: number }>();
    sections.forEach((section, column) => {
      section.rows.forEach((row, index) => {
        map.set(row.id, { column, index });
      });
    });
    return map;
  }, [sections]);

  const [activeId, setActiveId] = useState<string | null>(null);
  const current = (activeId && where.has(activeId) ? activeId : rowIds[0]) ?? null;
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [picker, setPicker] = useState<{ id: string; kind: PickerKind } | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const elements = useRef(new Map<string, HTMLElement>());
  const scrollers = useRef(new Map<string, HTMLElement>());
  const focusWanted = useRef<string | null>(null);

  const setElement = useCallback((id: string, element: HTMLElement | null) => {
    if (element) elements.current.set(id, element);
    else elements.current.delete(id);
  }, []);
  const register = useCallback((key: string, element: HTMLElement | null) => {
    if (element) scrollers.current.set(key, element);
    else scrollers.current.delete(key);
  }, []);

  /** Makes a card the current one, scrolls its column to it and focuses it once it is in the page. */
  const goTo = useCallback(
    (id: string) => {
      setActiveId(id);
      focusWanted.current = id;
      const at = where.get(id);
      const section = at ? sections[at.column] : undefined;
      const element = section ? scrollers.current.get(section.key) : undefined;
      if (!at || !element) return;
      const top = at.index * CARD_HEIGHT;
      const bottom = top + CARD_HEIGHT;
      const view = element.scrollTop;
      const height = element.clientHeight;
      const next = top < view ? top : bottom > view + height ? bottom - height : null;
      if (next !== null) {
        if (element.scrollTo) element.scrollTo({ top: next });
        else element.scrollTop = next;
      }
    },
    [where, sections],
  );

  // No dependency list on purpose: a card that was just scrolled into the page is focused on the render that draws it.
  useLayoutEffect(() => {
    const wanted = focusWanted.current;
    if (!wanted) return;
    const element = elements.current.get(wanted);
    if (!element) return;
    focusWanted.current = null;
    // Not `preventScroll`: the browser also brings the column into view sideways.
    element.focus();
  });

  const lastReveal = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (revealId && revealId !== lastReveal.current && where.has(revealId)) {
      lastReveal.current = revealId;
      goTo(revealId);
    }
  }, [revealId, where, goTo]);

  const rowFor = (id: string | null) => rows.find((row) => row.id === id);
  const currentRow = rowFor(current);
  const announce = useCallback(
    (row: Row) =>
      setAnnouncement(t('issues.announce', { identifier: row.identifier, title: row.issue.title })),
    [t],
  );
  const land = (row: Row | undefined) => {
    if (!row) return;
    goTo(row.id);
    announce(row);
  };
  /** Up and down: the neighbour in the same column (the first move lands on the first card). */
  const moveBy = (step: number) => {
    if (rows.length === 0) return;
    const at = activeId ? where.get(activeId) : undefined;
    if (!at) return land(rows[0]);
    const column = sections[at.column];
    land(column?.rows[Math.max(0, Math.min((column?.rows.length ?? 1) - 1, at.index + step))]);
  };
  /** Left and right: the next column that has cards, at the same height or its last card. */
  const moveAcross = (step: number) => {
    const at = activeId ? where.get(activeId) : undefined;
    if (!at) return land(rows[0]);
    for (let column = at.column + step; column >= 0 && column < sections.length; column += step) {
      const target = sections[column]?.rows;
      if (target && target.length > 0) {
        return land(target[Math.min(at.index, target.length - 1)]);
      }
    }
  };

  const handlers = useMemo<RowHandlers>(
    () => ({
      onClick: (row, event: MouseEvent) => {
        if (event.shiftKey) selection.range(row.id, rowIds);
        else if (event.metaKey || event.ctrlKey) selection.toggle(row.id);
        else {
          selection.only(row.id);
          (onPeek ?? onOpen)(row);
        }
        setActiveId(row.id);
      },
      onFocus: (row) => setActiveId(row.id),
      onStartRename: (row) => setRenamingId(row.id),
      onCommitRename: (row, title) => {
        setRenamingId(null);
        const next = title.trim();
        if (next && next !== row.issue.title) onRename(row, next);
        focusWanted.current = row.id;
      },
      onCancelRename: () => setRenamingId(null),
      onPicker: (row, kind) => {
        setPicker(kind ? { id: row.id, kind } : null);
        if (kind) setActiveId(row.id);
      },
      onUpdate,
    }),
    [selection, rowIds, onOpen, onPeek, onRename, onUpdate],
  );

  const host = useRef<HTMLDivElement>(null);
  const keysFree = picker === null && renamingId === null;
  const inBoard = () => {
    const focused = document.activeElement;
    return !focused || focused === document.body || host.current?.contains(focused) === true;
  };
  useListKeys(
    {
      next: () => moveBy(1),
      prev: () => moveBy(-1),
      select: () => currentRow && selection.toggle(currentRow.id),
      peek: () => currentRow && onPeek?.(currentRow),
      clear: () => {
        if (peekOpen) {
          onClosePeek?.();
          return;
        }
        if (inBoard() && selection.ids.size > 0) selection.clear();
      },
      rename: () => currentRow && setRenamingId(currentRow.id),
      picker: (kind) => currentRow && setPicker({ id: currentRow.id, kind }),
    },
    keysFree,
  );

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (renamingId !== null || picker !== null) return;
    const onCard = (event.target as HTMLElement).dataset.issueId !== undefined;
    if (!onCard) return;
    if (event.key === 'Enter' && currentRow) {
      event.preventDefault();
      onOpen(currentRow);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveBy(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveBy(-1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      moveAcross(1);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      moveAcross(-1);
    }
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: a row of scrolling columns; a fieldset would add a border and a legend
    <div
      ref={host}
      className="board"
      role="group"
      data-issue-count={rows.length}
      aria-label={t('issues.board.label')}
      onKeyDown={onKeyDown}
    >
      {sections.map((section) => {
        const title = sectionTitle(section, data, names, t);
        return (
          <BoardColumn
            key={section.key}
            section={section}
            title={title.text}
            color={title.color}
            action={renderHeaderAction?.(section)}
            initialRect={initialRect}
            register={register}
            renderCard={(row) => (
              <IssueCard
                row={row}
                data={data}
                properties={display.properties}
                teamKey={teamKey}
                meId={meId}
                today={today}
                selected={selection.ids.has(row.id)}
                active={row.id === current}
                renaming={renamingId === row.id}
                picker={picker?.id === row.id ? picker.kind : null}
                handlers={handlers}
                setElement={setElement}
              />
            )}
          />
        );
      })}
      <div className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </div>
    </div>
  );
}
