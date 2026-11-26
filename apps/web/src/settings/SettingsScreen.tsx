import { useEffect } from 'react';
import { navigate, usePathname } from '../navigation.ts';
import { useShell } from '../shell/ShellContext.ts';
import { canSeeLabelSettings, canSeeWorkflowSettings } from './access.ts';
import { LabelsPage } from './LabelsPage.tsx';
import { MembersPage } from './MembersPage.tsx';
import { ProfilePage } from './ProfilePage.tsx';
import { SettingsLayout } from './SettingsLayout.tsx';
import { TeamsPage } from './TeamsPage.tsx';
import { WorkflowPage } from './WorkflowPage.tsx';

/**
 * `/settings/profile`, `/teams`, `/members`, `/workflow` and `/labels`; anything else under `/settings` goes to the
 * profile, and so does a section this role has no tab for (workflow for a member or guest, labels for a guest).
 */
export function SettingsScreen() {
  const { workspace } = useShell();
  const pathname = usePathname().replace(/\/+$/, '');
  const known =
    ['/settings/profile', '/settings/teams', '/settings/members'].includes(pathname) ||
    (pathname === '/settings/workflow' && canSeeWorkflowSettings(workspace)) ||
    (pathname === '/settings/labels' && canSeeLabelSettings(workspace));
  useEffect(() => {
    if (!known) navigate('/settings/profile', { replace: true });
  }, [known]);
  if (!known) return null;

  return (
    <SettingsLayout workspace={workspace}>
      {pathname === '/settings/profile' ? <ProfilePage workspace={workspace} /> : null}
      {pathname === '/settings/teams' ? <TeamsPage workspace={workspace} /> : null}
      {pathname === '/settings/members' ? <MembersPage workspace={workspace} /> : null}
      {pathname === '/settings/workflow' ? <WorkflowPage workspace={workspace} /> : null}
      {pathname === '/settings/labels' ? <LabelsPage workspace={workspace} /> : null}
    </SettingsLayout>
  );
}
