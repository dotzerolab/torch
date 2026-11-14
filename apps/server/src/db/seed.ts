// Dev seed: one "demo" workspace with five members, two teams and 50 issues per team, so every screen has
// data. `pnpm --filter @torch/server db:seed` (after `db:migrate`). Idempotent; refuses to run in production.
// `insertWorkspaceLayout` is the one definition of the layout, shared with the test fixture.
import {
  type IssueRow,
  issue,
  type MemberRow,
  member,
  type TeamRow,
  team,
  teamMember,
  type WorkflowStateRow,
  type WorkflowStateType,
  workflowState,
  workspace,
} from '@torch/shared/db/schema';
import { defaultWorkflowStates } from '@torch/shared/db/workflow-defaults';
import { eq } from 'drizzle-orm';
import { createDb, type Orm } from '../db.ts';

export type LayoutRole = 'owner' | 'admin' | 'member' | 'guest' | 'outsider';

export type WorkspaceLayout = {
  workspaceId: string;
  members: Record<LayoutRole, MemberRow>;
  teams: { eng: TeamRow; ops: TeamRow };
  states: {
    eng: Record<WorkflowStateType, WorkflowStateRow>;
    ops: Record<WorkflowStateType, WorkflowStateRow>;
  };
  issues: { eng: IssueRow[]; ops: IssueRow[] };
};

type Tx = Parameters<Parameters<Orm['transaction']>[0]>[0];

const ROLES: LayoutRole[] = ['owner', 'admin', 'member', 'guest', 'outsider'];
const ISSUE_STATE_TYPES: WorkflowStateType[] = [
  'backlog',
  'unstarted',
  'started',
  'completed',
  'canceled',
];
const INSERT_CHUNK = 500;

/**
 * Five members (owner, admin, member, guest and an `outsider` who is in no team), a public ENG team (owner,
 * admin, member, guest), a private OPS team (owner, member), the default workflow states per team and
 * `issuesPerTeam` issues per team numbered 1..n, with `issue_counter` set to n.
 */
export async function insertWorkspaceLayout(
  tx: Tx,
  input: {
    name: string;
    slug: string;
    email: Record<LayoutRole, string>;
    issuesPerTeam: number;
  },
): Promise<WorkspaceLayout> {
  const [ws] = await tx
    .insert(workspace)
    .values({ name: input.name, slug: input.slug })
    .returning();
  if (!ws) throw new Error('workspace insert returned no row');

  const memberRows = await tx
    .insert(member)
    .values(
      ROLES.map((role) => ({
        workspaceId: ws.id,
        email: input.email[role],
        name: `${role[0]?.toUpperCase()}${role.slice(1)} Example`,
        handle: role,
        role: role === 'outsider' ? ('member' as const) : role,
      })),
    )
    .returning();
  const members = Object.fromEntries(memberRows.map((row) => [row.handle, row])) as Record<
    LayoutRole,
    MemberRow
  >;

  const teamRows = await tx
    .insert(team)
    .values([
      { workspaceId: ws.id, key: 'ENG', name: 'Engineering', private: false },
      { workspaceId: ws.id, key: 'OPS', name: 'Operations', private: true },
    ])
    .returning();
  const eng = teamRows.find((row) => row.key === 'ENG');
  const ops = teamRows.find((row) => row.key === 'OPS');
  if (!eng || !ops) throw new Error('team insert returned no rows');

  const memberships: [TeamRow, LayoutRole][] = [
    [eng, 'owner'],
    [eng, 'admin'],
    [eng, 'member'],
    [eng, 'guest'],
    [ops, 'owner'],
    [ops, 'member'],
  ];
  await tx.insert(teamMember).values(
    memberships.map(([t, role]) => ({
      workspaceId: ws.id,
      teamId: t.id,
      memberId: members[role].id,
    })),
  );

  const insertStates = async (t: TeamRow) => {
    const rows = await tx
      .insert(workflowState)
      .values(
        defaultWorkflowStates().map((state) => ({ workspaceId: ws.id, teamId: t.id, ...state })),
      )
      .returning();
    const byType = {} as Record<WorkflowStateType, WorkflowStateRow>;
    for (const row of rows) byType[row.type] = row;
    return byType;
  };
  const states = { eng: await insertStates(eng), ops: await insertStates(ops) };

  const insertIssues = async (
    t: TeamRow,
    teamStates: Record<WorkflowStateType, WorkflowStateRow>,
    assignable: LayoutRole[],
  ) => {
    const values = Array.from({ length: input.issuesPerTeam }, (_, index) => {
      const stateType = ISSUE_STATE_TYPES[index % ISSUE_STATE_TYPES.length] ?? 'backlog';
      const assignee = assignable[index % assignable.length];
      return {
        workspaceId: ws.id,
        teamId: t.id,
        number: index + 1,
        title: `${t.key} issue ${index + 1}`,
        stateId: teamStates[stateType].id,
        priority: index % 5,
        assigneeId: index % 4 === 0 || !assignee ? null : members[assignee].id,
        creatorId: members.owner.id,
      };
    });
    const rows: IssueRow[] = [];
    for (let start = 0; start < values.length; start += INSERT_CHUNK) {
      rows.push(
        ...(await tx
          .insert(issue)
          .values(values.slice(start, start + INSERT_CHUNK))
          .returning()),
      );
    }
    return rows.sort((a, b) => a.number - b.number);
  };
  const issues = {
    eng: await insertIssues(eng, states.eng, ['owner', 'admin', 'member']),
    ops: await insertIssues(ops, states.ops, ['owner', 'member']),
  };

  const setCounter = async (t: TeamRow) => {
    const [row] = await tx
      .update(team)
      .set({ issueCounter: input.issuesPerTeam })
      .where(eq(team.id, t.id))
      .returning();
    if (!row) throw new Error('team counter update returned no row');
    return row;
  };

  return {
    workspaceId: ws.id,
    members,
    teams: { eng: await setCounter(eng), ops: await setCounter(ops) },
    states,
    issues,
  };
}

const DEMO_EMAILS: Record<LayoutRole, string> = {
  owner: 'owner@example.test',
  admin: 'admin@example.test',
  member: 'member@example.test',
  guest: 'guest@example.test',
  outsider: 'outsider@example.test',
};

/** Hostnames of this machine: the only APP_URL a dev seed accepts without `--allow-remote`. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The demo members are `@example.test` addresses (undeliverable), so the demo workspace cannot be signed into by a
 * stranger, but it is still dev data: it never belongs on an installation that is reachable from elsewhere. The
 * guard is opt-in, so a forgotten NODE_ENV is not enough to seed one: unless APP_URL names this machine (or none is
 * set) it refuses, and `allowRemote` (CLI `--allow-remote`) is the explicit way past that. Production is never
 * seeded, flag or not.
 */
function assertSeedAllowed(allowRemote: boolean): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('seedDev refuses to run when NODE_ENV=production');
  }
  const appUrl = process.env.APP_URL;
  if (!appUrl || allowRemote) return;
  let hostname: string | undefined;
  try {
    hostname = new URL(appUrl).hostname;
  } catch {
    // Not echoed: a malformed value may still carry a credential.
  }
  if (hostname !== undefined && LOCAL_HOSTS.has(hostname)) return;
  throw new Error(
    hostname === undefined
      ? 'seedDev refuses to run: APP_URL is not a valid URL, so it cannot be shown to be this machine. Fix it, or pass --allow-remote.'
      : `seedDev refuses to run: APP_URL points at "${hostname}", not at this machine. The demo workspace is for local development; pass --allow-remote to seed it anyway.`,
  );
}

export async function seedDev(
  orm: Orm,
  opts: { issuesPerTeam?: number; allowRemote?: boolean } = {},
): Promise<{ created: boolean; workspaceSlug: 'demo' }> {
  assertSeedAllowed(opts.allowRemote ?? false);
  const issuesPerTeam = opts.issuesPerTeam ?? 50;
  if (!Number.isInteger(issuesPerTeam) || issuesPerTeam < 1) {
    throw new Error(`issuesPerTeam must be a positive integer, got ${issuesPerTeam}`);
  }

  return orm.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: workspace.id })
      .from(workspace)
      .where(eq(workspace.slug, 'demo'))
      .limit(1);
    if (existing) return { created: false, workspaceSlug: 'demo' as const };

    await insertWorkspaceLayout(tx, {
      name: 'Demo',
      slug: 'demo',
      email: DEMO_EMAILS,
      issuesPerTeam,
    });
    return { created: true, workspaceSlug: 'demo' as const };
  });
}

if (import.meta.main) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set (see .env.example)');
    process.exit(1);
  }
  const db = createDb(databaseUrl);
  try {
    const result = await seedDev(db.orm, { allowRemote: process.argv.includes('--allow-remote') });
    console.info(
      result.created
        ? `demo workspace created; sign in as owner@example.test`
        : 'demo workspace already exists, nothing changed',
    );
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  } finally {
    await db.close();
  }
}
