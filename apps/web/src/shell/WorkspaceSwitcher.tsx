import type { Brand } from '@torch/shared/brand';
import { Check, ChevronDown } from 'lucide-react';
import type { SessionWorkspace } from '../auth/useSession.ts';
import { Menu } from '../design/components/Menu.tsx';
import { useT } from '../design/locale.tsx';
import type { ResolvedTheme } from '../design/theme.ts';

/**
 * The brand logo at the top of the sidebar. With more than one workspace it opens a menu to switch; with one it
 * is just the logo. The logo follows the resolved theme (a dark file on a dark page).
 */
export function WorkspaceSwitcher({
  brand,
  theme,
  workspaces,
  currentId,
  onSelect,
}: {
  brand: Brand;
  theme: ResolvedTheme;
  workspaces: SessionWorkspace[];
  currentId: string;
  onSelect: (workspaceId: string) => void;
}) {
  const t = useT();
  const logo = (
    <img
      className="shell-logo"
      src={theme === 'dark' ? brand.logoDark : brand.logoLight}
      alt={brand.productName}
      height={20}
    />
  );
  if (workspaces.length < 2) return <div className="switcher">{logo}</div>;
  return (
    <Menu
      items={workspaces.map((workspace) => ({
        id: workspace.id,
        label: workspace.name,
        icon:
          workspace.id === currentId ? (
            <Check size={14} aria-hidden="true" />
          ) : (
            <span className="menu__icon-gap" aria-hidden="true" />
          ),
        onSelect: () => onSelect(workspace.id),
      }))}
      trigger={
        <button type="button" className="switcher switcher--button">
          {logo}
          <span className="visually-hidden">{t('shell.switchWorkspace')}</span>
          <ChevronDown size={14} aria-hidden="true" />
        </button>
      }
    />
  );
}
