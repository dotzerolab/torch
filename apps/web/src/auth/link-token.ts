// The sign-in token rides in the URL fragment (`/auth/verify#token=...`): a browser never sends a fragment to a
// server, so the token stays out of access logs, proxy logs and the Referer header.

// Shape only, loose on purpose (the server owns the real format): enough to never send anything odd along.
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{1,128}$/;

/** The token in a `location.hash` value, or null when there is none or it cannot be one. A query string never counts. */
export function readLinkToken(hash: string): string | null {
  if (!hash.startsWith('#')) return null;
  const value = new URLSearchParams(hash.slice(1)).get('token');
  return value !== null && TOKEN_SHAPE.test(value) ? value : null;
}
