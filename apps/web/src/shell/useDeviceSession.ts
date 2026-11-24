import { useEffect, useState } from 'react';
import type { SessionWorkspace } from '../auth/useSession.ts';
import { startDeviceSession } from '../sync/persistence.ts';

/**
 * Tells the device who is signed in, and clears away what belongs to someone else, before anything reads the device:
 * stored rows are never shown and queued writes never resumed under a session they were not made in. Reports when that
 * is done; the frame renders nothing until then.
 */
export function useDeviceSession(workspaces: SessionWorkspace[]): boolean {
  const [ready, setReady] = useState(false);
  const identity = workspaces.map((workspace) => `${workspace.id}:${workspace.memberId}`).join(',');
  // biome-ignore lint/correctness/useExhaustiveDependencies: `identity` is the content of `workspaces`
  useEffect(() => {
    let live = true;
    setReady(false);
    void startDeviceSession(workspaces).then(() => live && setReady(true));
    return () => {
      live = false;
    };
  }, [identity]);
  return ready;
}
