// Does the start of a stored file look like the type it was declared as? A cheap check on the first bytes, run when an
// upload is completed: a file named `.png` that is really HTML is refused before anybody can open it. Binary types are
// matched against the signatures of the shared allowlist; text types have none and only must not contain a NUL byte.
import { ATTACHMENT_TYPES } from '@torch/shared/mutations/attachment';

export function sniffMatches(contentType: string, head: Uint8Array): boolean {
  const type = contentType.trim().toLowerCase();
  if (!Object.hasOwn(ATTACHMENT_TYPES, type)) return false;
  const spec = ATTACHMENT_TYPES[type];
  if (!spec) return false;
  if (head.length === 0) return false;

  if (!spec.signature) return !head.includes(0);

  return spec.signature.some(
    (pattern) =>
      head.length >= pattern.length &&
      pattern.every((byte, index) => byte === null || head[index] === byte),
  );
}
