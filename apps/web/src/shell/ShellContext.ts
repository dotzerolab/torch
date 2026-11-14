import { createContext, useContext } from 'react';
import type { SessionWorkspace } from '../auth/useSession.ts';
import type { SyncedTeam } from '../sync/collections.ts';

export type ShellState = {
  workspace: SessionWorkspace;
  teams: SyncedTeam[];
  teamsReady: boolean;
  /** The team the page is about: the one in the address, else the first the member can see. */
  team: SyncedTeam | null;
};

export const ShellContext = createContext<ShellState | undefined>(undefined);

/** The workspace and team the shell is showing; for screens rendered inside `AppShell`. */
export function useShell(): ShellState {
  const state = useContext(ShellContext);
  if (!state) throw new Error('useShell needs an AppShell above it');
  return state;
}

/** `/teams/ENG` gives `ENG`; any other address gives null. */
export function teamKeyFromPath(pathname: string): string | null {
  return /^\/teams\/([^/]+)\/?$/.exec(pathname)?.[1] ?? null;
}
