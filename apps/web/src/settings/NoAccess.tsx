import { EmptyState } from '../design/components/EmptyState.tsx';
import { useT } from '../design/locale.tsx';

/** What a page shows to a role that may not use it. The server refuses the calls too; this only says so politely. */
export function NoAccess() {
  const t = useT();
  return (
    <div data-testid="no-access">
      <EmptyState
        title={t('settings.noAccess.title')}
        description={t('settings.noAccess.description')}
      />
    </div>
  );
}
