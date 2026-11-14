// The answer of a service function: a value, or the refusal that the HTTP layer turns into a status and an error code.
import type { AdminErrorCode } from '@torch/shared/mutations/admin';

export type ServiceResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: AdminErrorCode; status: 400 | 403 | 404 | 409 | 429 };
