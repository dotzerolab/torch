// Value lists shared by the database schema and by code that must not pull the ORM into its bundle (the web
// validates admin inputs with these). `schema.ts` re-exports them: that is where the server imports them from.
export const MEMBER_ROLES = ['owner', 'admin', 'member', 'guest'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export const MEMBER_LOCALES = ['en', 'it'] as const;
export type MemberLocale = (typeof MEMBER_LOCALES)[number];
