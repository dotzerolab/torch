# Roles and permissions

Every person in a workspace has one role: owner, admin, member or guest. This page says what each role can do, how
public and private teams and guests work, who can see email addresses, what the audit log keeps, and how the server
answers when something is refused. The rules live in one module, `packages/shared/src/permissions.ts`. The server
decides with it on every request; the web app only uses it to hide what the server would refuse anyway.

## Roles

| Role   | Can do                                                                                                                                                                                  |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner  | Everything an admin can, plus granting and removing the admin and owner roles.                                                                                                          |
| Admin  | Invite people, deactivate and reactivate members and guests, move people between member and guest, create and edit teams, and manage the people of the teams they can see.              |
| Member | Work in every team they can see: read and edit its issues. Edit their own profile.                                                                                                      |
| Guest  | Work only in the teams they belong to. See only the people who share a team with them.                                                                                                  |

Everybody edits their own profile: name, handle, language and time zone. Nothing else about a person is a profile
field.

Three rules hold for every role:

- **Nobody changes their own role or deactivates themselves.** Ask another owner or admin.
- **A workspace always has at least one active owner.** Demoting or deactivating the last one is refused.
- **An admin can never create, keep or remove an admin or an owner, by any route.** That covers a role change, an
  invitation and a reactivation. An admin can deactivate, reactivate and change the role of members and guests, and
  invite members and guests; only an owner does any of this for an admin or an owner.

## What each role can do

| Action                                                          | Owner | Admin | Member | Guest |
| --------------------------------------------------------------- | :---: | :---: | :----: | :---: |
| See and edit issues of the teams they can see                   |  yes  |  yes  |  yes   |  yes  |
| Create issues; add or remove relations and links; subscribe     |  yes  |  yes  |  yes   |  yes  |
| Add or remove another person as a subscriber                    |  yes  |  yes  |  yes   |  yes  |
| Read the labels and workflow states of the teams they can see   |  yes  |  yes  |  yes   |  yes  |
| Create, edit and archive labels of a team they can see          |  yes  |  yes  |  yes   |  no   |
| Create, edit and archive labels of the workspace                |  yes  |  yes  |   no   |  no   |
| Create, edit and archive workflow states of a team they can see |  yes  |  yes  |   no   |  no   |
| Edit their own profile                                          |  yes  |  yes  |  yes   |  yes  |
| See the list of people with their email addresses               |  yes  |  yes  |   no   |  no   |
| Invite, resend and revoke invitations (member and guest roles)  |  yes  |  yes  |   no   |  no   |
| Invite, resend and revoke invitations (admin and owner roles)   |  yes  |  no   |   no   |  no   |
| Deactivate and reactivate members and guests                    |  yes  |  yes  |   no   |  no   |
| Deactivate and reactivate admins and owners                     |  yes  |  no   |   no   |  no   |
| Change a role between member and guest                          |  yes  |  yes  |   no   |  no   |
| Grant or remove the admin and owner roles                       |  yes  |  no   |   no   |  no   |
| Create teams                                                    |  yes  |  yes  |   no   |  no   |
| Rename teams, make them public or private, manage their people  |  yes  |  yes  |   no   |  no   |
| List the private teams of the workspace (name, key, head count) |  yes  |  yes  |   no   |  no   |
| Add themselves to any team, a private one included              |  yes  |  yes  |   no   |  no   |

"Teams they can see" is explained next; managing a team (rename, privacy, people) needs a team the admin or owner can
see, with one exception: joining it themselves.

Issue rules in short, all inside the teams a person can see (a team they cannot see answers 404, never 403):

- Anybody who can see a team creates and edits its issues, archives and unarchives them, and manages their relations,
  links and subscribers. Everybody manages their own subscription; adding or removing someone else needs the right to
  edit the issue, and the person added must be able to open it. An archived issue is read-only until unarchived.
- A relation or a sub-issue parent may point at an issue of another team only if the person can see that team. The
  relations a team syncs hold ids, never the title or number of an issue in a team the person cannot see, and not the
  team ids of either end. The related id of an issue in a hidden team is still visible, as an id alone.
- Labels of a team: anybody but a guest who can see the team defines, edits and archives them. Labels of the workspace
  and the workflow states of a team: owners and admins. Guests read all of them.
- Nothing is deleted. Issues, labels and workflow states are archived; see the [issue API](api/issues.md).

## Teams: public and private

- **A public team** is visible to every owner, admin and member of the workspace. A guest sees it only when they are
  in it.
- **A private team** is visible only to its members, whatever their role. An owner or admin who is not in it does not
  see its issues or its people. They find it in the management directory (`GET /api/w/:workspaceId/admin/teams`),
  which lists only the key, the name, the number of people and whether they are in it. From there an owner or admin
  can add themselves, which is recorded in the audit log; once they are in, the team is as visible to them as to any
  other member. This is the only way into a private team that is not a plain invitation by one of its members, and it
  exists so that a private team can never be lost for good.
- A private team always keeps at least one member: the last one cannot be removed, and a team cannot be made private
  while it has nobody in it.
- The person who creates a team is its first member. A new team starts with six workflow states. A team key (such as
  `ENG`) is part of every issue identifier and never changes.
- Anyone who can see a team can edit its issues.

## Guests

A guest is an outside person (a client, a contractor) who works in one or two teams:

- They see only the teams they belong to. A public team they are not in does not exist for them.
- They see themselves and the people who share a team with them, nobody else.
- They never see email addresses.
- A guest invitation must name at least one team, because a guest without a team could see nothing.

## Who sees email addresses

Owners and admins, in the member list and the invitation list, and nobody else. The member profile that syncs to
every device never carries an email address or a time zone, so a member or guest cannot read one even by looking at
the data their own device holds.

## Invitations

- An invitation carries a role and, optionally, teams. The link works for seven days; resending gives a new link and a
  fresh seven days, and the old link stops working at once. Revoking stops it immediately.
- To invite into a team you must be able to manage that team's people, so an admin cannot invite into a private team
  they are not in.
- An invitation to the address of a deactivated person brings them back with the invited role. That is a
  reactivation, so it follows the reactivation rule: an admin cannot do it for a deactivated admin or owner.
- If the person who sent an invitation is deactivated or loses the right to hand out that role before it is accepted,
  the link stops working.
- Each person may send 30 invitations per hour, and a workspace holds at most 200 pending ones.

## The audit log

Every administrative action writes one audit entry in the same database transaction as the action itself, so an
action and its entry either both happen or neither does. Entries are recorded for:

- members: role changed, deactivated, reactivated, profile updated;
- invitations: created, resent, revoked, accepted;
- teams: created, updated, person added, person removed, owner or admin joined, team emptied (a private team left
  with nobody in it).

An entry holds the workspace id, the id of the person who acted (empty for a system action), the action, the kind and
id of the thing it was done to, the time, and a small set of details made only of ids, roles, counts and yes/no flags:
for example the old and new role, a team id, the number of teams of an invitation, or the names of the profile fields
that changed. It never holds an email address, a token, a link or any text a user typed: the code refuses to
write an entry whose details are anything but short values (text of at most 64 characters, numbers, yes/no flags).

## How the server answers

| Status | Meaning                                                                                              |
| ------ | ---------------------------------------------------------------------------------------------------- |
| 401    | Not signed in, a session of another workspace, an expired session or a deactivated person.            |
| 403    | Signed in but not allowed to do this, for something the person can see. The body says `forbidden`.   |
| 404    | The id does not exist in your workspace, or exists but is not visible to you. The body says `not_found`. |
| 400    | The request body is not valid.                                                                       |
| 409    | A rule stops it: the last owner, a duplicate (email, invitation, team key, handle), or an empty private team. |
| 429    | Too many requests.                                                                                   |

Bodies are `{ "error": "<code>", "message": "<text>" }`; the web app shows its own translated text for each code.

A refusal never confirms that something exists. An id of another workspace, an id that does not exist, and an object
that is there but invisible to you (a private team you are not in, any team a guest is not in, a member a guest shares
no team with) all answer 404 `not_found`, identically. A 403 is only given for an object the person can already see.
Writes need an `Origin` header equal to the application URL.

## Keeping the rules honest

The rules are tested twice: `apps/server/src/permissions/matrix.test.ts` lists every role against every action, and
asks both the permission module and the running application, with the expected answers written out by hand; and
`apps/server/src/test/cross-workspace.test.ts` calls every authenticated endpoint with ids and sessions of another
workspace. A test fails when a route exists without a case in `apps/server/src/test/endpoints.ts`, so a new endpoint
cannot ship without its permission rows. See [CONTRIBUTING.md](../CONTRIBUTING.md) before adding a new kind of object.
