// What an admin service function answers: a value, or a refusal with the code the client translates and the
// HTTP status the route sends. 401 is not here: the route answers it before a service is called.
import type { AdminErrorCode } from '@torch/shared/mutations/admin';

export type RefusalStatus = 400 | 403 | 404 | 409 | 429;

export type ServiceResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: AdminErrorCode; status: RefusalStatus };

export const succeed = <T>(value: T): ServiceResult<T> => ({ ok: true, value });

export const refuse = (code: AdminErrorCode, status: RefusalStatus): ServiceResult<never> => ({
  ok: false,
  code,
  status,
});
