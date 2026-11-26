// One row of the list. Memoised: a change to one issue leaves every other row's props as they were, so only that row
// renders (10,000 rows would otherwise miss the 100 ms bar for a local update).
import * as RadixPopover from '@radix-ui/react-popover';
import type { IssueUpdateInput } from '@torch/shared/mutations/issue';
import type { PropertyId } from '@torch/shared/views';
import { type MouseEvent, memo, type ReactNode, useEffect, useRef, useState } from 'react';
import { Avatar } from '../design/components/Avatar.tsx';
import { useLocale, useT } from '../design/locale.tsx';
import type { TeamData } from './data.ts';
import { PriorityIcon, StateDot } from './icons.tsx';
import type { IssueRow as Row } from './model/engine.ts';
import { AssigneePicker } from './pickers/AssigneePicker.tsx';
import { DatePicker } from './pickers/DatePicker.tsx';
import { EstimatePicker } from './pickers/EstimatePicker.tsx';
import { LabelPicker, labelDiff } from './pickers/LabelPicker.tsx';
import { PriorityPicker } from './pickers/PriorityPicker.tsx';
import { StatePicker } from './pickers/StatePicker.tsx';
import type { PickerKind } from './useListKeys.ts';

/** How many label chips a row shows before "+n". */
const MAX_CHIPS = 2;

export type RowHandlers = {
  onClick: (row: Row, event: MouseEvent) => void;
  onFocus: (row: Row) => void;
  onStartRename: (row: Row) => void;
  onCommitRename: (row: Row, title: string) => void;
  onCancelRename: () => void;
  onPicker: (row: Row, kind: PickerKind | null) => void;
  onUpdate: (row: Row, patch: IssueUpdateInput) => void;
};

/** A day as "Dec 2": a date has no time zone, so it is read as UTC and shown as UTC. */
export function shortDay(locale: string, day: string): string {
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${day}T00:00:00Z`));
}

export function Cell({
  label,
  className,
  onPick,
  children,
}: {
  label: string;
  className: string;
  onPick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`issue-cell ${className}`}
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        onPick();
      }}
    >
      {children}
    </button>
  );
}

export function TitleCell({
  row,
  renaming,
  testKey,
  handlers,
}: {
  row: Row;
  renaming: boolean;
  testKey: string;
  handlers: RowHandlers;
}) {
  const t = useT();
  const [draft, setDraft] = useState(row.issue.title);
  const input = useRef<HTMLInputElement>(null);
  // Only when renaming starts: the draft must not jump while the person types and a remote edit arrives.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (!renaming) return;
    setDraft(row.issue.title);
    input.current?.focus();
    input.current?.select();
  }, [renaming]);

  if (!renaming) {
    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: double-click is the pointer way to F2, which is the key way
      <span
        className="issue-row__title"
        data-testid={`issue-title-${testKey}`}
        onDoubleClick={() => handlers.onStartRename(row)}
      >
        {row.issue.title}
      </span>
    );
  }
  return (
    <input
      ref={input}
      className="issue-row__title issue-row__title--editing"
      data-testid={`issue-title-input-${testKey}`}
      aria-label={t('issue.titleLabel', { key: row.identifier || row.issue.title })}
      maxLength={255}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onBlur={() => handlers.onCancelRename()}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          handlers.onCancelRename();
        } else if (event.key === 'Enter') {
          event.preventDefault();
          handlers.onCommitRename(row, draft);
        }
      }}
    />
  );
}

export function PickerBody({
  kind,
  row,
  data,
  meId,
  today,
  onUpdate,
  onClose,
}: {
  kind: PickerKind;
  row: Row;
  data: TeamData;
  meId: string;
  today: string;
  onUpdate: (patch: IssueUpdateInput) => void;
  onClose: () => void;
}) {
  const { issue } = row;
  switch (kind) {
    case 'state':
      return (
        <StatePicker
          states={data.states}
          value={issue.state_id}
          onChange={(stateId) => onUpdate({ stateId })}
          onClose={onClose}
        />
      );
    case 'priority':
      return (
        <PriorityPicker
          value={issue.priority}
          onChange={(priority) => onUpdate({ priority })}
          onClose={onClose}
        />
      );
    case 'assignee':
      return (
        <AssigneePicker
          members={[...data.membersById.values()]}
          meId={meId}
          value={issue.assignee_id}
          onChange={(assigneeId) => onUpdate({ assigneeId })}
          onClose={onClose}
        />
      );
    case 'labels':
      return (
        <LabelPicker
          labels={[...data.labelsById.values()]}
          value={row.labelIds}
          onChange={(next) => onUpdate(labelDiff(row.labelIds, next))}
          onClose={onClose}
        />
      );
    case 'due':
      return (
        <DatePicker
          value={issue.due_date}
          today={today}
          onChange={(dueDate) => onUpdate({ dueDate })}
          onClose={onClose}
        />
      );
    case 'estimate':
      return (
        <EstimatePicker
          value={issue.estimate}
          onChange={(estimate) => onUpdate({ estimate })}
          onClose={onClose}
        />
      );
  }
}

export const IssueRow = memo(function IssueRow({
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
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: the list container handles the keys of the focused row */}
        {/* biome-ignore lint/a11y/useSemanticElements: rows are absolutely positioned among section headers, which a list element cannot hold */}
        <div
          ref={(element) => setElement(row.id, element)}
          role="listitem"
          className="issue-row"
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
          {has('priority') ? (
            <Cell
              label={t('picker.priority')}
              className="issue-cell--priority"
              onPick={() => handlers.onPicker(row, 'priority')}
            >
              <PriorityIcon priority={issue.priority} />
            </Cell>
          ) : null}
          {has('identifier') ? (
            <span
              className="issue-row__id"
              title={row.pending && !row.identifier ? t('issues.pendingIdentifier') : undefined}
            >
              {identifier}
            </span>
          ) : null}
          {has('state') ? (
            <Cell
              label={state ? `${t('picker.state')}: ${state.name}` : t('picker.state')}
              className="issue-cell--state"
              onPick={() => handlers.onPicker(row, 'state')}
            >
              <StateDot color={state?.color ?? 'var(--fg-subtle)'} />
            </Cell>
          ) : null}
          <TitleCell row={row} renaming={renaming} testKey={testKey} handlers={handlers} />
          <span className="issue-row__meta">
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
            {has('estimate') ? (
              <Cell
                label={t('picker.estimate')}
                className="issue-cell--estimate"
                onPick={() => handlers.onPicker(row, 'estimate')}
              >
                {issue.estimate === null ? '' : issue.estimate}
              </Cell>
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
            {has('updated') ? (
              <span className="issue-row__updated" title={t('issues.row.updated')}>
                {shortDay(locale, issue.updated_at.slice(0, 10))}
              </span>
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
          </span>
        </div>
      </RadixPopover.Anchor>
      {picker ? (
        <RadixPopover.Portal>
          <RadixPopover.Content
            className="popover"
            align="start"
            sideOffset={4}
            onCloseAutoFocus={(event) => {
              // The row keeps the focus it had, so the keys carry on from it.
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
