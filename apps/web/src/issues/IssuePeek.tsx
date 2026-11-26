// The `?peek=ENG-12` side panel: beside the list, not over it (no scrim, no focus trap), so the list stays usable. It
// only previews issues of the team on screen, whose issues are already loaded: another team's would open a second live
// connection, so it reads as "not found" like any issue the person cannot open.

import { useT } from '../design/locale.tsx';
import { useShortcut } from '../keys/useShortcut.ts';
import type { SyncedTeam } from '../sync/collections.ts';
import { IssuePanel } from './IssuePanel.tsx';

export function IssuePeek({
  workspaceId,
  team,
  identifier,
  onClose,
}: {
  workspaceId: string;
  team: SyncedTeam;
  identifier: string;
  onClose: () => void;
}) {
  const t = useT();
  useShortcut({ id: 'peek.close', keys: 'escape', labelKey: 'shortcuts.issues.clear' }, onClose);
  return (
    <aside className="issue-peek" aria-label={t('issue.peek.label')} data-testid="issue-peek">
      <IssuePanel
        key={identifier}
        workspaceId={workspaceId}
        team={team}
        identifier={identifier}
        variant="peek"
        onClose={onClose}
      />
    </aside>
  );
}
