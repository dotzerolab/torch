// Builders shared by the issue-model tests: a fresh team with the default workflow, labels, actors, created issues.
import {
  type ActivityClient,
  issue,
  label,
  team,
  teamMember,
  workflowState,
} from '@torch/shared/db/schema';
import { defaultWorkflowStates } from '@torch/shared/db/workflow-defaults';
import type { IssueCreateInput } from '@torch/shared/mutations/issue';
import { eq } from 'drizzle-orm';
import type { Db } from '../db.ts';
import { createIssue } from '../issues/create-issue.ts';
import { type ClientActor, loadClientActor } from '../permissions/load-actor.ts';
import type { WorkspaceFixture } from './fixtures.ts';

export type Who = keyof WorkspaceFixture['members'];

export async function actorOf(
  db: Db,
  f: WorkspaceFixture,
  who: Who,
  client: ActivityClient = 'web',
): Promise<ClientActor> {
  const actor = await loadClientActor(db.orm, f.workspaceId, f.members[who].id, client);
  if (!actor) throw new Error(`no actor for ${who}`);
  return actor;
}

/** A new public team with the default workflow, no issues and the four layout roles in it (not the outsider). */
export async function freshTeam(db: Db, f: WorkspaceFixture, key: string) {
  const [created] = await db.orm
    .insert(team)
    .values({ workspaceId: f.workspaceId, key, name: `Team ${key}` })
    .returning();
  if (!created) throw new Error('team insert returned no row');
  const states = await db.orm
    .insert(workflowState)
    .values(
      defaultWorkflowStates().map((state) => ({
        workspaceId: f.workspaceId,
        teamId: created.id,
        ...state,
      })),
    )
    .returning();
  await db.orm.insert(teamMember).values(
    (['owner', 'admin', 'member', 'guest'] as const).map((who) => ({
      workspaceId: f.workspaceId,
      teamId: created.id,
      memberId: f.members[who].id,
    })),
  );
  const stateId = (type: (typeof states)[number]['type']) => {
    const found = states.find((state) => state.type === type);
    if (!found) throw new Error(`no ${type} state`);
    return found.id;
  };
  return { team: created, stateId };
}

export async function newLabel(
  db: Db,
  f: WorkspaceFixture,
  name: string,
  over: Partial<typeof label.$inferInsert> = {},
) {
  const [row] = await db.orm
    .insert(label)
    .values({ workspaceId: f.workspaceId, name, color: '#336699', ...over })
    .returning();
  if (!row) throw new Error('label insert returned no row');
  return row;
}

/** Creates an issue as `who` and returns its row; a refusal is a test setup error. */
export async function makeIssue(
  db: Db,
  f: WorkspaceFixture,
  teamId: string,
  title: string,
  extra: Partial<IssueCreateInput> = {},
  who: Who = 'owner',
) {
  const result = await createIssue(db.orm, await actorOf(db, f, who), {
    teamId,
    title,
    ...extra,
  });
  if (!result.ok) throw new Error(`setup: createIssue refused: ${result.error.code}`);
  const [row] = await db.orm.select().from(issue).where(eq(issue.id, result.body.issue.id));
  if (!row) throw new Error('issue vanished');
  return row;
}
