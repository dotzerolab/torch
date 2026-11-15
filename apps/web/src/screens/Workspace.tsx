import { useLiveQuery } from '@tanstack/react-db';
import type { Locale } from '@torch/shared/i18n';
import { t } from '@torch/shared/i18n';
import { issueUpdateInput } from '@torch/shared/mutations/issue';
import { useState } from 'react';
import { ApiError } from '../api.ts';
import { mutationErrorMessage } from '../errors.ts';
import { useShell } from '../shell/ShellContext.ts';
import type { SyncedIssue, SyncedTeam } from '../sync/collections.ts';
import { useShape } from '../sync/shapes.ts';

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
      className="issue-row__title"
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
  const issues = useShape({ kind: 'issues', workspaceId, teamId: team.id });
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

  if (!isReady) {
    return (
      <p className="issues__note" aria-busy="true">
        {t(locale, 'workspace.loading')}
      </p>
    );
  }
  return (
    <section className="issues" aria-label={team.name}>
      {error && (
        <p className="issues__error" role="alert" data-testid="mutation-error">
          {error}
        </p>
      )}
      {data.length === 0 ? (
        <p className="issues__note">{t(locale, 'workspace.noIssues')}</p>
      ) : (
        <ol className="issue-list">
          {data.map((issue) => (
            <li key={issue.id} className="issue-row" data-testid={`issue-${issue.number}`}>
              <span className="issue-row__id">
                {team.key}-{issue.number}
              </span>
              <TitleField
                issue={issue}
                label={t(locale, 'issue.titleLabel', { key: `${team.key}-${issue.number}` })}
                onSave={(title) => save(issue, title)}
              />
              <span className="issue-row__priority" data-testid={`issue-priority-${issue.number}`}>
                {priorityLabel(locale, issue.priority)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** The page of the signed-in shell for now: the issues of the team the shell is showing. */
export function Workspace({ locale }: { locale: Locale }) {
  const { workspace, team, teams, teamsReady } = useShell();
  if (!teamsReady) {
    return (
      <p className="issues__note" aria-busy="true">
        {t(locale, 'workspace.loading')}
      </p>
    );
  }
  if (teams.length === 0 || !team) {
    return <p className="issues__note">{t(locale, 'workspace.noTeams')}</p>;
  }
  return <IssueList key={team.id} workspaceId={workspace.id} team={team} locale={locale} />;
}
