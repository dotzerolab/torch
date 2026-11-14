// Postgres errors reach the code wrapped (Drizzle keeps the driver error as `cause`). Services read the SQLSTATE
// and the constraint name to turn a unique violation into an answer; they never forward the message, which holds
// the SQL and its parameters.

export type DatabaseErrorInfo = { code?: string; constraint?: string };

/** SQLSTATE and constraint name of a database error, looking through up to five levels of `cause`. */
export function databaseErrorInfo(error: unknown): DatabaseErrorInfo {
  const info: DatabaseErrorInfo = {};
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    const { code, constraint } = current as { code?: unknown; constraint?: unknown };
    if (info.code === undefined && typeof code === 'string') info.code = code;
    if (info.constraint === undefined && typeof constraint === 'string')
      info.constraint = constraint;
    current = current.cause;
  }
  return info;
}

/** True for a unique violation (23505) of the named constraint or unique index. */
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  const info = databaseErrorInfo(error);
  return info.code === '23505' && info.constraint === constraint;
}
