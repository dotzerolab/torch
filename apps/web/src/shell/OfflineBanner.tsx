import { useSyncExternalStore } from 'react';
import { useT } from '../design/locale.tsx';
import { pendingCount, subscribePending } from '../sync/outbox.ts';

function subscribeOnline(callback: () => void) {
  window.addEventListener('online', callback);
  window.addEventListener('offline', callback);
  return () => {
    window.removeEventListener('online', callback);
    window.removeEventListener('offline', callback);
  };
}

/**
 * A line above the page while the connection is down or changes are still waiting to reach the server ("Offline, 3
 * waiting"). Nothing shows when the connection is up and the queue is empty.
 */
export function OfflineBanner({ workspaceId }: { workspaceId: string }) {
  const t = useT();
  const online = useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
  const count = useSyncExternalStore(
    subscribePending,
    () => pendingCount(workspaceId),
    () => 0,
  );
  if (online && count === 0) return null;
  const text = !online
    ? count > 0
      ? t('shell.offline', { count: String(count) })
      : t('shell.offline.none')
    : t('shell.pending', { count: String(count) });
  return (
    <div className="shell-offline" role="status" data-testid="offline-banner">
      {text}
    </div>
  );
}
