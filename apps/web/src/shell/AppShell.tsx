import type { Brand } from '@torch/shared/brand';
import type { Locale } from '@torch/shared/i18n';
import { type ReactNode, useState } from 'react';
import type { SessionWorkspace } from '../auth/useSession.ts';
import { Dialog } from '../design/components/Dialog.tsx';
import { ToastProvider } from '../design/components/Toast.tsx';
import { LocaleProvider, useT } from '../design/locale.tsx';
import { useTheme } from '../design/theme.ts';
import { useMediaQuery } from '../design/useMediaQuery.ts';
import { ShortcutHelp } from '../keys/ShortcutHelp.tsx';
import { useShortcut } from '../keys/useShortcut.ts';
import { usePathname } from '../navigation.ts';
import { Header } from './Header.tsx';
import { OfflineBanner } from './OfflineBanner.tsx';
import { ShellContext, type ShellState, teamKeyFromPath } from './ShellContext.ts';
import { Sidebar } from './Sidebar.tsx';
import { StatusBar } from './StatusBar.tsx';
import { useDeviceStore } from './useDeviceStore.ts';
import { useMembershipWatcher } from './useMembershipWatcher.ts';
import { useOutboxEvents } from './useOutboxEvents.ts';
import { useTeams } from './useTeams.ts';

/** Below this width the sidebar is a drawer opened from the header. */
const PHONE_QUERY = '(max-width: 767px)';

function ShellFrame({
  brand,
  workspaces,
  workspace,
  onSelectWorkspace,
  children,
}: {
  brand: Brand;
  workspaces: SessionWorkspace[];
  workspace: SessionWorkspace;
  onSelectWorkspace: (workspaceId: string) => void;
  children: ReactNode;
}) {
  const t = useT();
  const { resolved } = useTheme();
  const phone = useMediaQuery(PHONE_QUERY);
  const pathname = usePathname();
  const { teams, ready } = useTeams(workspace.id);
  useMembershipWatcher(workspace.id, workspace.memberId);
  useOutboxEvents(workspace.id);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  const onSettings = pathname === '/settings' || pathname.startsWith('/settings/');
  const requestedKey = teamKeyFromPath(pathname);
  // An address that names no visible team (a private team of someone else, a typo) shows the first team instead.
  const team = teams.find((candidate) => candidate.key === requestedKey) ?? teams[0] ?? null;
  const state: ShellState = { workspace, teams, teamsReady: ready, team };

  const toggleSidebar = () => (phone ? setDrawerOpen((open) => !open) : setCollapsed((c) => !c));
  useShortcut(
    { id: 'shell.toggleSidebar', keys: 'mod+/', labelKey: 'shortcuts.toggleSidebar' },
    toggleSidebar,
  );

  const sidebar = (onNavigate?: () => void) => (
    <Sidebar
      brand={brand}
      theme={resolved}
      workspaces={workspaces}
      workspace={workspace}
      onSelectWorkspace={onSelectWorkspace}
      teams={teams}
      activeTeamKey={onSettings ? null : (team?.key ?? null)}
      onNavigate={onNavigate}
    />
  );

  return (
    <ShellContext.Provider value={state}>
      <div className="shell" data-collapsed={!phone && collapsed ? 'true' : 'false'}>
        <a className="skip-link" href="#main">
          {t('shell.skipToContent')}
        </a>
        {!phone && !collapsed ? <aside className="shell__sidebar">{sidebar()}</aside> : null}
        <div className="shell__column">
          <OfflineBanner workspaceId={workspace.id} />
          <Header
            workspace={workspace}
            team={team}
            section={onSettings ? t('shell.settings') : undefined}
            showSidebarButton={phone || collapsed}
            onOpenSidebar={toggleSidebar}
          />
          <main id="main" className="shell__main" tabIndex={-1}>
            {children}
          </main>
          <StatusBar synced={ready} />
        </div>
      </div>
      {phone ? (
        <Dialog
          variant="drawer"
          open={drawerOpen}
          onOpenChange={setDrawerOpen}
          title={t('shell.sidebar')}
          hideTitle
        >
          {sidebar(() => setDrawerOpen(false))}
        </Dialog>
      ) : null}
      <ShortcutHelp />
    </ShellContext.Provider>
  );
}

/** Holds the frame back until the device store of the workspace is open (or known to be unavailable). */
function DeviceGate({ workspaceId, children }: { workspaceId: string; children: ReactNode }) {
  return useDeviceStore(workspaceId) ? children : null;
}

/**
 * The frame of every signed-in screen: sidebar (a drawer on a phone), header, the page in `main`, a status line.
 * It also supplies the language, the toast area and the `?` shortcut help to everything inside.
 */
export function AppShell({
  brand,
  workspaces,
  locale,
  children,
}: {
  brand: Brand;
  workspaces: SessionWorkspace[];
  locale: Locale;
  children: ReactNode;
}) {
  const [chosenId, setChosenId] = useState<string | null>(null);
  const workspace = workspaces.find((candidate) => candidate.id === chosenId) ?? workspaces[0];
  if (!workspace) return null;
  return (
    <LocaleProvider locale={locale}>
      <ToastProvider>
        {/* A new workspace starts a new frame: its own team shape, and the sidebar back in its default state. */}
        <DeviceGate key={workspace.id} workspaceId={workspace.id}>
          <ShellFrame
            brand={brand}
            workspaces={workspaces}
            workspace={workspace}
            onSelectWorkspace={setChosenId}
          >
            {children}
          </ShellFrame>
        </DeviceGate>
      </ToastProvider>
    </LocaleProvider>
  );
}
