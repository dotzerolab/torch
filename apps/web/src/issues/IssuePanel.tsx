// One issue of a team by its identifier, as a side preview or as a page: finds the row in the team's loaded issues,
// reads the description and the followers, and sends every change the person makes. An issue that is not there (it never
// was, or the person cannot see it) is one "not found" state; one that was there and leaves closes the panel.
import type { IssueUpdateInput } from '@torch/shared/mutations/issue';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useToast } from '../design/components/Toast.tsx';
import { useLocale, useT } from '../design/locale.tsx';
import { mutationErrorMessage } from '../errors.ts';
import { splitIdentifier } from '../routes.ts';
import { useShell } from '../shell/ShellContext.ts';
import type { SyncedTeam } from '../sync/collections.ts';
import { useShape } from '../sync/shapes.ts';
import { useTeamData } from './data.ts';
import { IssuePanelView } from './IssuePanelView.tsx';
import { localDay } from './model/day.ts';
import type { IssueRow } from './model/engine.ts';
import { saveDescription, setArchived, setSubscribed, updateIssue } from './mutate.ts';
import { useIssue } from './useIssue.ts';
import { useIssueDetail } from './useIssueDetail.ts';

/** The one text for an issue that does not exist and one the person cannot see: it must not tell them apart. */
export function IssueNotFound() {
  const t = useT();
  return (
    <p className="issues__note" data-testid="issue-not-found">
      {t('issue.notFound')}
    </p>
  );
}

function Loaded({
  workspaceId,
  team,
  row,
  variant,
  onClose,
}: {
  workspaceId: string;
  team: SyncedTeam;
  row: IssueRow;
  variant: 'peek' | 'page';
  onClose: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const { workspace } = useShell();
  const meId = workspace.memberId;
  const data = useTeamData(workspaceId, team.id);
  const issues = useShape({ kind: 'issues', workspaceId, teamId: team.id });
  const detail = useIssueDetail(workspaceId, team.id, row.id);
  const today = useMemo(() => localDay(), []);
  const [error, setError] = useState<string | null>(null);
  const fail = useCallback(
    (failure: unknown) => setError(mutationErrorMessage(locale, failure)),
    [locale],
  );

  // What was just saved shows at once and stays until the snapshot of the issue agrees.
  const [saved, setSaved] = useState<string | null>(null);
  useEffect(() => {
    if (saved !== null && detail.description === saved) setSaved(null);
  }, [saved, detail.description]);
  // The same for the follow toggle.
  const [follow, setFollow] = useState<boolean | null>(null);
  const following = detail.subscriberIds.includes(meId);
  useEffect(() => {
    if (follow !== null && following === follow) setFollow(null);
  }, [follow, following]);
  const subscribed = follow ?? following;

  const copy = (what: 'identifier' | 'link') => {
    const text =
      what === 'identifier' ? row.identifier : `${window.location.origin}/issues/${row.identifier}`;
    navigator.clipboard?.writeText(text).then(
      () => toast.show({ message: t('issue.copied') }),
      () => {},
    );
  };

  return (
    <IssuePanelView
      row={row}
      data={data}
      teamName={team.name}
      teamKey={team.key}
      meId={meId}
      today={today}
      variant={variant}
      description={saved ?? detail.description}
      subscribed={subscribed}
      error={error}
      onUpdate={(patch: IssueUpdateInput) => {
        setError(null);
        updateIssue(issues, row.issue, patch).catch(fail);
      }}
      onSaveDescription={async (text) => {
        setError(null);
        await saveDescription(row.issue, text);
        setSaved(text);
      }}
      onToggleSubscribe={() => {
        const next = !subscribed;
        const before = follow;
        setError(null);
        setFollow(next);
        setSubscribed(row.issue, meId, next).catch((failure: unknown) => {
          setFollow(before);
          fail(failure);
        });
      }}
      onSetArchived={(archived) => {
        setError(null);
        setArchived(row.issue, archived).catch(fail);
      }}
      onCopy={copy}
      onClose={onClose}
    />
  );
}

export function IssuePanel({
  workspaceId,
  team,
  identifier,
  variant,
  onClose,
}: {
  workspaceId: string;
  team: SyncedTeam;
  identifier: string;
  variant: 'peek' | 'page';
  /** Closes the panel: the peek leaves the address, the page goes back to the team. */
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const split = splitIdentifier(identifier);
  const number = split && split.key === team.key ? split.number : -1;
  const { row, ready, gone } = useIssue(workspaceId, team, number);

  useEffect(() => {
    if (!gone) return;
    toast.show({ message: t('issue.unavailable') });
    onClose();
  }, [gone, toast, t, onClose]);

  if (row) {
    return (
      <Loaded workspaceId={workspaceId} team={team} row={row} variant={variant} onClose={onClose} />
    );
  }
  if (gone) return null;
  if (!ready && number > 0) {
    return (
      <p className="issues__note" aria-busy="true">
        {t('workspace.loading')}
      </p>
    );
  }
  return <IssueNotFound />;
}
