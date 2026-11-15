import { canManageMembers } from '@torch/shared/permissions';
import type { MouseEvent, ReactNode } from 'react';
import type { SessionWorkspace } from '../auth/useSession.ts';
import { cx } from '../design/cx.ts';
import { useT } from '../design/locale.tsx';
import { navigate, usePathname } from '../navigation.ts';
import { actorOf } from './access.ts';

const isPlainClick = (event: MouseEvent) =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

/** The settings frame: a short list of sections (only those the role can use) and the page of the chosen one. */
export function SettingsLayout({
  workspace,
  children,
}: {
  workspace: SessionWorkspace;
  children: ReactNode;
}) {
  const t = useT();
  const pathname = usePathname();
  const tabs = [
    { id: 'profile', path: '/settings/profile', label: t('settings.nav.profile') },
    { id: 'teams', path: '/settings/teams', label: t('settings.nav.teams') },
    ...(canManageMembers(actorOf(workspace))
      ? [{ id: 'members', path: '/settings/members', label: t('settings.nav.members') }]
      : []),
  ];
  return (
    <div className="settings">
      <nav className="settings__nav" aria-label={t('settings.nav')}>
        {tabs.map((tab) => (
          <a
            key={tab.id}
            className={cx('settings__tab', pathname === tab.path && 'settings__tab--active')}
            href={tab.path}
            data-testid={`settings-tab-${tab.id}`}
            aria-current={pathname === tab.path ? 'page' : undefined}
            onClick={(event) => {
              if (!isPlainClick(event)) return;
              event.preventDefault();
              navigate(tab.path);
            }}
          >
            {tab.label}
          </a>
        ))}
      </nav>
      <div className="settings__body">{children}</div>
    </div>
  );
}
