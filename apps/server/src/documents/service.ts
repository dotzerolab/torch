// Team documents (spec section 6): a title and a Markdown body that belong to a team, with their revisions. One function
// per write, shared by REST today and by MCP and the public API later; the HTTP routes are thin wrappers. Every write is
// ONE transaction: the actor is re-read as the database says now, the document row is locked (so a read-change-write
// never loses a concurrent edit), the change, the revision and the transaction id for the client.
//
// Rules: whoever can see the team reads its documents; anybody but a guest who can see the team creates, edits and
// archives them (a guest who sees the team gets 403, a person who cannot see it gets 404, never 403). Edits are
// last-writer-wins; the previous title and body of a changed document go to `document_revision`, newest 50 kept. An
// archived document stays readable and is read-only until it is unarchived (409 `document_archived`).
import { type DocumentRow, document, documentRevision, team } from '@torch/shared/db/schema';
import {
  type DocumentCreateInput,
  type DocumentUpdateInput,
  documentCreateInput,
  documentUpdateInput,
} from '@torch/shared/mutations/document';
import {
  canEditDocuments,
  canReadDocuments,
  canSeeTeam,
  type TeamAccess,
} from '@torch/shared/permissions';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Orm, Tx } from '../db.ts';
import { type IssueApiError, IssueRefusal, refusal } from '../issues/errors.ts';
import type { ChangeResult } from '../issues/join-changes.ts';
import { type Failure, refuse } from '../issues/update-issue.ts';
import { claimIdempotency, requestHashOf, storeIdempotent } from '../mutations/idempotency.ts';
import { currentTxid } from '../mutations/txid.ts';
import { currentActor } from '../permissions/current-actor.ts';
import type { ClientActor } from '../permissions/load-actor.ts';
import { isUuid } from '../util/uuid.ts';

export type DocumentDto = {
  id: string;
  teamId: string;
  title: string;
  /** Present on a single document, absent from a list: bodies never ride a list. */
  body?: string;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};
export type RevisionDto = {
  id: string;
  title: string;
  body: string;
  editedBy: string;
  createdAt: string;
};

export type DocumentResult<T> = ChangeResult<T>;
/** A read: the value, or the refusal. There is no transaction id to wait for. */
export type DocumentReadResult<T> = { ok: true; value: T } | Failure;
export type CreateDocumentResult =
  | { ok: true; txid: number; value: DocumentDto; replayed: boolean }
  | Failure;

/** How many revisions a document keeps: the newest ones. */
export const MAX_REVISIONS = 50;

function toDto(row: DocumentRow, withBody: boolean): DocumentDto {
  return {
    id: row.id,
    teamId: row.teamId,
    title: row.title,
    ...(withBody ? { body: row.body } : {}),
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    archivedAt: row.archivedAt?.toISOString() ?? null,
  };
}

const failureOf = (error: IssueApiError): Failure => ({ ok: false, ...error });

function invalidInput(error: {
  issues: readonly { path: readonly PropertyKey[]; message: string }[];
}): Failure {
  const first = error.issues[0];
  const where = first?.path.length ? `${first.path.join('.')}: ` : '';
  return refuse('invalid_input', 400, { message: `${where}${first?.message ?? ''}` });
}

async function teamAccess(
  db: Orm | Tx,
  workspaceId: string,
  teamId: string,
): Promise<TeamAccess | null> {
  const [row] = await db
    .select({ id: team.id, private: team.private })
    .from(team)
    .where(and(eq(team.workspaceId, workspaceId), eq(team.id, teamId)));
  return row ? { id: row.id, workspaceId, private: row.private } : null;
}

/**
 * One transaction on an existing document: the actor as the database says now, the document row locked, the team
 * checked (404 when invisible), then `run`. A refusal is thrown inside, so the rollback takes everything with it.
 */
async function writeOnDocument<T>(
  orm: Orm,
  requested: ClientActor,
  documentId: string,
  run: (context: {
    tx: Tx;
    actor: ClientActor;
    access: TeamAccess;
    row: DocumentRow;
  }) => Promise<T>,
): Promise<DocumentResult<T>> {
  if (!isUuid(documentId)) return refuse('not_found', 404);
  try {
    return await orm.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(document)
        .where(and(eq(document.workspaceId, requested.workspaceId), eq(document.id, documentId)))
        .for('no key update');
      if (!row) throw refusal('not_found', 404);
      const fresh = await currentActor(tx, requested);
      if (!fresh) throw refusal('unauthenticated', 401);
      const actor: ClientActor = { ...fresh, client: requested.client };
      const access = await teamAccess(tx, actor.workspaceId, row.teamId);
      if (!access || !canSeeTeam(actor, access)) throw refusal('not_found', 404);
      const value = await run({ tx, actor, access, row });
      return { ok: true as const, txid: await currentTxid(tx), value };
    });
  } catch (error) {
    if (error instanceof IssueRefusal) return failureOf(error.error);
    throw error;
  }
}

/**
 * Creates a document in a team. `idempotencyKey` (the `Idempotency-Key` header) makes a retry safe: the same person,
 * key and content get the stored answer again and write nothing; the same key with other content is 422.
 */
export async function createDocument(
  orm: Orm,
  requested: ClientActor,
  input: DocumentCreateInput,
  opts: { idempotencyKey?: string } = {},
): Promise<CreateDocumentResult> {
  const parsed = documentCreateInput.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error);
  const data = parsed.data;
  const key = opts.idempotencyKey;

  try {
    return await orm.transaction(async (tx) => {
      if (key !== undefined) {
        const claim = await claimIdempotency(
          tx,
          requested,
          key,
          requestHashOf({ op: 'document.create', ...data, body: data.body ?? '' }),
        );
        if ('replay' in claim) return replayOf(tx, requested, claim.replay.response);
      }

      const fresh = await currentActor(tx, requested);
      if (!fresh) throw refusal('unauthenticated', 401);
      const actor: ClientActor = { ...fresh, client: requested.client };
      const access = await teamAccess(tx, actor.workspaceId, data.teamId);
      if (!access || !canSeeTeam(actor, access)) throw refusal('not_found', 404);
      if (!canEditDocuments(actor, access)) throw refusal('forbidden', 403);

      const [created] = await tx
        .insert(document)
        .values({
          workspaceId: actor.workspaceId,
          teamId: data.teamId,
          title: data.title,
          body: data.body ?? '',
          createdBy: actor.memberId,
          updatedBy: actor.memberId,
          createdAt: sql`clock_timestamp()`,
          updatedAt: sql`clock_timestamp()`,
        })
        .returning();
      if (!created) throw new Error('document insert returned no row');
      const txid = await currentTxid(tx);
      if (key !== undefined) {
        await storeIdempotent(tx, requested, key, 201, { documentId: created.id, txid });
      }
      return { ok: true as const, txid, value: toDto(created, true), replayed: false };
    });
  } catch (error) {
    if (error instanceof IssueRefusal) return failureOf(error.error);
    throw error;
  }
}

/** The answer of a replayed create: the document as it is now, if the person still sees its team. */
async function replayOf(
  tx: Tx,
  requested: ClientActor,
  stored: unknown,
): Promise<CreateDocumentResult> {
  const { documentId, txid } = (stored ?? {}) as { documentId?: unknown; txid?: unknown };
  if (typeof documentId !== 'string' || typeof txid !== 'number') throw refusal('not_found', 404);
  const fresh = await currentActor(tx, requested);
  if (!fresh) throw refusal('unauthenticated', 401);
  const [row] = await tx
    .select()
    .from(document)
    .where(and(eq(document.workspaceId, fresh.workspaceId), eq(document.id, documentId)));
  const access = row && (await teamAccess(tx, fresh.workspaceId, row.teamId));
  if (!row || !access || !canSeeTeam(fresh, access)) throw refusal('not_found', 404);
  return { ok: true, txid, value: toDto(row, true), replayed: true };
}

/** Changes the title and/or the body. The previous title and body become a revision, only when something changed. */
export async function updateDocument(
  orm: Orm,
  requested: ClientActor,
  documentId: string,
  input: DocumentUpdateInput,
): Promise<DocumentResult<null>> {
  const parsed = documentUpdateInput.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error);
  const changes = parsed.data;

  return writeOnDocument(orm, requested, documentId, async ({ tx, actor, access, row }) => {
    if (!canEditDocuments(actor, access)) throw refusal('forbidden', 403);
    if (row.archivedAt) throw refusal('document_archived', 409);
    const title = changes.title ?? row.title;
    const body = changes.body ?? row.body;
    if (title === row.title && body === row.body) return null;

    await tx.insert(documentRevision).values({
      workspaceId: row.workspaceId,
      teamId: row.teamId,
      documentId: row.id,
      title: row.title,
      body: row.body,
      editedBy: actor.memberId,
      createdAt: sql`clock_timestamp()`,
    });
    await tx
      .update(document)
      .set({ title, body, updatedBy: actor.memberId, updatedAt: sql`clock_timestamp()` })
      .where(and(eq(document.workspaceId, row.workspaceId), eq(document.id, row.id)));
    // Keep the newest revisions only.
    await tx.delete(documentRevision).where(
      and(
        eq(documentRevision.workspaceId, row.workspaceId),
        eq(documentRevision.documentId, row.id),
        sql`${documentRevision.id} not in (
          select id from document_revision
          where workspace_id = ${row.workspaceId} and document_id = ${row.id}
          order by created_at desc, id desc
          limit ${MAX_REVISIONS})`,
      ),
    );
    return null;
  });
}

/** Archives or unarchives a document. Doing either twice changes nothing. */
export async function archiveDocument(
  orm: Orm,
  requested: ClientActor,
  documentId: string,
  archived: boolean,
): Promise<DocumentResult<null>> {
  return writeOnDocument(orm, requested, documentId, async ({ tx, actor, access, row }) => {
    if (!canEditDocuments(actor, access)) throw refusal('forbidden', 403);
    if ((row.archivedAt !== null) === archived) return null;
    await tx
      .update(document)
      .set({ archivedAt: archived ? sql`clock_timestamp()` : null })
      .where(and(eq(document.workspaceId, row.workspaceId), eq(document.id, row.id)));
    return null;
  });
}

/** The documents of a team without their bodies, the most recently edited first. 404 for a team the actor cannot see. */
export async function listDocuments(
  orm: Orm,
  actor: ClientActor,
  teamId: string,
  opts: { includeArchived: boolean },
): Promise<DocumentReadResult<DocumentDto[]>> {
  if (!isUuid(teamId)) return refuse('not_found', 404);
  const access = await teamAccess(orm, actor.workspaceId, teamId);
  if (!access || !canSeeTeam(actor, access) || !canReadDocuments(actor, access)) {
    return refuse('not_found', 404);
  }
  const rows = await orm
    .select({
      id: document.id,
      workspaceId: document.workspaceId,
      teamId: document.teamId,
      title: document.title,
      createdBy: document.createdBy,
      updatedBy: document.updatedBy,
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
      archivedAt: document.archivedAt,
    })
    .from(document)
    .where(
      and(
        eq(document.workspaceId, actor.workspaceId),
        eq(document.teamId, teamId),
        opts.includeArchived ? undefined : isNull(document.archivedAt),
      ),
    )
    .orderBy(desc(document.updatedAt), desc(document.id));
  return { ok: true, value: rows.map((row) => toDto({ ...row, body: '' }, false)) };
}

async function readableDocument(
  orm: Orm,
  actor: ClientActor,
  documentId: string,
): Promise<DocumentRow | null> {
  if (!isUuid(documentId)) return null;
  const [row] = await orm
    .select()
    .from(document)
    .where(and(eq(document.workspaceId, actor.workspaceId), eq(document.id, documentId)));
  if (!row) return null;
  const access = await teamAccess(orm, actor.workspaceId, row.teamId);
  return access && canSeeTeam(actor, access) && canReadDocuments(actor, access) ? row : null;
}

/** One document with its body. */
export async function getDocument(
  orm: Orm,
  actor: ClientActor,
  documentId: string,
): Promise<DocumentReadResult<DocumentDto>> {
  const row = await readableDocument(orm, actor, documentId);
  return row ? { ok: true, value: toDto(row, true) } : refuse('not_found', 404);
}

/** The earlier versions of a document, newest first, at most 50. */
export async function listRevisions(
  orm: Orm,
  actor: ClientActor,
  documentId: string,
): Promise<DocumentReadResult<RevisionDto[]>> {
  const row = await readableDocument(orm, actor, documentId);
  if (!row) return refuse('not_found', 404);
  const rows = await orm
    .select()
    .from(documentRevision)
    .where(
      and(
        eq(documentRevision.workspaceId, actor.workspaceId),
        eq(documentRevision.documentId, row.id),
      ),
    )
    .orderBy(desc(documentRevision.createdAt), desc(documentRevision.id))
    .limit(MAX_REVISIONS);
  return {
    ok: true,
    value: rows.map((rev) => ({
      id: rev.id,
      title: rev.title,
      body: rev.body,
      editedBy: rev.editedBy,
      createdAt: rev.createdAt.toISOString(),
    })),
  };
}
