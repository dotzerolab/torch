// The panel of one issue, as a page or as a side preview: title, description, properties, follow, archive. It draws what
// it is given and says what the person did; `IssuePanel` knows where the data comes from and where the writes go.
import type { IssueUpdateInput } from '@torch/shared/mutations/issue';
import { Link2, MoreHorizontal, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Avatar } from '../design/components/Avatar.tsx';
import { Button } from '../design/components/Button.tsx';
import { IconButton } from '../design/components/IconButton.tsx';
import { Menu } from '../design/components/Menu.tsx';
import { Popover } from '../design/components/Popover.tsx';
import { Textarea } from '../design/components/Textarea.tsx';
import { useLocale, useT } from '../design/locale.tsx';
import { mutationErrorMessage } from '../errors.ts';
import { navigate } from '../navigation.ts';
import type { TeamData } from './data.ts';
import { PickerBody, shortDay } from './IssueRow.tsx';
import { PriorityIcon, StateDot } from './icons.tsx';
import type { IssueRow } from './model/engine.ts';
import type { PickerKind } from './useListKeys.ts';

const MAX_DESCRIPTION = 100_000;

export type IssuePanelViewProps = {
  row: IssueRow;
  data: TeamData;
  teamName: string;
  teamKey: string;
  meId: string;
  today: string;
  variant: 'peek' | 'page';
  /** Null while it is being read. */
  description: string | null;
  subscribed: boolean;
  error: string | null;
  onUpdate: (patch: IssueUpdateInput) => void;
  /** Rejects with the refusal; the panel keeps the text being edited. */
  onSaveDescription: (text: string) => Promise<void>;
  onToggleSubscribe: () => void;
  onSetArchived: (archived: boolean) => void;
  onCopy: (what: 'identifier' | 'link') => void;
  onClose: () => void;
};

const PROPERTIES: { kind: PickerKind; label: string }[] = [
  { kind: 'state', label: 'picker.state' },
  { kind: 'priority', label: 'picker.priority' },
  { kind: 'assignee', label: 'picker.assignee' },
  { kind: 'labels', label: 'picker.labels' },
  { kind: 'due', label: 'picker.dueDate' },
  { kind: 'estimate', label: 'picker.estimate' },
];

export function IssuePanelView({
  row,
  data,
  teamName,
  teamKey,
  meId,
  today,
  variant,
  description,
  subscribed,
  error,
  onUpdate,
  onSaveDescription,
  onToggleSubscribe,
  onSetArchived,
  onCopy,
  onClose,
}: IssuePanelViewProps) {
  const t = useT();
  const locale = useLocale();
  const { issue } = row;
  const archived = issue.archived_at !== null;
  // A queued issue has no number yet and the server does not know it: nothing can be changed until it answers.
  const readOnly = archived || row.pending;
  const identifier = row.identifier || `${teamKey}-…`;

  // ---- title ----
  const [title, setTitle] = useState(issue.title);
  const sent = useRef(issue.title);
  useEffect(() => {
    setTitle(issue.title);
    sent.current = issue.title;
  }, [issue.title]);
  const commitTitle = () => {
    const next = title.trim();
    if (!next) {
      setTitle(issue.title);
      return;
    }
    if (next === sent.current) return;
    sent.current = next;
    onUpdate({ title: next });
  };

  // ---- description ----
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [descriptionError, setDescriptionError] = useState<string | null>(null);
  const startEditing = () => {
    if (readOnly || description === null) return;
    setDraft(description);
    setDescriptionError(null);
    setEditing(true);
  };
  const save = () => {
    setSaving(true);
    setDescriptionError(null);
    onSaveDescription(draft).then(
      () => {
        setSaving(false);
        setEditing(false);
      },
      (failure: unknown) => {
        setSaving(false);
        setDescriptionError(mutationErrorMessage(locale, failure));
      },
    );
  };

  // ---- properties ----
  const [picker, setPicker] = useState<PickerKind | null>(null);
  const state = data.statesById.get(issue.state_id);
  const assignee = issue.assignee_id ? data.membersById.get(issue.assignee_id) : undefined;
  const labels = row.labelIds.flatMap((id) => {
    const label = data.labelsById.get(id);
    return label ? [label] : [];
  });
  const propertyValue = (kind: PickerKind) => {
    switch (kind) {
      case 'state':
        return (
          <>
            <StateDot color={state?.color ?? 'var(--fg-subtle)'} />
            {state?.name ?? ''}
          </>
        );
      case 'priority':
        return (
          <>
            <PriorityIcon priority={issue.priority} />
            {t(`issue.priority.${issue.priority}`)}
          </>
        );
      case 'assignee':
        return assignee ? (
          <>
            <Avatar name={assignee.name} size="sm" />
            {assignee.name}
          </>
        ) : (
          t('picker.assignee.none')
        );
      case 'labels':
        return labels.length > 0
          ? labels.map((label) => label.name).join(', ')
          : t('issue.noLabels');
      case 'due':
        return issue.due_date ? shortDay(locale, issue.due_date) : t('picker.date.clear');
      case 'estimate':
        return issue.estimate === null ? t('picker.estimate.none') : String(issue.estimate);
    }
  };

  return (
    <article className={`issue-panel issue-panel--${variant}`} aria-label={identifier}>
      <header className="issue-panel__header">
        {variant === 'page' ? (
          <nav className="issue-panel__crumbs" aria-label={teamName}>
            <a
              href={`/teams/${encodeURIComponent(teamKey)}`}
              onClick={(event) => {
                event.preventDefault();
                navigate(`/teams/${encodeURIComponent(teamKey)}`);
              }}
            >
              {teamName}
            </a>
            <span aria-hidden="true">/</span>
          </nav>
        ) : null}
        <span className="issue-row__id">{identifier}</span>
        <span className="issue-panel__spacer" />
        {variant === 'peek' && row.identifier ? (
          <a
            className="issue-panel__open"
            href={`/issues/${row.identifier}`}
            onClick={(event) => {
              event.preventDefault();
              navigate(`/issues/${row.identifier}`);
            }}
          >
            {t('issue.openPage')}
          </a>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          aria-pressed={subscribed}
          disabled={row.pending}
          onClick={onToggleSubscribe}
        >
          {subscribed ? t('issue.unsubscribe') : t('issue.subscribe')}
        </Button>
        <Menu
          align="end"
          trigger={
            <IconButton
              size="sm"
              label={t('issue.menu')}
              icon={<MoreHorizontal size={16} aria-hidden="true" />}
            />
          }
          items={[
            ...(row.pending
              ? []
              : [
                  {
                    id: 'archive',
                    label: archived ? t('issue.unarchive') : t('issue.archive'),
                    onSelect: () => onSetArchived(!archived),
                  },
                ]),
            {
              id: 'copy-identifier',
              label: t('issue.copyIdentifier'),
              disabled: !row.identifier,
              onSelect: () => onCopy('identifier'),
            },
            {
              id: 'copy-link',
              label: t('issue.copyLink'),
              icon: <Link2 size={14} aria-hidden="true" />,
              disabled: !row.identifier,
              onSelect: () => onCopy('link'),
            },
          ]}
        />
        {variant === 'peek' ? (
          <IconButton
            size="sm"
            label={t('issue.peek.close')}
            icon={<X size={16} aria-hidden="true" />}
            onClick={onClose}
          />
        ) : null}
      </header>

      {archived ? (
        <p className="issue-panel__banner" role="status">
          {t('issue.archivedBanner')}
          <Button size="sm" onClick={() => onSetArchived(false)}>
            {t('issue.unarchive')}
          </Button>
        </p>
      ) : null}
      {error ? (
        <p className="issues__error" role="alert" data-testid="panel-error">
          {error}
        </p>
      ) : null}

      <input
        className="issue-panel__title"
        aria-label={t('issue.titleLabel', { key: identifier })}
        value={title}
        maxLength={255}
        readOnly={readOnly}
        onChange={(event) => setTitle(event.target.value)}
        onBlur={commitTitle}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commitTitle();
          } else if (event.key === 'Escape') {
            event.stopPropagation();
            setTitle(issue.title);
          }
        }}
      />

      <fieldset className="issue-panel__properties">
        <legend>{t('issue.properties')}</legend>
        {PROPERTIES.map(({ kind, label }) => (
          <Popover
            key={kind}
            open={picker === kind}
            onOpenChange={(open) => setPicker(open ? kind : null)}
            label={t(label)}
            trigger={
              <button
                type="button"
                className="issue-panel__property"
                disabled={readOnly}
                aria-label={t(label)}
                data-kind={kind}
              >
                <span className="issue-panel__property-name">{t(label)}</span>
                <span className="issue-panel__property-value">{propertyValue(kind)}</span>
              </button>
            }
          >
            <PickerBody
              kind={kind}
              row={row}
              data={data}
              meId={meId}
              today={today}
              onUpdate={onUpdate}
              onClose={() => setPicker(null)}
            />
          </Popover>
        ))}
      </fieldset>

      <section className="issue-panel__description-block">
        {editing ? (
          <>
            <Textarea
              aria-label={t('issue.description')}
              value={draft}
              maxLength={MAX_DESCRIPTION}
              rows={8}
              autoFocus
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.stopPropagation();
                  setEditing(false);
                }
              }}
            />
            {descriptionError ? (
              <p className="issues__error" role="alert">
                {descriptionError}
              </p>
            ) : null}
            <div className="issue-panel__actions">
              <Button size="sm" variant="primary" loading={saving} onClick={save}>
                {t('issue.description.save')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                {t('issue.description.cancel')}
              </Button>
            </div>
          </>
        ) : description === null ? (
          <p className="issue-panel__description issue-panel__description--loading">…</p>
        ) : description === '' ? (
          readOnly ? null : (
            <button type="button" className="issue-panel__add" onClick={startEditing}>
              {t('issue.description.add')}
            </button>
          )
        ) : readOnly ? (
          <div
            className="issue-panel__description"
            data-testid="issue-description"
            style={{ whiteSpace: 'pre-wrap' }}
          >
            {description}
          </div>
        ) : (
          <button
            type="button"
            className="issue-panel__description"
            data-testid="issue-description"
            style={{ whiteSpace: 'pre-wrap' }}
            onClick={startEditing}
          >
            {description}
          </button>
        )}
      </section>
    </article>
  );
}
