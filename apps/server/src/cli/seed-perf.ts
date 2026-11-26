// Performance seed: one workspace "perf" with one team holding 10,000 issues and two members, the size the sync bar
// is measured at (docs/design.md section 14), with labels, estimates, due dates and sub-issues on them. Deterministic (titles, states, priorities and assignees come from the
// issue number) and opt-in like the dev seed: it refuses to run unless the database and the app are on this machine.
// `pnpm --filter @torch/server db:seed-perf` (after `db:migrate`). Idempotent.
import {
  issue,
  label,
  member,
  team,
  teamMember,
  workflowState,
  workspace,
} from '@torch/shared/db/schema';
import { defaultWorkflowStates } from '@torch/shared/db/workflow-defaults';
import { and, eq, sql } from 'drizzle-orm';
import { assertSeedAllowed } from '../db/seed.ts';
import { createDb, type Orm, type Tx } from '../db.ts';

export const PERF_WORKSPACE_SLUG = 'perf';
export const PERF_ISSUES = 10_000;
const INSERT_CHUNK = 500;

// What the views are measured on besides plain issues. Everything comes from the issue number, so two runs (and two
// machines) see the same data: a label on every third issue, an estimate on every second, a due date on every fifth,
// and every fiftieth issue is a sub-issue of the one before it.
const LABEL_GROUP = { name: 'Kind', color: '#a78bfa' };
const GROUPED_LABELS = [
  { name: 'Bug', color: '#ef4444' },
  { name: 'Feature', color: '#3b82f6' },
];
const LOOSE_LABELS = [
  { name: 'Design', color: '#ec4899' },
  { name: 'Docs', color: '#14b8a6' },
  { name: 'Performance', color: '#f59e0b' },
];
const ESTIMATES = [1, 2, 3, 5, 8];
const FIRST_DUE_DAY = '2026-12-01';

/**
 * Adds what the 10k views need to a performance team, whatever is missing and nothing twice: six labels (one group with
 * two labels), a label on every third issue, estimates, due dates and sub-issues. Safe to run on every start.
 */
async function enrich(tx: Tx, workspaceId: string, teamId: string): Promise<void> {
  const named = async (name: string) =>
    (
      await tx
        .select({ id: label.id })
        .from(label)
        .where(and(eq(label.teamId, teamId), eq(label.name, name)))
    )[0]?.id;
  const ensure = async (
    spec: { name: string; color: string },
    extra: { isGroup?: boolean; parentId?: string } = {},
  ): Promise<string> => {
    const existing = await named(spec.name);
    if (existing) return existing;
    const [created] = await tx
      .insert(label)
      .values({ workspaceId, teamId, ...spec, ...extra })
      .returning({ id: label.id });
    if (!created) throw new Error('label insert returned no row');
    return created.id;
  };

  const group = await ensure(LABEL_GROUP, { isGroup: true });
  const usable = [
    ...(await Promise.all(GROUPED_LABELS.map((spec) => ensure(spec, { parentId: group })))),
    ...(await Promise.all(LOOSE_LABELS.map((spec) => ensure(spec)))),
  ];

  const ids = sql.join(
    usable.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  await tx.execute(sql`
    insert into issue_label (workspace_id, team_id, issue_id, label_id)
    select i.workspace_id, i.team_id, i.id, (array[${ids}])[(i.number / 3) % ${sql.raw(String(usable.length))} + 1]
      from issue i
     where i.team_id = ${teamId} and i.number % 3 = 0
    on conflict do nothing`);
  await tx.execute(sql`
    update issue set estimate = (array[${sql.raw(ESTIMATES.join(', '))}]::smallint[])[number % ${sql.raw(String(ESTIMATES.length))} + 1]
     where team_id = ${teamId} and number % 2 = 0 and estimate is null`);
  await tx.execute(sql`
    update issue set due_date = ${FIRST_DUE_DAY}::date + (number % 40)
     where team_id = ${teamId} and number % 5 = 0 and due_date is null`);
  await tx.execute(sql`
    update issue child set parent_id = parent.id
      from issue parent
     where child.team_id = ${teamId} and child.number % 50 = 0 and child.parent_id is null
       and parent.team_id = child.team_id and parent.number = child.number - 1`);
}

export async function seedPerf(
  orm: Orm,
  opts: { issues?: number; allowRemote?: boolean } = {},
): Promise<{ created: boolean; workspaceSlug: typeof PERF_WORKSPACE_SLUG }> {
  assertSeedAllowed(opts.allowRemote ?? false);
  const issues = opts.issues ?? PERF_ISSUES;
  if (!Number.isInteger(issues) || issues < 1) {
    throw new Error(`issues must be a positive integer, got ${issues}`);
  }

  return orm.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: workspace.id })
      .from(workspace)
      .where(eq(workspace.slug, PERF_WORKSPACE_SLUG))
      .limit(1);
    if (existing) {
      const [perfTeam] = await tx
        .select({ id: team.id })
        .from(team)
        .where(and(eq(team.workspaceId, existing.id), eq(team.key, 'PERF')))
        .limit(1);
      if (perfTeam) await enrich(tx, existing.id, perfTeam.id);
      return { created: false, workspaceSlug: PERF_WORKSPACE_SLUG };
    }

    const [ws] = await tx
      .insert(workspace)
      .values({ name: 'Performance', slug: PERF_WORKSPACE_SLUG })
      .returning();
    if (!ws) throw new Error('workspace insert returned no row');
    const [owner, other] = await tx
      .insert(member)
      .values([
        {
          workspaceId: ws.id,
          email: 'owner@example.test',
          name: 'Owner Example',
          handle: 'owner',
          role: 'owner' as const,
        },
        {
          workspaceId: ws.id,
          email: 'member@example.test',
          name: 'Member Example',
          handle: 'member',
          role: 'member' as const,
        },
      ])
      .returning();
    const [perf] = await tx
      .insert(team)
      .values({ workspaceId: ws.id, key: 'PERF', name: 'Performance', private: false })
      .returning();
    if (!owner || !other || !perf) throw new Error('seed insert returned no rows');
    await tx
      .insert(teamMember)
      .values([owner, other].map((m) => ({ workspaceId: ws.id, teamId: perf.id, memberId: m.id })));
    const states = await tx
      .insert(workflowState)
      .values(
        defaultWorkflowStates().map((state) => ({
          workspaceId: ws.id,
          teamId: perf.id,
          ...state,
        })),
      )
      .returning();
    const fallbackState = states[0];
    if (!fallbackState) throw new Error('workflow state insert returned no rows');

    for (let start = 0; start < issues; start += INSERT_CHUNK) {
      const count = Math.min(INSERT_CHUNK, issues - start);
      await tx.insert(issue).values(
        Array.from({ length: count }, (_, offset) => {
          const index = start + offset;
          return {
            workspaceId: ws.id,
            teamId: perf.id,
            number: index + 1,
            title: `PERF issue ${index + 1}`,
            stateId: (states[index % states.length] ?? fallbackState).id,
            priority: index % 5,
            assigneeId: index % 3 === 0 ? null : (index % 2 === 0 ? owner : other).id,
            creatorId: owner.id,
          };
        }),
      );
    }
    await tx.update(team).set({ issueCounter: issues }).where(eq(team.id, perf.id));
    await enrich(tx, ws.id, perf.id);
    return { created: true, workspaceSlug: PERF_WORKSPACE_SLUG };
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
    const result = await seedPerf(db.orm, { allowRemote: process.argv.includes('--allow-remote') });
    console.info(
      result.created
        ? `performance workspace created (${PERF_ISSUES} issues); sign in as owner@example.test`
        : 'performance workspace already exists, labels, estimates, due dates and sub-issues added where missing',
    );
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  } finally {
    await db.close();
  }
}
