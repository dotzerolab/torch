// The issue list (spec section 6): `updatedAfter` polling in a stable order, an external reference lookup and opaque
// cursors. Order is `(updated_at, id)` ascending, so an issue that changes between two pages is seen again, never skipped
// or repeated within a walk that follows `updated_at`. Only teams the actor can see are listed.
import { externalRef, type IssueRow, issue, issueLabel, team } from '@torch/shared/db/schema';
import { canSeeTeam } from '@torch/shared/permissions';
import { and, asc, eq, inArray, isNull, type SQL, sql } from 'drizzle-orm';
import type { Orm, Tx } from '../db.ts';
import { currentActor } from '../permissions/current-actor.ts';
import type { ClientActor } from '../permissions/load-actor.ts';
import { isUuid } from '../util/uuid.ts';
import { type ExternalRefDto, type IssueDto, toIssueDto } from './dto.ts';
import { type Failure, refuse } from './update-issue.ts';

export type ListIssuesOptions = {
  teamId?: string;
  updatedAfter?: string;
  /** `<source>:<id>`: at most one issue. */
  externalRef?: string;
  includeArchived?: boolean;
  includeDescription?: boolean;
  limit?: number;
  cursor?: string;
};
export type ListIssuesResult =
  | { ok: true; value: { issues: IssueDto[]; nextCursor: string | null } }
  | Failure;

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;

// Microsecond text of `updated_at`, so a cursor never rounds a row away (a JavaScript Date keeps milliseconds only).
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const encodeCursor = (stamp: string, id: string) =>
  Buffer.from(`${stamp}|${id}`, 'utf8').toString('base64url');

function decodeCursor(cursor: string): { stamp: string; id: string } | null {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) return null;
  const [stamp, id, extra] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (extra !== undefined || !stamp || !id || !STAMP.test(stamp) || !isUuid(id)) return null;
  return { stamp, id };
}

const invalid = (message: string) => refuse('invalid_input', 400, { message });

export const listIssues = (
  orm: Orm,
  requested: ClientActor,
  options: ListIssuesOptions = {},
): Promise<ListIssuesResult> => orm.transaction((tx) => run(tx, requested, options));

async function run(
  orm: Tx,
  requested: ClientActor,
  options: ListIssuesOptions,
): Promise<ListIssuesResult> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return invalid(`limit must be an integer from 1 to ${MAX_LIMIT}.`);
  }
  let after: Date | undefined;
  if (options.updatedAfter !== undefined) {
    after = new Date(options.updatedAfter);
    if (Number.isNaN(after.getTime()))
      return invalid('updatedAfter must be an ISO 8601 date-time.');
  }
  const cursor = options.cursor === undefined ? undefined : decodeCursor(options.cursor);
  if (options.cursor !== undefined && !cursor) return invalid('cursor is not valid.');
  let ref: { source: string; id: string } | undefined;
  if (options.externalRef !== undefined) {
    const at = options.externalRef.indexOf(':');
    if (at < 1 || at === options.externalRef.length - 1) {
      return invalid('externalRef must be <source>:<id>.');
    }
    ref = { source: options.externalRef.slice(0, at), id: options.externalRef.slice(at + 1) };
  }
  if (options.teamId !== undefined && !isUuid(options.teamId)) return refuse('not_found', 404);

  const actor = await currentActor(orm, requested);
  if (!actor) return refuse('unauthenticated', 401);
  const teams = await orm
    .select({ id: team.id, workspaceId: team.workspaceId, private: team.private, key: team.key })
    .from(team)
    .where(eq(team.workspaceId, actor.workspaceId));
  const visible = teams.filter((access) => canSeeTeam(actor, access));
  let scope = visible;
  if (options.teamId !== undefined) {
    scope = visible.filter((access) => access.id === options.teamId);
    if (scope.length === 0) return refuse('not_found', 404);
  }
  if (scope.length === 0) return { ok: true, value: { issues: [], nextCursor: null } };
  const keyOf = new Map(scope.map((access) => [access.id, access.key]));

  const conditions: (SQL | undefined)[] = [
    eq(issue.workspaceId, actor.workspaceId),
    inArray(issue.teamId, [...keyOf.keys()]),
    options.includeArchived ? undefined : isNull(issue.archivedAt),
    after ? sql`${issue.updatedAt} > ${after.toISOString()}::timestamptz` : undefined,
    cursor
      ? sql`(${issue.updatedAt}, ${issue.id}) > (${cursor.stamp}::timestamptz, ${cursor.id}::uuid)`
      : undefined,
    ref
      ? sql`${issue.id} in (select ${externalRef.subjectId} from ${externalRef} where ${externalRef.workspaceId} = ${actor.workspaceId} and ${externalRef.subjectType} = 'issue' and ${externalRef.source} = ${ref.source} and ${externalRef.externalId} = ${ref.id})`
      : undefined,
  ];
  const rows = await orm
    .select({
      row: issue,
      stamp: sql<string>`to_char(${issue.updatedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    })
    .from(issue)
    .where(and(...conditions))
    .orderBy(asc(issue.updatedAt), asc(issue.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const nextCursor = rows.length > limit && last ? encodeCursor(last.stamp, last.row.id) : null;
  const ids = page.map((entry) => entry.row.id);
  const labelIds = new Map<string, string[]>();
  const refs = new Map<string, ExternalRefDto[]>();
  if (ids.length > 0) {
    for (const entry of await orm
      .select({ issueId: issueLabel.issueId, labelId: issueLabel.labelId })
      .from(issueLabel)
      .where(inArray(issueLabel.issueId, ids))) {
      labelIds.set(entry.issueId, [...(labelIds.get(entry.issueId) ?? []), entry.labelId]);
    }
    for (const entry of await orm
      .select()
      .from(externalRef)
      .where(and(eq(externalRef.subjectType, 'issue'), inArray(externalRef.subjectId, ids)))) {
      refs.set(entry.subjectId, [
        ...(refs.get(entry.subjectId) ?? []),
        { source: entry.source, id: entry.externalId, url: entry.url },
      ]);
    }
  }
  const issues = page.map(({ row }: { row: IssueRow }) =>
    toIssueDto(row, {
      teamKey: keyOf.get(row.teamId) ?? '',
      labelIds: labelIds.get(row.id) ?? [],
      externalRefs: refs.get(row.id) ?? [],
      includeDescription: options.includeDescription === true,
    }),
  );
  return { ok: true, value: { issues, nextCursor } };
}
