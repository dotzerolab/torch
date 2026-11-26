import { WORKFLOW_STATE_TYPES } from '@torch/shared/db/schema';
import {
  workflowStateCreateInput,
  workflowStateUpdateInput,
} from '@torch/shared/mutations/workflow';
import { ArrowDown, ArrowUp, Plus } from 'lucide-react';
import { type FormEvent, useId, useState } from 'react';
import { ApiError } from '../api.ts';
import type { SessionWorkspace } from '../auth/useSession.ts';
import { Badge } from '../design/components/Badge.tsx';
import { Button } from '../design/components/Button.tsx';
import { Dialog } from '../design/components/Dialog.tsx';
import { EmptyState } from '../design/components/EmptyState.tsx';
import { IconButton } from '../design/components/IconButton.tsx';
import { Input } from '../design/components/Input.tsx';
import { Select } from '../design/components/Select.tsx';
import { useToast } from '../design/components/Toast.tsx';
import { useLocale, useT } from '../design/locale.tsx';
import { adminFailureMessage } from '../errors.ts';
import { useTeams } from '../shell/useTeams.ts';
import type { SyncedWorkflowState } from '../sync/collections.ts';
import { canSeeWorkflowSettings } from './access.ts';
import { adminApi, type WorkflowStateDto } from './admin-api.ts';
import { NoAccess } from './NoAccess.tsx';
import { useWorkflowStates } from './useSettingsRows.ts';
import { activeStates, archiveBlock, reorder, stateRow } from './workflow-model.ts';

const DEFAULT_COLOR = '#94a3b8';

/** Name, color and (for a new state) type: the one form of "add" and "edit". */
function StateDialog({
  state,
  onSubmit,
  onClose,
}: {
  /** The state being edited; absent for a new one. */
  state?: SyncedWorkflowState;
  onSubmit: (input: { name: string; color: string; type: string }) => Promise<void>;
  onClose: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const ids = useId();
  const [name, setName] = useState(state?.name ?? '');
  const [color, setColor] = useState(state?.color ?? DEFAULT_COLOR);
  const [type, setType] = useState(state?.type ?? 'started');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError(null);
    const parsed = state
      ? workflowStateUpdateInput.safeParse({ name, color })
      : workflowStateCreateInput.safeParse({ name, color, type });
    if (!parsed.success) {
      setError(t('settings.workflow.invalid'));
      return;
    }
    setBusy(true);
    try {
      await onSubmit({ name: name.trim(), color, type });
    } catch (failure) {
      setError(adminFailureMessage(locale, failure));
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={state ? t('settings.workflow.editTitle') : t('settings.workflow.addTitle')}
    >
      <form className="form" onSubmit={submit} noValidate data-testid="state-form">
        <div className="form__row">
          <label className="form__label" htmlFor={`${ids}-name`}>
            {t('settings.workflow.name')}
          </label>
          <Input
            id={`${ids}-name`}
            value={name}
            maxLength={80}
            autoComplete="off"
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        {state ? null : (
          <div className="form__row">
            <span className="form__label">{t('settings.workflow.type')}</span>
            <Select
              value={type}
              onValueChange={setType}
              label={t('settings.workflow.type')}
              options={WORKFLOW_STATE_TYPES.map((value) => ({
                value,
                label: t(`issue.stateType.${value}`),
              }))}
            />
            <p className="form__hint">{t('settings.workflow.typeHint')}</p>
          </div>
        )}
        <div className="form__row">
          <label className="form__label" htmlFor={`${ids}-color`}>
            {t('settings.workflow.color')}
          </label>
          <input
            id={`${ids}-color`}
            type="color"
            className="color-input"
            value={color}
            onChange={(event) => setColor(event.target.value)}
          />
        </div>
        {error ? (
          <p className="form__error" role="alert" data-testid="state-error">
            {error}
          </p>
        ) : null}
        <div className="form__actions">
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" variant="primary" loading={busy} data-testid="state-submit">
            {state ? t('common.save') : t('settings.workflow.create')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** A state with issues is archived by moving them: this asks where, and archives with the answer. */
function MoveIssuesDialog({
  state,
  targets,
  onConfirm,
  onClose,
}: {
  state: SyncedWorkflowState;
  targets: SyncedWorkflowState[];
  onConfirm: (targetId: string) => Promise<void>;
  onClose: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const [target, setTarget] = useState(
    (targets.find((other) => other.type === 'unstarted') ?? targets[0])?.id ?? '',
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function confirm() {
    if (busy || !target) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(target);
    } catch (failure) {
      setError(adminFailureMessage(locale, failure));
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t('settings.workflow.moveTitle', { name: state.name })}
      description={t('settings.workflow.moveDescription')}
    >
      <div className="form" data-testid="move-issues-dialog">
        <div className="form__row">
          <span className="form__label">{t('settings.workflow.moveTo')}</span>
          <Select
            value={target}
            onValueChange={setTarget}
            label={t('settings.workflow.moveTo')}
            options={targets.map((other) => ({ value: other.id, label: other.name }))}
          />
        </div>
        {error ? (
          <p className="form__error" role="alert" data-testid="move-error">
            {error}
          </p>
        ) : null}
        <div className="form__actions">
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!target}
            onClick={() => void confirm()}
            data-testid="move-confirm"
          >
            {t('settings.workflow.moveConfirm')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function TeamStates({ workspaceId, teamId }: { workspaceId: string; teamId: string }) {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const { rows, ready, remember, refresh } = useWorkflowStates(workspaceId, teamId);
  const active = activeStates(rows);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<SyncedWorkflowState | null>(null);
  const [moving, setMoving] = useState<SyncedWorkflowState | null>(null);
  const [busy, setBusy] = useState(false);

  /** Keeps the server's answer on screen and asks for the snapshot again. */
  const written = (dto: WorkflowStateDto) => {
    remember(stateRow(dto, workspaceId));
    refresh();
  };

  async function move(state: SyncedWorkflowState, direction: -1 | 1) {
    if (busy) return;
    setBusy(true);
    try {
      for (const change of reorder(active, state.id, direction)) {
        const { state: dto } = await adminApi.updateState(workspaceId, teamId, change.id, {
          position: change.position,
        });
        written(dto);
      }
    } catch (failure) {
      toast.show({ message: adminFailureMessage(locale, failure), tone: 'error' });
      refresh();
    } finally {
      setBusy(false);
    }
  }

  /** Archives; a state that has issues answers `move_target_required`, which opens the "move issues to" dialog. */
  async function archive(state: SyncedWorkflowState, moveIssuesTo?: string) {
    try {
      const { state: dto } = await adminApi.archiveState(
        workspaceId,
        teamId,
        state.id,
        moveIssuesTo,
      );
      written(dto);
      setMoving(null);
      toast.show({ message: t('settings.workflow.archived', { name: state.name }) });
    } catch (failure) {
      if (failure instanceof ApiError && failure.code === 'move_target_required' && !moveIssuesTo) {
        setMoving(state);
        return;
      }
      if (moveIssuesTo) throw failure;
      toast.show({ message: adminFailureMessage(locale, failure), tone: 'error' });
    }
  }

  return (
    <>
      <div className="settings-page__head">
        <h3 className="settings-section__title">{t('settings.workflow.states')}</h3>
        <Button variant="primary" onClick={() => setAdding(true)} data-testid="state-add-open">
          <Plus size={14} aria-hidden="true" />
          {t('settings.workflow.add')}
        </Button>
      </div>
      {!ready ? (
        <p className="settings-note" aria-busy="true">
          {t('settings.loading')}
        </p>
      ) : active.length === 0 ? (
        <EmptyState title={t('settings.workflow.empty')} />
      ) : (
        <ul className="team-list" data-testid="state-list">
          {active.map((state, index) => {
            const block = archiveBlock(active, state);
            const reasonId = `state-reason-${state.id}`;
            return (
              <li
                key={state.id}
                className="team-list__row state-row"
                data-testid={`state-row-${state.name}`}
              >
                <span className="swatch" style={{ background: state.color }} aria-hidden="true" />
                <span className="team-list__name">{state.name}</span>
                <Badge>{t(`issue.stateType.${state.type}`)}</Badge>
                {block ? (
                  <span className="state-row__reason form__hint" id={reasonId}>
                    {t(`settings.workflow.blocked.${block}`)}
                  </span>
                ) : null}
                <span className="team-list__actions">
                  <IconButton
                    label={t('settings.workflow.moveUp', { name: state.name })}
                    icon={<ArrowUp size={14} aria-hidden="true" />}
                    size="sm"
                    disabled={busy || index === 0}
                    onClick={() => void move(state, -1)}
                  />
                  <IconButton
                    label={t('settings.workflow.moveDown', { name: state.name })}
                    icon={<ArrowDown size={14} aria-hidden="true" />}
                    size="sm"
                    disabled={busy || index === active.length - 1}
                    onClick={() => void move(state, 1)}
                  />
                  <Button
                    size="sm"
                    aria-label={t('settings.workflow.editFor', { name: state.name })}
                    onClick={() => setEditing(state)}
                  >
                    {t('settings.workflow.edit')}
                  </Button>
                  <Button
                    size="sm"
                    aria-label={t('settings.workflow.archiveFor', { name: state.name })}
                    aria-describedby={block ? reasonId : undefined}
                    disabled={block !== null}
                    onClick={() => void archive(state)}
                  >
                    {t('settings.workflow.archive')}
                  </Button>
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {adding ? (
        <StateDialog
          onClose={() => setAdding(false)}
          onSubmit={async ({ name, color, type }) => {
            const { state: dto } = await adminApi.createState(workspaceId, teamId, {
              name,
              color,
              type: type as WorkflowStateDto['type'],
            });
            written(dto);
            setAdding(false);
            toast.show({ message: t('settings.workflow.created', { name }) });
          }}
        />
      ) : null}
      {editing ? (
        <StateDialog
          state={editing}
          onClose={() => setEditing(null)}
          onSubmit={async ({ name, color }) => {
            const { state: dto } = await adminApi.updateState(workspaceId, teamId, editing.id, {
              name,
              color,
            });
            written(dto);
            setEditing(null);
          }}
        />
      ) : null}
      {moving ? (
        <MoveIssuesDialog
          state={moving}
          targets={active.filter((other) => other.id !== moving.id)}
          onConfirm={(target) => archive(moving, target)}
          onClose={() => setMoving(null)}
        />
      ) : null}
    </>
  );
}

function WorkflowBody({ workspace }: { workspace: SessionWorkspace }) {
  const t = useT();
  const { teams, ready } = useTeams(workspace.id);
  const [picked, setPicked] = useState<string | null>(null);
  const current = teams.find((team) => team.id === picked) ?? teams[0];

  return (
    <div className="settings-page" data-testid="workflow-page">
      <div className="settings-page__head">
        <h2 className="settings-page__title">{t('settings.workflow.title')}</h2>
        {current ? (
          <Select
            value={current.id}
            onValueChange={setPicked}
            label={t('settings.workflow.team')}
            options={teams.map((team) => ({ value: team.id, label: `${team.key} · ${team.name}` }))}
          />
        ) : null}
      </div>
      <p className="form__hint">{t('settings.workflow.description')}</p>
      {!ready ? (
        <p className="settings-note" aria-busy="true">
          {t('settings.loading')}
        </p>
      ) : current ? (
        <TeamStates key={current.id} workspaceId={workspace.id} teamId={current.id} />
      ) : (
        <EmptyState title={t('settings.workflow.noTeams')} />
      )}
    </div>
  );
}

/** The states of each team: owners and admins add, rename, recolor, reorder and archive them. */
export function WorkflowPage({ workspace }: { workspace: SessionWorkspace }) {
  return canSeeWorkflowSettings(workspace) ? <WorkflowBody workspace={workspace} /> : <NoAccess />;
}
