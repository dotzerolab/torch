// The one way the web talks to the server's JSON endpoints. Cookies travel with same-origin requests, and the
// browser adds the Origin header the server's CSRF guard checks on every write.

/** An answer the server refused, or `status: 0` when there was no answer at all (code `network`). */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }

  let res: Response;
  try {
    res = await fetch(path, { ...init, headers });
  } catch (cause) {
    // An aborted request is the caller's own doing: let it through unchanged.
    if (init.signal?.aborted) throw cause;
    throw new ApiError(0, 'network', 'The server could not be reached.');
  }

  const text = await res.text();
  let body: unknown;
  try {
    body = text === '' ? undefined : JSON.parse(text);
  } catch {
    body = undefined;
  }

  if (!res.ok) {
    const failure = (typeof body === 'object' && body !== null ? body : {}) as {
      error?: unknown;
      message?: unknown;
    };
    throw new ApiError(
      res.status,
      typeof failure.error === 'string' ? failure.error : 'unknown',
      typeof failure.message === 'string' ? failure.message : res.statusText,
    );
  }
  return body as T;
}
