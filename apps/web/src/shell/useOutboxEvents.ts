import { useEffect } from 'react';
import { useToast } from '../design/components/Toast.tsx';
import { useLocale, useT } from '../design/locale.tsx';
import { mutationErrorMessage } from '../errors.ts';
import { outbox } from '../sync/outbox.ts';

/**
 * What the page does with the outbox while a workspace is open: sends the writes the last visit left behind, and says so
 * when the server refuses one or the person lost the team it touched and no screen is waiting on it.
 */
export function useOutboxEvents(workspaceId: string): void {
  const t = useT();
  const locale = useLocale();
  const { show } = useToast();
  useEffect(() => {
    // A device without IndexedDB cannot hold a queue: there is nothing to resume.
    void outbox.resume(workspaceId).catch(() => {});
  }, [workspaceId]);
  useEffect(
    () =>
      outbox.subscribeDropped((_write, error, handled) => {
        // A screen that is still waiting on the write shows the refusal itself; this is for the ones nobody waits on.
        if (handled) return;
        show({
          message: t('shell.writeDropped', { message: mutationErrorMessage(locale, error) }),
          tone: 'error',
        });
      }),
    [show, t, locale],
  );
}
