import { useLiveQuery } from '@tanstack/react-db';
import type { Locale } from '@torch/shared/i18n';
import { t } from '@torch/shared/i18n';
import { issueUpdateInput } from '@torch/shared/mutations/issue';
import { useState } from 'react';
import { ApiError } from '../api.ts';
import { type SessionWorkspace, signOut } from '../auth/useSession.ts';
import { mutationErrorMessage } from '../errors.ts';
import {
  issuesCollection,
  type SyncedIssue,
  type SyncedTeam,
  teamsCollection,
} from '../sync/collections.ts';

const MAX_PRIORITY = 4;

function priorityLabel(locale: Locale, priority: number): string {
  return t(locale, `issue.priority.${priority >= 0 && priority <= MAX_PRIORITY ? priority : 0}`);
}

/** The issue title as a text field: Enter saves, Escape or leaving the field puts the synced title back. */
function TitleField({
  issue,
  label,
  onSave,
}: {
  issue: SyncedIssue;
  label: string;
  onSave: (title: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      data-testid={`issue-title-${issue.number}`}
      aria-label={label}
      maxLength={255}
      value={draft ?? issue.title}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => setDraft(null)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') setDraft(null);
        if (event.key !== 'Enter') return;
        event.preventDefault();
        if (draft !== null && draft !== issue.title) onSave(draft);
        setDraft(null);
      }}
    />
  );
}

function IssueList({
  workspaceId,
  team,
  locale,
}: {
  workspaceId: string;
  team: SyncedTeam;
  locale: Locale;
}) {
  const issues = issuesCollection(workspaceId, team.id);
  const { data, isReady } = useLiveQuery({
    query: (q) => q.from({ issue: issues }).orderBy(({ issue }) => issue.number),
  });
  const [error, setError] = useState<string | null>(null);

  function save(issue: SyncedIssue, title: string) {
    setError(null);
    const input = issueUpdateInput.safeParse({ title });
    if (!input.success || input.data.title === undefined) {
      setError(mutationErrorMessage(locale, new ApiError(400, 'invalid_input', '')));
      return;
    }
    const newTitle = input.data.title;
    if (newTitle === issue.title) return;
    // The change shows at once; a refusal rolls it back by itself and lands here with the server's code.
    const transaction = issues.update(issue.id, (draft) => {
      draft.title = newTitle;
    });
    transaction.when('settled').catch((failure: unknown) => {
      setError(mutationErrorMessage(locale, failure));
    });
  }

  if (!isReady) return <p aria-busy="true">{t(locale, 'workspace.loading')}</p>;
  return (
    <section aria-label={team.name}>
      {error && (
        <p role="alert" data-testid="mutation-error">
          {error}
        </p>
      )}
      {data.length === 0 ? (
        <p>{t(locale, 'workspace.noIssues')}</p>
      ) : (
        <ol>
          {data.map((issue) => (
            <li key={issue.id} data-testid={`issue-${issue.number}`}>
              <span>
                {team.key}-{issue.number}
              </span>{' '}
              <TitleField
                issue={issue}
                label={t(locale, 'issue.titleLabel', { key: `${team.key}-${issue.number}` })}
                onSave={(title) => save(issue, title)}
              />{' '}
              <span data-testid={`issue-priority-${issue.number}`}>
                {priorityLabel(locale, issue.priority)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function WorkspaceBody({ workspace, locale }: { workspace: SessionWorkspace; locale: Locale }) {
  const teams = teamsCollection(workspace.id);
  const { data, isReady } = useLiveQuery({
    query: (q) => q.from({ team: teams }).orderBy(({ team }) => team.key),
  });
  const [chosenId, setChosenId] = useState<string | null>(null);

  if (!isReady) return <p aria-busy="true">{t(locale, 'workspace.loading')}</p>;
  if (data.length === 0) return <p>{t(locale, 'workspace.noTeams')}</p>;

  // The first team until one is picked, and again if the picked one is no longer shared with this member.
  const selected = data.find((team) => team.id === chosenId) ?? data[0];
  return (
    <>
      <nav aria-label={t(locale, 'workspace.teams')}>
        <ul>
          {data.map((team) => (
            <li key={team.id}>
              <button
                type="button"
                data-testid={`team-${team.key}`}
                aria-current={team.id === selected?.id ? 'true' : undefined}
                onClick={() => setChosenId(team.id)}
              >
                {team.key} {team.name}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      {selected && (
        <IssueList key={selected.id} workspaceId={workspace.id} team={selected} locale={locale} />
      )}
    </>
  );
}

export function Workspace({
  workspaces,
  locale,
}: {
  workspaces: SessionWorkspace[];
  locale: Locale;
}) {
  const [chosenId, setChosenId] = useState<string | null>(null);
  const workspace = workspaces.find((candidate) => candidate.id === chosenId) ?? workspaces[0];
  if (!workspace) return null;

  return (
    <main>
      <header>
        <h1 data-testid="workspace-name">{workspace.name}</h1>
        {workspaces.length > 1 && (
          <select
            aria-label={t(locale, 'workspace.picker')}
            data-testid="workspace-picker"
            value={workspace.id}
            onChange={(event) => setChosenId(event.target.value)}
          >
            {workspaces.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </select>
        )}
        <button type="button" data-testid="sign-out" onClick={() => void signOut()}>
          {t(locale, 'workspace.signOut')}
        </button>
      </header>
      <WorkspaceBody key={workspace.id} workspace={workspace} locale={locale} />
    </main>
  );
}
