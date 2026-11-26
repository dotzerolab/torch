// What losing a team means for My Issues: its device copy holds rows of every team, so a lost team's rows would stay in it.
import type { ShapeKey } from './registry.ts';

/**
 * A team is gone for this person. An open My Issues shape starts over (the restart removes the copy the old instance
 * kept, once it has stopped, and the server answers the new one without the team's rows); one that is not open has only
 * the copy on the device, which goes at once.
 */
export function forgetMyIssues(
  registry: { isOpen(key: ShapeKey): boolean; restart(key: ShapeKey): void },
  workspaceId: string,
  deleteCopy: (workspaceId: string) => Promise<unknown>,
): void {
  const key: ShapeKey = { kind: 'myIssues', workspaceId };
  if (registry.isOpen(key)) registry.restart(key);
  else void deleteCopy(workspaceId).catch(() => {});
}
