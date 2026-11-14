// Constructors for the answers of the admin services (the type itself is `ServiceResult`, in result.ts).
import type { AdminErrorCode } from '@torch/shared/mutations/admin';
import type { ServiceResult } from './result.ts';

export type RefusalStatus = 400 | 403 | 404 | 409 | 429;

export const succeed = <T>(value: T): ServiceResult<T> => ({ ok: true, value });

export const refuse = (code: AdminErrorCode, status: RefusalStatus): ServiceResult<never> => ({
  ok: false,
  code,
  status,
});
