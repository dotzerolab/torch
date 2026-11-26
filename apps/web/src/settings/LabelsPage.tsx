import { labelCreateInput, labelUpdateInput } from '@torch/shared/mutations/workflow';
import { Plus } from 'lucide-react';
import { type FormEvent, useId, useState } from 'react';
import type { SessionWorkspace } from '../auth/useSession.ts';
import { Badge } from '../design/components/Badge.tsx';
import { Button } from '../design/components/Button.tsx';
import { Dialog } from '../design/components/Dialog.tsx';
import { EmptyState } from '../design/components/EmptyState.tsx';
import { Input } from '../design/components/Input.tsx';
import { Select } from '../design/components/Select.tsx';
import { useToast } from '../design/components/Toast.tsx';
import { useLocale, useT } from '../design/locale.tsx';
import { adminFailureMessage } from '../errors.ts';
import { useTeams } from '../shell/useTeams.ts';
import type { SyncedLabel } from '../sync/collections.ts';
import { canEditLabels, canSeeLabelSettings } from './access.ts';
import { adminApi } from './admin-api.ts';
import { labelRow, labelTree } from './labels-model.ts';
import { NoAccess } from './NoAccess.tsx';
import { type SettingsRows, useTeamLabelRows, useWorkspaceLabelRows } from './useSettingsRows.ts';

const DEFAULT_COLOR = '#94a3b8';
const NO_GROUP = 'none';

type Editing = { kind: 'label' | 'group'; label?: SyncedLabel };

/** Name, color and (for a label, not a group) the group it sits in: the one form of "new" and "edit". */
function LabelDialog({
  editing,
  groups,
  onSubmit,
  onClose,
}: {
  editing: Editing;
  groups: SyncedLabel[];
  onSubmit: (input: { name: string; color: string; parentId: string | null }) => Promise<void>;
  onClose: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const ids = useId();
  const isGroup = editing.kind === 'group';
  const [name, setName] = useState(editing.label?.name ?? '');
  const [color, setColor] = useState(editing.label?.color ?? DEFAULT_COLOR);
  const [parent, setParent] = useState(editing.label?.parent_id ?? NO_GROUP);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError(null);
    const parentId = isGroup || parent === NO_GROUP ? null : parent;
    const parsed = editing.label
      ? labelUpdateInput.safeParse({ name, color })
      : labelCreateInput.safeParse({ name, color });
    if (!parsed.success) {
      setError(t('settings.labels.invalid'));
      return;
    }
    setBusy(true);
    try {
      await onSubmit({ name: name.trim(), color, parentId });
    } catch (failure) {
      setError(adminFailureMessage(locale, failure));
      setBusy(false);
    }
  }

  const title = editing.label
    ? t(isGroup ? 'settings.labels.editGroupTitle' : 'settings.labels.editTitle')
    : t(isGroup ? 'settings.labels.newGroupTitle' : 'settings.labels.newTitle');
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={title}
    >
      <form className="form" onSubmit={submit} noValidate data-testid="label-form">
        <div className="form__row">
          <label className="form__label" htmlFor={`${ids}-name`}>
            {t('settings.labels.name')}
          </label>
          <Input
            id={`${ids}-name`}
            value={name}
            maxLength={80}
            autoComplete="off"
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="form__row">
          <label className="form__label" htmlFor={`${ids}-color`}>
            {t('settings.labels.color')}
          </label>
          <input
            id={`${ids}-color`}
            type="color"
            className="color-input"
            value={color}
            onChange={(event) => setColor(event.target.value)}
          />
        </div>
        {isGroup || groups.length === 0 ? null : (
          <div className="form__row">
            <span className="form__label">{t('settings.labels.group')}</span>
            <Select
              value={parent}
              onValueChange={setParent}
              label={t('settings.labels.group')}
              options={[
                { value: NO_GROUP, label: t('settings.labels.noGroup') },
                ...groups.map((group) => ({ value: group.id, label: group.name })),
              ]}
            />
          </div>
        )}
        {error ? (
          <p className="form__error" role="alert" data-testid="label-error">
            {error}
          </p>
        ) : null}
        <div className="form__actions">
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" variant="primary" loading={busy} data-testid="label-submit">
            {editing.label ? t('common.save') : t('settings.labels.create')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function LabelLine({
  label,
  canEdit,
  onEdit,
  onArchive,
}: {
  label: SyncedLabel;
  canEdit: boolean;
  onEdit: () => void;
  onArchive: () => void;
}) {
  const t = useT();
  return (
    <li className="team-list__row" data-testid={`label-row-${label.name}`}>
      <span className="swatch" style={{ background: label.color }} aria-hidden="true" />
      <span className="team-list__name">{label.name}</span>
      {label.is_group ? <Badge>{t('settings.labels.groupBadge')}</Badge> : null}
      {canEdit ? (
        <span className="team-list__actions">
          <Button
            size="sm"
            aria-label={t('settings.labels.editFor', { name: label.name })}
            onClick={onEdit}
          >
            {t('settings.labels.edit')}
          </Button>
          <Button
            size="sm"
            aria-label={t('settings.labels.archiveFor', { name: label.name })}
            onClick={onArchive}
          >
            {t('settings.labels.archive')}
          </Button>
        </span>
      ) : null}
    </li>
  );
}

/** The labels of one scope, from `source`; `teamId` null is the workspace's own labels. */
function LabelScope({
  workspaceId,
  teamId,
  canEdit,
  source,
}: {
  workspaceId: string;
  teamId: string | null;
  canEdit: boolean;
  source: SettingsRows<SyncedLabel>;
}) {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const { rows, ready, remember, refresh } = source;
  const tree = labelTree(rows);
  const [editing, setEditing] = useState<Editing | null>(null);

  const written = (dto: Parameters<typeof labelRow>[0]) => {
    remember(labelRow(dto, workspaceId));
    refresh();
  };

  async function archive(label: SyncedLabel) {
    try {
      const { label: dto } = await adminApi.archiveLabel(workspaceId, label.id);
      written(dto);
      toast.show({ message: t('settings.labels.archived', { name: label.name }) });
    } catch (failure) {
      toast.show({ message: adminFailureMessage(locale, failure), tone: 'error' });
    }
  }

  const empty = tree.groups.length === 0 && tree.loose.length === 0;
  return (
    <>
      {canEdit ? (
        <div className="settings-page__head">
          <span />
          <span className="team-list__actions">
            <Button onClick={() => setEditing({ kind: 'group' })} data-testid="label-group-open">
              {t('settings.labels.newGroup')}
            </Button>
            <Button
              variant="primary"
              onClick={() => setEditing({ kind: 'label' })}
              data-testid="label-add-open"
            >
              <Plus size={14} aria-hidden="true" />
              {t('settings.labels.new')}
            </Button>
          </span>
        </div>
      ) : (
        <p className="form__hint">{t('settings.labels.readOnly')}</p>
      )}
      {!ready ? (
        <p className="settings-note" aria-busy="true">
          {t('settings.loading')}
        </p>
      ) : empty ? (
        <EmptyState title={t('settings.labels.empty')} />
      ) : (
        <div className="label-groups" data-testid="label-list">
          {tree.groups.map(({ group, children }) => (
            <ul key={group.id} className="team-list">
              <LabelLine
                label={group}
                canEdit={canEdit}
                onEdit={() => setEditing({ kind: 'group', label: group })}
                onArchive={() => void archive(group)}
              />
              {children.map((child) => (
                <LabelLine
                  key={child.id}
                  label={child}
                  canEdit={canEdit}
                  onEdit={() => setEditing({ kind: 'label', label: child })}
                  onArchive={() => void archive(child)}
                />
              ))}
            </ul>
          ))}
          {tree.loose.length > 0 ? (
            <ul className="team-list">
              {tree.loose.map((label) => (
                <LabelLine
                  key={label.id}
                  label={label}
                  canEdit={canEdit}
                  onEdit={() => setEditing({ kind: 'label', label })}
                  onArchive={() => void archive(label)}
                />
              ))}
            </ul>
          ) : null}
        </div>
      )}
      {editing ? (
        <LabelDialog
          editing={editing}
          groups={tree.groups.map(({ group }) => group)}
          onClose={() => setEditing(null)}
          onSubmit={async ({ name, color, parentId }) => {
            if (editing.label) {
              const { label: dto } = await adminApi.updateLabel(workspaceId, editing.label.id, {
                name,
                color,
                ...(editing.kind === 'label' ? { parentId } : {}),
              });
              written(dto);
            } else {
              const { label: dto } = await adminApi.createLabel(workspaceId, {
                name,
                color,
                teamId,
                parentId,
                isGroup: editing.kind === 'group',
              });
              written(dto);
              toast.show({ message: t('settings.labels.created', { name }) });
            }
            setEditing(null);
          }}
        />
      ) : null}
    </>
  );
}

function WorkspaceLabels({ workspace }: { workspace: SessionWorkspace }) {
  const source = useWorkspaceLabelRows(workspace.id);
  return (
    <LabelScope
      workspaceId={workspace.id}
      teamId={null}
      canEdit={canEditLabels(workspace, null)}
      source={source}
    />
  );
}

function TeamLabels({ workspace, teamId }: { workspace: SessionWorkspace; teamId: string }) {
  const source = useTeamLabelRows(workspace.id, teamId);
  return (
    <LabelScope
      workspaceId={workspace.id}
      teamId={teamId}
      canEdit={canEditLabels(workspace, { id: teamId })}
      source={source}
    />
  );
}

function LabelsBody({ workspace }: { workspace: SessionWorkspace }) {
  const t = useT();
  const { teams } = useTeams(workspace.id);
  const [scope, setScope] = useState('workspace');
  // A team that left the list (access lost) falls back to the workspace's labels.
  const team = teams.find((candidate) => candidate.id === scope) ?? null;

  return (
    <div className="settings-page" data-testid="labels-page">
      <div className="settings-page__head">
        <h2 className="settings-page__title">{t('settings.labels.title')}</h2>
        <Select
          value={team ? team.id : 'workspace'}
          onValueChange={setScope}
          label={t('settings.labels.scope')}
          options={[
            { value: 'workspace', label: t('settings.labels.workspace') },
            ...teams.map((candidate) => ({
              value: candidate.id,
              label: `${candidate.key} · ${candidate.name}`,
            })),
          ]}
        />
      </div>
      {team ? (
        <TeamLabels key={team.id} workspace={workspace} teamId={team.id} />
      ) : (
        <WorkspaceLabels key="workspace" workspace={workspace} />
      )}
    </div>
  );
}

/** The labels of the workspace and of each team: everybody but guests reads them, those with the right edit them. */
export function LabelsPage({ workspace }: { workspace: SessionWorkspace }) {
  return canSeeLabelSettings(workspace) ? <LabelsBody workspace={workspace} /> : <NoAccess />;
}
