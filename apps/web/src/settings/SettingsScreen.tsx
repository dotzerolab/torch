import { useEffect } from 'react';
import { navigate, usePathname } from '../navigation.ts';
import { useShell } from '../shell/ShellContext.ts';
import { MembersPage } from './MembersPage.tsx';
import { ProfilePage } from './ProfilePage.tsx';
import { SettingsLayout } from './SettingsLayout.tsx';
import { TeamsPage } from './TeamsPage.tsx';

/** `/settings/profile`, `/settings/teams`, `/settings/members`; anything else under `/settings` goes to the profile. */
export function SettingsScreen() {
  const { workspace } = useShell();
  const pathname = usePathname().replace(/\/+$/, '');
  const known = ['/settings/profile', '/settings/teams', '/settings/members'].includes(pathname);
  useEffect(() => {
    if (!known) navigate('/settings/profile', { replace: true });
  }, [known]);
  if (!known) return null;

  return (
    <SettingsLayout workspace={workspace}>
      {pathname === '/settings/profile' ? <ProfilePage workspace={workspace} /> : null}
      {pathname === '/settings/teams' ? <TeamsPage workspace={workspace} /> : null}
      {pathname === '/settings/members' ? <MembersPage workspace={workspace} /> : null}
    </SettingsLayout>
  );
}
