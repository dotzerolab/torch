import { PanelLeft } from 'lucide-react';
import type { SessionWorkspace } from '../auth/useSession.ts';
import { IconButton } from '../design/components/IconButton.tsx';
import { useT } from '../design/locale.tsx';
import type { SyncedTeam } from '../sync/collections.ts';
import { ThemeMenu } from './ThemeMenu.tsx';

/** The bar above the page: sidebar button when the sidebar is out of sight, where you are, the theme menu. */
export function Header({
  workspace,
  team,
  showSidebarButton,
  onOpenSidebar,
}: {
  workspace: SessionWorkspace;
  team: SyncedTeam | null;
  showSidebarButton: boolean;
  onOpenSidebar: () => void;
}) {
  const t = useT();
  return (
    <header className="shell-header">
      {showSidebarButton ? (
        <IconButton
          label={t('shell.openSidebar')}
          icon={<PanelLeft size={16} aria-hidden="true" />}
          onClick={onOpenSidebar}
        />
      ) : null}
      <div className="crumb">
        {team ? (
          <>
            <span className="crumb__workspace" data-testid="workspace-name">
              {workspace.name}
            </span>
            <span className="crumb__separator" aria-hidden="true">
              /
            </span>
            <h1 className="crumb__title">{team.name}</h1>
          </>
        ) : (
          <h1 className="crumb__title" data-testid="workspace-name">
            {workspace.name}
          </h1>
        )}
      </div>
      <div className="shell-header__tools">
        <ThemeMenu />
      </div>
    </header>
  );
}
