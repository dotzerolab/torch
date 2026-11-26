// One column of the board: a header (name, count, a slot for an action) and its cards, which scroll on their own and are
// drawn only where they are in view.
import { useVirtualizer } from '@tanstack/react-virtual';
import { type ReactNode, useEffect, useRef } from 'react';
import { StateDot } from './icons.tsx';
import type { IssueRow, Section } from './model/engine.ts';

export const CARD_HEIGHT = 88;
const OVERSCAN = 4;

export function BoardColumn({
  section,
  title,
  color,
  action,
  initialRect,
  register,
  renderCard,
}: {
  section: Section;
  title: string;
  color?: string;
  action?: ReactNode;
  initialRect?: { width: number; height: number };
  /** Hands the scrolling element to the board, which scrolls a card into view before it focuses it. */
  register: (key: string, element: HTMLElement | null) => void;
  renderCard: (row: IssueRow) => ReactNode;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const { rows } = section;
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => CARD_HEIGHT,
    getItemKey: (index) => rows[index]?.id ?? index,
    overscan: OVERSCAN,
    initialRect,
  });
  useEffect(() => {
    register(section.key, scroller.current);
    return () => register(section.key, null);
  }, [register, section.key]);

  return (
    <section className="board-column" data-testid={`column-${section.key}`} aria-label={title}>
      <header className="board-column__header">
        {color ? <StateDot color={color} /> : null}
        <h2 className="board-column__title">
          {title}
          <span className="issue-section__count">{rows.length}</span>
        </h2>
        {action ? <span className="board-column__action">{action}</span> : null}
      </header>
      {/* biome-ignore lint/a11y/useSemanticElements: cards are absolutely positioned inside a virtual column */}
      <div
        ref={scroller}
        className="board-column__cards"
        role="list"
        aria-label={title}
        data-issue-count={rows.length}
      >
        <div className="issue-list__space" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((virtual) => {
            const row = rows[virtual.index];
            if (!row) return null;
            return (
              <div
                key={row.id}
                className="issue-list__slot"
                style={{ height: virtual.size, transform: `translateY(${virtual.start}px)` }}
              >
                {renderCard(row)}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
