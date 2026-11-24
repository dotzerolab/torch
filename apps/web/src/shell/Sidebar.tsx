import type { Brand } from '@torch/shared/brand';
import { Inbox, LogOut, Settings, UserRound } from 'lucide-react';
import { type MouseEvent, type ReactNode, useState } from 'react';
import type { SessionWorkspace } from '../auth/useSession.ts';
import { Button } from '../design/components/Button.tsx';
import { Dialog } from '../design/components/Dialog.tsx';
import { useT } from '../design/locale.tsx';
import type { ResolvedTheme } from '../design/theme.ts';
import { navigate, usePathname } from '../navigation.ts';
import type { SyncedTeam } from '../sync/collections.ts';
import { signOutWorkspaces } from '../sync/sign-out.ts';
import { WorkspaceSwitcher } from './WorkspaceSwitcher.tsx';

/** An entry whose screen does not exist yet: shown, announced as disabled, not focusable. */
function Placeholder({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <li>
      <span className="sidebar__item sidebar__item--disabled" aria-disabled="true">
        {icon}
        {children}
      </span>
    </li>
  );
}

function isPlainClick(event: MouseEvent) {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/** The sidebar body, shared by the fixed sidebar (desktop) and the drawer (phone). */
export function Sidebar({
  brand,
  theme,
  workspaces,
  workspace,
  onSelectWorkspace,
  teams,
  activeTeamKey,
  onNavigate,
}: {
  brand: Brand;
  theme: ResolvedTheme;
  workspaces: SessionWorkspace[];
  workspace: SessionWorkspace;
  onSelectWorkspace: (workspaceId: string) => void;
  teams: SyncedTeam[];
  activeTeamKey: string | null;
  /** Called after a link was followed, so a drawer can close. */
  onNavigate?: () => void;
}) {
  const t = useT();
  const pathname = usePathname();
  const onSettings = pathname === '/settings' || pathname.startsWith('/settings/');
  // Set while the person is asked whether to sign out with changes that never reached the server.
  const [asking, setAsking] = useState<{ pending: number; answer: (go: boolean) => void } | null>(
    null,
  );
  const requestSignOut = () =>
    signOutWorkspaces(
      workspaces.map((candidate) => candidate.id),
      (pending) => new Promise<boolean>((answer) => setAsking({ pending, answer })),
    );
  const answer = (go: boolean) => {
    asking?.answer(go);
    setAsking(null);
  };
  return (
    <nav className="sidebar" aria-label={t('shell.sidebar')}>
      <WorkspaceSwitcher
        brand={brand}
        theme={theme}
        workspaces={workspaces}
        currentId={workspace.id}
        onSelect={onSelectWorkspace}
      />
      <ul className="sidebar__list">
        <Placeholder icon={<UserRound size={16} aria-hidden="true" />}>
          {t('shell.myIssues')}
        </Placeholder>
        <Placeholder icon={<Inbox size={16} aria-hidden="true" />}>{t('shell.inbox')}</Placeholder>
      </ul>
      <p className="sidebar__group" id="sidebar-teams">
        {t('shell.teams')}
      </p>
      <ul className="sidebar__list" aria-labelledby="sidebar-teams">
        {teams.map((team) => {
          const href = `/teams/${team.key}`;
          return (
            <li key={team.id}>
              <a
                className="sidebar__item"
                href={href}
                data-testid={`team-${team.key}`}
                aria-current={team.key === activeTeamKey ? 'page' : undefined}
                onClick={(event) => {
                  if (!isPlainClick(event)) return;
                  event.preventDefault();
                  navigate(href);
                  onNavigate?.();
                }}
              >
                <span className="sidebar__team-badge" aria-hidden="true">
                  {Array.from(team.name)[0]?.toUpperCase()}
                </span>
                {team.name}
              </a>
            </li>
          );
        })}
      </ul>
      <div className="sidebar__footer">
        <ul className="sidebar__list">
          <li>
            <a
              className="sidebar__item"
              href="/settings/profile"
              data-testid="settings-link"
              aria-current={onSettings ? 'page' : undefined}
              onClick={(event) => {
                if (!isPlainClick(event)) return;
                event.preventDefault();
                navigate('/settings/profile');
                onNavigate?.();
              }}
            >
              <Settings size={16} aria-hidden="true" />
              {t('shell.settings')}
            </a>
          </li>
        </ul>
        <Button
          variant="ghost"
          className="sidebar__signout"
          data-testid="sign-out"
          onClick={() => void requestSignOut()}
        >
          <LogOut size={16} aria-hidden="true" />
          {t('workspace.signOut')}
        </Button>
      </div>
      <Dialog
        open={asking !== null}
        onOpenChange={(open) => {
          if (!open) answer(false);
        }}
        title={t('workspace.signOut.confirmTitle')}
        description={t('workspace.signOut.confirmBody', { count: String(asking?.pending ?? 0) })}
      >
        <div className="dialog__actions">
          <Button variant="secondary" onClick={() => answer(false)}>
            {t('workspace.signOut.stay')}
          </Button>
          <Button variant="danger" data-testid="sign-out-discard" onClick={() => answer(true)}>
            {t('workspace.signOut.discard')}
          </Button>
        </div>
      </Dialog>
    </nav>
  );
}
