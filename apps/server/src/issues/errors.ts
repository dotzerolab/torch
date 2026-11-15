// The refusals of the issue API. Every answer that is not a success has the body `{ error, message, details? }`:
// `error` is a stable code a client switches on, `message` is a developer-facing English text, `details` (optional)
// carries machine-readable context such as the field that was refused. Documented once, in docs/api/issues.md.
export const ISSUE_ERROR_CODES = [
  'unauthenticated',
  'forbidden',
  'not_found',
  'invalid_input',
  'invalid_reference',
  'external_ref_exists',
  'idempotency_key_reused',
] as const;
export type IssueErrorCode = (typeof ISSUE_ERROR_CODES)[number];

export type IssueApiError = {
  code: IssueErrorCode;
  status: 400 | 401 | 403 | 404 | 409 | 413 | 422;
  message?: string;
  details?: Record<string, unknown>;
};

const MESSAGES: Record<IssueErrorCode, string> = {
  unauthenticated: 'Sign in to continue.',
  forbidden: 'You cannot do this in this team.',
  not_found: 'Not found.',
  invalid_input: 'The request is not valid.',
  invalid_reference: 'A referenced id does not exist or cannot be used here.',
  external_ref_exists: 'An issue with this external reference already exists.',
  idempotency_key_reused: 'This Idempotency-Key was already used with a different request.',
};

// Every answer is about one person's data: nothing may be kept by a browser or a proxy.
const NO_STORE = { 'Cache-Control': 'no-store' };

/** The response of a refusal: `{ error, message, details? }` with the status of the error. */
export function errorResponse(error: IssueApiError): Response {
  return Response.json(
    {
      error: error.code,
      message: error.message ?? MESSAGES[error.code],
      ...(error.details ? { details: error.details } : {}),
    },
    { status: error.status, headers: NO_STORE },
  );
}

/** Thrown inside a transaction to abort it with a refusal: the rollback takes everything the call wrote with it. */
export class IssueRefusal extends Error {
  readonly error: IssueApiError;
  constructor(error: IssueApiError) {
    super(error.code);
    this.error = error;
  }
}

export const refusal = (
  code: IssueErrorCode,
  status: IssueApiError['status'],
  extra: Pick<IssueApiError, 'message' | 'details'> = {},
): IssueRefusal => new IssueRefusal({ code, status, ...extra });

/** A referenced id (state, assignee, label, parent, subscriber) that does not exist or cannot be used here. */
export const invalidReference = (field: string): IssueRefusal =>
  refusal('invalid_reference', 422, {
    message: `${field} refers to something that does not exist or cannot be used here.`,
    details: { field },
  });
