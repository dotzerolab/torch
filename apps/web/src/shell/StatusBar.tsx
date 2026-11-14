import { Kbd } from '../design/components/Kbd.tsx';
import { useT } from '../design/locale.tsx';

/** The thin line under the page: key hints on the left, the sync state on the right (hidden on a phone). */
export function StatusBar({ synced }: { synced: boolean }) {
  const t = useT();
  return (
    <footer className="shell-status">
      <span>
        <Kbd keys="?" /> {t('shortcuts.title')}
      </span>
      <span>
        <Kbd keys="mod+/" /> {t('shortcuts.toggleSidebar')}
      </span>
      <span className="shell-status__sync" role="status">
        <span className={synced ? 'dot dot--ok' : 'dot'} aria-hidden="true" />
        {synced ? t('shell.sync.synced') : t('shell.sync.syncing')}
      </span>
    </footer>
  );
}
