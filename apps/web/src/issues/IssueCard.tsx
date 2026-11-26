// One card of the board. Memoised like a row: a change to one issue renders that card only.
import * as RadixPopover from '@radix-ui/react-popover';
import type { PropertyId } from '@torch/shared/views';
import { memo } from 'react';
import { Avatar } from '../design/components/Avatar.tsx';
import { useLocale, useT } from '../design/locale.tsx';
import type { TeamData } from './data.ts';
import { Cell, PickerBody, type RowHandlers, shortDay, TitleCell } from './IssueRow.tsx';
import { PriorityIcon, StateDot } from './icons.tsx';
import type { IssueRow as Row } from './model/engine.ts';
import type { PickerKind } from './useListKeys.ts';

/** How many label chips a card shows before "+n". */
const MAX_CHIPS = 2;

export const IssueCard = memo(function IssueCard({
  row,
  data,
  properties,
  teamKey,
  meId,
  today,
  selected,
  active,
  renaming,
  picker,
  handlers,
  setElement,
}: {
  row: Row;
  data: TeamData;
  properties: readonly PropertyId[];
  teamKey: string;
  meId: string;
  today: string;
  selected: boolean;
  active: boolean;
  renaming: boolean;
  picker: PickerKind | null;
  handlers: RowHandlers;
  setElement: (id: string, element: HTMLElement | null) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const { issue } = row;
  const has = (id: PropertyId) => properties.includes(id);
  const testKey = String(issue.number > 0 ? issue.number : issue.id);
  const state = data.statesById.get(issue.state_id);
  const assignee = issue.assignee_id ? data.membersById.get(issue.assignee_id) : undefined;
  const chips = row.labelIds.flatMap((id) => {
    const label = data.labelsById.get(id);
    return label ? [label] : [];
  });
  const overdue =
    issue.due_date !== null &&
    issue.due_date < today &&
    state?.type !== 'completed' &&
    state?.type !== 'canceled';
  const identifier = row.identifier || (row.pending ? `${teamKey}-…` : '');
  const close = () => handlers.onPicker(row, null);

  return (
    <RadixPopover.Root open={picker !== null} onOpenChange={(open) => !open && close()}>
      <RadixPopover.Anchor asChild>
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: the board handles the keys of the focused card */}
        {/* biome-ignore lint/a11y/useSemanticElements: cards are absolutely positioned inside a virtual column */}
        <div
          ref={(element) => setElement(row.id, element)}
          role="listitem"
          className="issue-card"
          data-testid={`issue-${testKey}`}
          data-issue-id={row.id}
          data-pending={row.pending ? 'true' : undefined}
          data-selected={selected ? 'true' : undefined}
          data-active={active ? 'true' : undefined}
          aria-current={active ? 'true' : undefined}
          tabIndex={active ? 0 : -1}
          onFocus={() => handlers.onFocus(row)}
          onClick={(event) => handlers.onClick(row, event)}
        >
          <div className="issue-card__top">
            {has('identifier') ? (
              <span
                className="issue-row__id"
                title={row.pending && !row.identifier ? t('issues.pendingIdentifier') : undefined}
              >
                {identifier}
              </span>
            ) : null}
            {has('priority') ? (
              <Cell
                label={t('picker.priority')}
                className="issue-cell--priority"
                onPick={() => handlers.onPicker(row, 'priority')}
              >
                <PriorityIcon priority={issue.priority} />
              </Cell>
            ) : null}
          </div>
          <TitleCell row={row} renaming={renaming} testKey={testKey} handlers={handlers} />
          <div className="issue-card__meta">
            {has('labels') ? (
              <button
                type="button"
                className="issue-cell issue-cell--labels"
                aria-label={t('picker.labels')}
                onClick={(event) => {
                  event.stopPropagation();
                  handlers.onPicker(row, 'labels');
                }}
              >
                {chips.slice(0, MAX_CHIPS).map((label) => (
                  <span key={label.id} className="label-chip">
                    <StateDot color={label.color} />
                    {label.name}
                  </span>
                ))}
                {chips.length > MAX_CHIPS ? (
                  <span className="label-chip label-chip--more">
                    {t('issues.labels.more', { count: String(chips.length - MAX_CHIPS) })}
                  </span>
                ) : null}
              </button>
            ) : null}
            {has('due') ? (
              <Cell
                label={t('issues.row.dueDate')}
                className={overdue ? 'issue-cell--due issue-cell--overdue' : 'issue-cell--due'}
                onPick={() => handlers.onPicker(row, 'due')}
              >
                {issue.due_date ? shortDay(locale, issue.due_date) : ''}
              </Cell>
            ) : null}
            {has('assignee') ? (
              <Cell
                label={t('picker.assignee')}
                className="issue-cell--assignee"
                onPick={() => handlers.onPicker(row, 'assignee')}
              >
                {assignee ? (
                  <Avatar name={assignee.name} size="sm" />
                ) : (
                  <span className="issue-cell__none" />
                )}
              </Cell>
            ) : null}
          </div>
        </div>
      </RadixPopover.Anchor>
      {picker ? (
        <RadixPopover.Portal>
          <RadixPopover.Content
            className="popover"
            align="start"
            sideOffset={4}
            onCloseAutoFocus={(event) => {
              // The card keeps the focus it had, so the keys carry on from it.
              event.preventDefault();
              (
                document.querySelector(`[data-issue-id="${row.id}"]`) as HTMLElement | null
              )?.focus();
            }}
          >
            <PickerBody
              kind={picker}
              row={row}
              data={data}
              meId={meId}
              today={today}
              onUpdate={(patch) => handlers.onUpdate(row, patch)}
              onClose={close}
            />
          </RadixPopover.Content>
        </RadixPopover.Portal>
      ) : null}
    </RadixPopover.Root>
  );
});
