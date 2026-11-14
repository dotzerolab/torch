// Random secrets (sign-in links, session cookies) and the one-way hash that is all the database ever stores.
import { createHash, randomBytes } from 'node:crypto';

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** 32 random bytes as base64url (43 characters). */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/** SHA-256 hex (64 characters) of a token. High-entropy secrets need no salt or slow hash. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Cheap shape check before hashing or querying: input comes from a cookie or a request body. */
export function isWellFormedToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_SHAPE.test(value);
}
