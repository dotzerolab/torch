// Value lists shared by the database schema and by code that must not pull the ORM into its bundle (the web
// validates admin inputs with these). `schema.ts` re-exports them: that is where the server imports them from.
export const MEMBER_ROLES = ['owner', 'admin', 'member', 'guest'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export const MEMBER_LOCALES = ['en', 'it'] as const;
export type MemberLocale = (typeof MEMBER_LOCALES)[number];

/** Stored once with a direction: `blocks` reads "issue blocks related issue"; "blocked by" is its inverse. */
export const ISSUE_RELATION_TYPES = ['blocks', 'related', 'duplicate'] as const;
export type IssueRelationType = (typeof ISSUE_RELATION_TYPES)[number];

/** How a change reached Torch. Derived from how the caller authenticated, never from a request header. */
export const ACTIVITY_CLIENTS = ['web', 'api', 'mcp', 'import', 'system'] as const;
export type ActivityClient = (typeof ACTIVITY_CLIENTS)[number];
