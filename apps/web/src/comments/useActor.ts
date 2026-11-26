import type { Actor, TeamAccess } from '@torch/shared/permissions';
import { useMemo } from 'react';
import { useShell } from '../shell/ShellContext.ts';

/**
 * Who the person is in the workspace and the team a component is about, in the form the permission functions of
 * `@torch/shared` take. The teams of the shell are the ones the server shows this person, so a team in the list is one
 * they can see. `team` is null when the team is not (or not yet) in the list: nothing is then allowed.
 */
export function useActor(teamId: string): { actor: Actor; team: TeamAccess | null } {
  const { workspace, teams } = useShell();
  return useMemo(() => {
    const found = teams.find((candidate) => candidate.id === teamId);
    return {
      actor: {
        workspaceId: workspace.id,
        memberId: workspace.memberId,
        role: workspace.role,
        teamIds: new Set(teams.map((candidate) => candidate.id)),
      },
      team: found
        ? { id: found.id, workspaceId: found.workspace_id, private: found.private }
        : null,
    };
  }, [workspace.id, workspace.memberId, workspace.role, teams, teamId]);
}
