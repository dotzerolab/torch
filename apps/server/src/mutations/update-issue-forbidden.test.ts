// In P0d `canEditIssues` equals `canSeeTeam`, so "can see but may not edit" cannot be built from fixtures yet.
// P1 refines the rule; this file pins what the mutation does once it does: 403 forbidden, nothing written.
import { issue } from '@torch/shared/db/schema';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { loadActor } from '../permissions/load-actor.ts';
import { createWorkspaceFixture, withTempDatabase } from '../test/fixtures.ts';
import { updateIssue } from './update-issue.ts';

vi.mock('@torch/shared/permissions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@torch/shared/permissions')>()),
  canEditIssues: () => false,
}));

describe.skipIf(!process.env.DATABASE_URL)(
  'updateIssue when the actor may see but not edit',
  () => {
    it('-> 403 forbidden and the issue is untouched', async () => {
      await withTempDatabase(async (db) => {
        const f = await createWorkspaceFixture(db.orm);
        const target = f.issues.eng[0];
        if (!target) throw new Error('fixture has no issue');
        const actor = await loadActor(db.orm, f.workspaceId, f.members.guest.id);
        if (!actor) throw new Error('no actor');

        const result = await updateIssue(db.orm, actor, target.id, { title: 'nope' });

        expect(result).toEqual({ ok: false, code: 'forbidden', status: 403 });
        const [after] = await db.orm.select().from(issue).where(eq(issue.id, target.id));
        expect(after?.title).toBe(target.title);
      });
    });

    it('an invisible team is still 404, not 403 (no existence signal)', async () => {
      await withTempDatabase(async (db) => {
        const f = await createWorkspaceFixture(db.orm);
        const opsIssue = f.issues.ops[0];
        if (!opsIssue) throw new Error('fixture has no issue');
        const actor = await loadActor(db.orm, f.workspaceId, f.members.guest.id);
        if (!actor) throw new Error('no actor');

        const result = await updateIssue(db.orm, actor, opsIssue.id, { title: 'nope' });

        expect(result).toEqual({ ok: false, code: 'not_found', status: 404 });
      });
    });
  },
);
