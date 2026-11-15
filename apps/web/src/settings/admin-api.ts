// The admin calls the settings screens make: one function per server route, typed with what it answers.
// Writes answer `{ txid }` when the change reaches a synced table; the caller waits for it (`awaitSynced`).
import type { InviteCreateInput, ProfileUpdateInput } from '@torch/shared/mutations/admin';
import type { Role } from '@torch/shared/permissions';
import { apiFetch } from '../api.ts';

/** A row of `GET /members` (owners and admins only): the synced profile plus the email. */
export type AdminMember = {
  id: string;
  name: string;
  handle: string;
  role: Role;
  email: string;
  locale: 'en' | 'it';
  deactivatedAt: string | null;
  createdAt: string;
};

export type AdminInvite = {
  id: string;
  email: string;
  role: Role;
  teamIds: string[];
  invitedBy: string;
  createdAt: string;
  expiresAt: string;
};

/** A private team in the management directory: name and size, never its people or issues. */
export type DirectoryTeam = {
  id: string;
  key: string;
  name: string;
  memberCount: number;
  isMember: boolean;
};

export type InvitePreview = {
  workspaceName: string;
  email: string;
  role: Role;
  teams: { key: string; name: string }[];
};

const base = (workspaceId: string) => `/api/w/${workspaceId}`;
const send = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

export const adminApi = {
  members: (ws: string) => apiFetch<{ members: AdminMember[] }>(`${base(ws)}/members`),
  changeRole: (ws: string, memberId: string, role: Role) =>
    apiFetch<{ txid: number }>(`${base(ws)}/members/${memberId}`, send('PATCH', { role })),
  setActive: (ws: string, memberId: string, active: boolean) =>
    apiFetch<{ txid: number }>(
      `${base(ws)}/members/${memberId}/${active ? 'reactivate' : 'deactivate'}`,
      send('POST'),
    ),
  updateProfile: (ws: string, patch: ProfileUpdateInput) =>
    apiFetch<{ txid: number }>(`${base(ws)}/me`, send('PATCH', patch)),

  invites: (ws: string) => apiFetch<{ invites: AdminInvite[] }>(`${base(ws)}/invites`),
  createInvite: (ws: string, input: InviteCreateInput) =>
    apiFetch<{ inviteId: string }>(`${base(ws)}/invites`, send('POST', input)),
  resendInvite: (ws: string, inviteId: string) =>
    apiFetch<{ status: 'sent' }>(`${base(ws)}/invites/${inviteId}/resend`, send('POST')),
  revokeInvite: (ws: string, inviteId: string) =>
    apiFetch<{ txid: number }>(`${base(ws)}/invites/${inviteId}`, send('DELETE')),

  createTeam: (ws: string, input: { key: string; name: string; private?: boolean }) =>
    apiFetch<{ teamId: string; txid: number }>(`${base(ws)}/teams`, send('POST', input)),
  updateTeam: (ws: string, teamId: string, patch: { name?: string; private?: boolean }) =>
    apiFetch<{ txid: number }>(`${base(ws)}/teams/${teamId}`, send('PATCH', patch)),
  addTeamMember: (ws: string, teamId: string, memberId: string) =>
    apiFetch<{ txid: number }>(`${base(ws)}/teams/${teamId}/members`, send('POST', { memberId })),
  removeTeamMember: (ws: string, teamId: string, memberId: string) =>
    apiFetch<{ txid: number }>(`${base(ws)}/teams/${teamId}/members/${memberId}`, send('DELETE')),
  privateTeams: (ws: string) => apiFetch<{ teams: DirectoryTeam[] }>(`${base(ws)}/admin/teams`),

  // The two calls of the invitation page: the link holder is not signed in, so no workspace in the path.
  previewInvite: (token: string) =>
    apiFetch<InvitePreview>('/api/invites/preview', send('POST', { token })),
  acceptInvite: (token: string, name: string) =>
    apiFetch<{ workspaces: unknown[] }>('/api/invites/accept', send('POST', { token, name })),
};
