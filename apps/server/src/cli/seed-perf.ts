// Performance seed: one workspace "perf" with one team holding 10,000 issues and two members, the size the sync bar
// is measured at (docs/design.md section 14). Deterministic (titles, states, priorities and assignees come from the
// issue number) and opt-in like the dev seed: it refuses to run unless the database and the app are on this machine.
// `pnpm --filter @torch/server db:seed-perf` (after `db:migrate`). Idempotent.
import { issue, member, team, teamMember, workflowState, workspace } from '@torch/shared/db/schema';
import { defaultWorkflowStates } from '@torch/shared/db/workflow-defaults';
import { eq } from 'drizzle-orm';
import { assertSeedAllowed } from '../db/seed.ts';
import { createDb, type Orm } from '../db.ts';

export const PERF_WORKSPACE_SLUG = 'perf';
export const PERF_ISSUES = 10_000;
const INSERT_CHUNK = 500;

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
    if (existing) return { created: false, workspaceSlug: PERF_WORKSPACE_SLUG };

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
        : 'performance workspace already exists, nothing changed',
    );
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  } finally {
    await db.close();
  }
}
