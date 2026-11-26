// The list view: sections of issue rows, windowed (only what is on screen is in the page, so 10,000 issues cost what 50
// do), with roving focus, selection, inline rename and the property pickers on the keyboard.
import { useVirtualizer } from '@tanstack/react-virtual';
import type { IssueUpdateInput } from '@torch/shared/mutations/issue';
import type { ViewDisplay } from '@torch/shared/views';
import {
  type MouseEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useT } from '../design/locale.tsx';
import type { TeamData } from './data.ts';
import { IssueRow, type RowHandlers } from './IssueRow.tsx';
import { StateDot } from './icons.tsx';
import type { IssueRow as Row, Section } from './model/engine.ts';
import { useSelection } from './SelectionContext.tsx';
import { sectionTitle } from './sections.ts';
import { type PickerKind, useListKeys } from './useListKeys.ts';

const ROW_HEIGHT = 36;
const SECTION_HEIGHT = 32;
const OVERSCAN = 8;

type Item =
  | { kind: 'section'; key: string; section: Section }
  | { kind: 'row'; key: string; row: Row };

export function IssueList({
  sections,
  display,
  data,
  meId,
  today,
  teamKey,
  names,
  initialRect,
  revealId,
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
  /** Names of teams, for the groups of a list that spans teams. */
  names?: ReadonlyMap<string, string>;
  /** The size the list is assumed to have before it is measured (tests, server render). */
  initialRect?: { width: number; height: number };
  /** Scrolls to this issue and focuses it whenever the id changes. */
  revealId?: string;
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
  const scroller = useRef<HTMLDivElement>(null);

  const items = useMemo<Item[]>(() => {
    const list: Item[] = [];
    for (const section of sections) {
      if (section.group !== 'none') list.push({ kind: 'section', key: section.key, section });
      for (const row of section.rows) list.push({ kind: 'row', key: row.id, row });
    }
    return list;
  }, [sections]);
  const rows = useMemo(
    () => items.flatMap((item) => (item.kind === 'row' ? [item.row] : [])),
    [items],
  );
  const rowIds = useMemo(() => rows.map((row) => row.id), [rows]);
  const indexOfId = useMemo(() => new Map(items.map((item, index) => [item.key, index])), [items]);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scroller.current,
    estimateSize: (index) => (items[index]?.kind === 'section' ? SECTION_HEIGHT : ROW_HEIGHT),
    getItemKey: (index) => items[index]?.key ?? index,
    overscan: OVERSCAN,
    initialRect,
  });

  // Which row the keys act on and the tab stop sits on (roving focus).
  const [activeId, setActiveId] = useState<string | null>(null);
  const current = (activeId && rowIds.includes(activeId) ? activeId : rowIds[0]) ?? null;
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [picker, setPicker] = useState<{ id: string; kind: PickerKind } | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const elements = useRef(new Map<string, HTMLElement>());
  const focusWanted = useRef<string | null>(null);

  const setElement = useCallback((id: string, element: HTMLElement | null) => {
    if (element) elements.current.set(id, element);
    else elements.current.delete(id);
  }, []);

  /** Makes a row the current one, scrolls to it and focuses it once it is in the page. */
  const goTo = useCallback(
    (id: string) => {
      setActiveId(id);
      focusWanted.current = id;
      const index = indexOfId.get(id);
      const element = scroller.current;
      if (index === undefined || !element) return;
      // Rows have fixed heights, so where one sits is a sum; the list scrolls only as far as it takes to show the row.
      let top = 0;
      for (let at = 0; at < index; at += 1) {
        top += items[at]?.kind === 'section' ? SECTION_HEIGHT : ROW_HEIGHT;
      }
      const bottom = top + ROW_HEIGHT;
      const view = element.scrollTop;
      const height = element.clientHeight;
      const next = top < view ? top : bottom > view + height ? bottom - height : null;
      // Written to the element itself: the browser tells the virtualizer through the scroll event it fires.
      if (next !== null) {
        if (element.scrollTo) element.scrollTo({ top: next });
        else element.scrollTop = next;
      }
    },
    [indexOfId, items],
  );

  // No dependency list on purpose: a row that was just scrolled into the page is focused on the render that draws it.
  useLayoutEffect(() => {
    const wanted = focusWanted.current;
    if (!wanted) return;
    const element = elements.current.get(wanted);
    if (!element) return;
    focusWanted.current = null;
    element.focus({ preventScroll: true });
  });

  const lastReveal = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (revealId && revealId !== lastReveal.current && indexOfId.has(revealId)) {
      lastReveal.current = revealId;
      goTo(revealId);
    }
  }, [revealId, indexOfId, goTo]);

  const rowFor = (id: string | null) => rows.find((row) => row.id === id);
  const currentRow = rowFor(current);

  const announce = useCallback(
    (row: Row) =>
      setAnnouncement(t('issues.announce', { identifier: row.identifier, title: row.issue.title })),
    [t],
  );
  const moveBy = (step: number) => {
    if (rows.length === 0) return;
    // The first move lands on the first row; a row the filter removed lets the move start from the top.
    const at = activeId && rowIds.includes(activeId) ? rowIds.indexOf(activeId) + step : 0;
    const row = rows[Math.max(0, Math.min(rows.length - 1, at))];
    if (row) {
      goTo(row.id);
      announce(row);
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

  // The keys belong to the list only while no picker or rename has the keyboard.
  const keysFree = picker === null && renamingId === null;
  const inList = () => {
    const focused = document.activeElement;
    return !focused || focused === document.body || scroller.current?.contains(focused) === true;
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
        if (inList() && selection.ids.size > 0) selection.clear();
      },
      rename: () => currentRow && setRenamingId(currentRow.id),
      picker: (kind) => currentRow && setPicker({ id: currentRow.id, kind }),
    },
    keysFree,
  );

  const onListKeyDown = (event: React.KeyboardEvent) => {
    // Arrow keys and Enter work with a row focused; the letters are shortcuts (`useListKeys`).
    if (renamingId !== null || picker !== null) return;
    const onRow = (event.target as HTMLElement).dataset.issueId !== undefined;
    if (event.key === 'Enter' && onRow && currentRow) {
      event.preventDefault();
      onOpen(currentRow);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveBy(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveBy(-1);
    }
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: rows are absolutely positioned among section headers, which a list element cannot hold
    <div
      ref={scroller}
      className="issue-list"
      role="list"
      aria-label={t('issues.list.label')}
      data-issue-count={rows.length}
      onKeyDown={onListKeyDown}
    >
      <div className="issue-list__space" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((virtual) => {
          const item = items[virtual.index];
          if (!item) return null;
          const style = { height: virtual.size, transform: `translateY(${virtual.start}px)` };
          if (item.kind === 'section') {
            const { section } = item;
            const ids = section.rows.map((row) => row.id);
            const selectedCount = ids.filter((id) => selection.ids.has(id)).length;
            const title = sectionTitle(section, data, names, t);
            return (
              <div
                key={item.key}
                className="issue-section"
                role="presentation"
                data-testid={`section-${section.key}`}
                style={style}
              >
                <input
                  type="checkbox"
                  className="issue-section__check"
                  aria-label={t('issues.section.select', { name: title.text })}
                  checked={ids.length > 0 && selectedCount === ids.length}
                  ref={(box) => {
                    if (box) box.indeterminate = selectedCount > 0 && selectedCount < ids.length;
                  }}
                  onChange={(event) => selection.setMany(ids, event.target.checked)}
                />
                {title.color ? <StateDot color={title.color} /> : null}
                <h2 className="issue-section__title">
                  {title.text}
                  <span className="issue-section__count">{ids.length}</span>
                </h2>
              </div>
            );
          }
          const { row } = item;
          return (
            <div key={item.key} className="issue-list__slot" style={style}>
              <IssueRow
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
            </div>
          );
        })}
      </div>
      <div className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </div>
    </div>
  );
}
