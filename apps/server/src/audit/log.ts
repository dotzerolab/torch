// The audit log write. Call it with the `tx` of the action it records, so both commit or roll back together.
import {
  AUDIT_ACTIONS,
  AUDIT_TARGET_TYPES,
  type AuditAction,
  type AuditTargetType,
  auditLog,
} from '@torch/shared/db/schema';
import type { Tx } from '../db.ts';

export type AuditMetadata = Record<string, string | number | boolean | null>;

export type AuditEntry = {
  workspaceId: string;
  /** The member who acted; null for a system action. */
  actorMemberId: string | null;
  action: AuditAction;
  targetType: AuditTargetType;
  targetId?: string;
  metadata?: AuditMetadata;
};

/** Longest metadata string: room for an id or a role, too short for a typed sentence or an email. */
const MAX_METADATA_STRING = 64;

/**
 * Metadata is ids, roles and counts: scalars only, finite numbers, short strings. Anything else (an object, an
 * array, undefined, free text) throws, so a careless caller cannot put personal data in the log.
 */
export function assertScalarMetadata(metadata: AuditMetadata): void {
  for (const [key, value] of Object.entries(metadata)) {
    const ok =
      value === null ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value)) ||
      (typeof value === 'string' && value.length <= MAX_METADATA_STRING);
    if (!ok)
      throw new Error(
        `audit metadata "${key}" must be a boolean, a number, null or a short string`,
      );
  }
}

export async function recordAudit(tx: Tx, entry: AuditEntry): Promise<void> {
  const metadata = entry.metadata ?? {};
  assertScalarMetadata(metadata);
  if (!AUDIT_ACTIONS.includes(entry.action)) throw new Error('unknown audit action');
  if (!AUDIT_TARGET_TYPES.includes(entry.targetType)) throw new Error('unknown audit target type');

  await tx.insert(auditLog).values({
    workspaceId: entry.workspaceId,
    actorMemberId: entry.actorMemberId,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId ?? null,
    metadata,
  });
}
