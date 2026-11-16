# Issues, labels and workflow states: the REST contract

This page is the contract for code that reads and writes issues over HTTP: scripts, imports and integrations. It
covers what exists today. The planned parts are listed at the end, so nobody builds on something that is not there.

All paths start with `/api/w/:workspaceId`. Bodies and answers are JSON. Ids are UUIDs; send them in any case, the
server answers in lower case. Today a call is authenticated like the web app (a signed-in session, and writes carry an
`Origin` header equal to the application URL). Everything is checked against the caller's permissions, see
[permissions](../permissions.md).

## Issues

| Call                                         | What it does                                                                  |
| -------------------------------------------- | ----------------------------------------------------------------------------- |
| `POST /issues`                               | Create an issue with every field in one call. Answers 201 `{ issue, txid }`.  |
| `PATCH /issues/:issueId`                     | Change any subset of the fields. Answers `{ txid }`.                          |
| `POST /issues/:issueId/archive`, `/unarchive` | Archive or unarchive. Doing either twice changes nothing. Answers `{ txid }`. |
| `GET /issues`                                | List and poll issues (see below).                                             |
| `GET /issues/:issueId/relations`             | The relations of an issue.                                                    |
| `POST /issues/:issueId/relations`            | Add a relation `{ relatedIssueId, type }`; `type` is `blocks`, `blocked_by`, `related` or `duplicate`. |
| `DELETE /issues/:issueId/relations/:relationId` | Remove a relation.                                                         |
| `PUT`, `DELETE /issues/:issueId/subscribers/:memberId` | Subscribe or unsubscribe a member. Doing either twice changes nothing. |
| `POST /issues/:issueId/links`, `DELETE .../links/:linkId` | Add or remove a link `{ url, title? }`; only `http` and `https` are accepted. |

Every change answers `txid`, the Postgres transaction id of the write. The web app uses it to know when its synced copy
has caught up; an integration can ignore it.

### Create

`POST /issues` takes these fields. Only `teamId` and `title` are required. An unknown field is refused with
`invalid_input`, never ignored.

| Field           | Type                       | Notes                                                                                   |
| --------------- | -------------------------- | --------------------------------------------------------------------------------------- |
| `teamId`        | id                         | The team the issue belongs to. It never changes afterwards.                              |
| `title`         | string, 1 to 255           | Trimmed.                                                                                |
| `description`   | string, up to 100000       | Markdown text.                                                                          |
| `stateId`       | id                         | A state of the team. Default: the team's first backlog state.                           |
| `priority`      | integer 0 to 4             | 0 none, 1 urgent, 2 high, 3 medium, 4 low.                                              |
| `estimate`      | integer 0 to 64 or null    |                                                                                         |
| `assigneeId`    | id or null                 | An active member who can see the issue.                                                 |
| `labelIds`      | up to 50 ids               | Labels of the workspace or of the issue's team. Two labels of one group: the later one wins. |
| `dueDate`       | `YYYY-MM-DD` or null       |                                                                                         |
| `parentId`      | id or null                 | Makes a sub-issue. A parent cannot be its own ancestor (`parent_cycle`).                |
| `subscriberIds` | up to 100 ids              | Members who can see the issue.                                                          |
| `links`         | up to 20 `{ url, title? }` | `http` and `https` only.                                                                |
| `sortOrder`     | number                     | Default: the top of the state.                                                          |
| `externalRef`   | `{ source, id, url? }`     | Where the issue also lives. `source` is lower case: `[a-z0-9._-]`, 1 to 64 characters.  |

The server sets `number` (1, 2, 3 per team, no gaps, never reused), `creatorId` and the timestamps. The identifier of
an issue is `<TEAMKEY>-<number>`.

`PATCH /issues/:issueId` takes any subset of `title`, `description`, `priority`, `stateId`, `assigneeId`, `estimate`,
`dueDate`, `parentId`, `sortOrder`, plus `addLabelIds` and `removeLabelIds`. A field you leave out stays as it is;
`null` clears `assigneeId`, `estimate`, `dueDate` and `parentId`. Two writers that change different fields both win.

### The issue

```json
{
  "id": "…", "identifier": "ENG-12", "number": 12, "teamId": "…", "title": "…",
  "stateId": "…", "priority": 2, "estimate": null, "assigneeId": null, "creatorId": "…", "parentId": null,
  "dueDate": null, "sortOrder": -3,
  "createdAt": "…", "updatedAt": "…", "startedAt": null, "completedAt": null, "canceledAt": null, "archivedAt": null,
  "labelIds": ["…"], "externalRefs": [{ "source": "crm", "id": "A-77", "url": null }]
}
```

Dates are ISO 8601 strings. `description` is in the answer to a create, and in a list only with `include=description`.
`startedAt`, `completedAt` and `canceledAt` follow the state the issue is in.

### Idempotency

Send `Idempotency-Key: <1 to 128 visible characters>` with `POST /issues` to make a retry safe. The same person, key and
body answer the same 201 again, without creating a second issue or using a number, and the answer carries the header
`Idempotent-Replayed: true`. The same key with a different body answers 422 `idempotency_key_reused`. A key is kept for
24 hours; after that it is a new key. Keys are per person.

### External references

`externalRef` ties an issue to a record in another system. `source` plus `id` is unique in the workspace: creating a
second issue with the same pair answers 409 `external_ref_exists`, and when the caller can see the first issue the
answer's `details` hold its `issueId` and `identifier`, so a re-run of an import finds its way back. To look an issue up
by its reference, call `GET /issues?externalRef=<source>:<id>`.

### List and poll

`GET /issues` lists the issues of the teams the caller can see.

| Query            | Meaning                                                                                        |
| ---------------- | ---------------------------------------------------------------------------------------------- |
| `teamId`         | Only this team. A team the caller cannot see is 404.                                           |
| `updatedAfter`   | ISO 8601 date-time: issues updated after it (and at least 10 seconds ago, see below).          |
| `externalRef`    | `<source>:<id>`: the issue with this reference, if any.                                        |
| `includeArchived`| `true` to include archived issues (default: not included).                                     |
| `include`        | `description` adds the description to every issue.                                             |
| `limit`          | 1 to 100, default 50.                                                                          |
| `cursor`         | The `nextCursor` of the previous page.                                                         |

The answer is `{ issues, nextCursor }`. Issues come in ascending `(updatedAt, id)` order, so a walk that follows the
cursor sees an issue that changes mid-walk again and never skips one. `nextCursor` is `null` on the last page. A cursor
is opaque; do not build or parse one.

To poll for changes: keep the `updatedAt` of the last issue you received (the watermark), call
`GET /issues?updatedAfter=<it>` and follow `nextCursor` to the end. Then store the `updatedAt` of the last issue of that
walk as the new watermark.

- **Settle lag.** An issue is listed only once its `updatedAt` is at least 10 seconds old. A change shows up in the
  list about 10 seconds after it was made. The lag is what makes polling safe: the server stamps `updatedAt` before the
  transaction commits, and it keeps every transaction shorter than the lag, so an issue that is not listed yet can only
  be newer than every issue that is. A watermark therefore never moves past a change that has not been listed. The
  exact lookup `externalRef=<source>:<id>` is not delayed.
- **At-least-once.** `updatedAfter` is compared at millisecond precision and is strictly greater, while `updatedAt`
  has finer precision, so the last issue of the previous poll can come back once more. Treat every issue as an upsert,
  and drop one you already hold by `id` and `updatedAt`.
- Archiving an issue moves its `updatedAt`, so with `includeArchived=true` an archive shows up in the poll like any
  other change. Any change to an issue's relations, subscribers or links moves it too.

### Archived and canceled

These are two different things.

- **Canceled** is a workflow state of the type `canceled`. The issue is still active: it can be edited, moved back to
  another state and appears in lists. `canceledAt` is set while it is in such a state.
- **Archived** is `archivedAt` set. An archived issue is read-only (`PATCH` and the relation, subscriber and link calls
  answer 409 `issue_archived`) until it is unarchived. It is kept forever and keeps its number; the number is never
  reused.

There are no deletes: issues, labels and workflow states are archived, never removed. Relations, subscribers and links
are join rows and are removed for real.

## Labels

| Call                                  | What it does                                                                 |
| ------------------------------------- | ---------------------------------------------------------------------------- |
| `GET /labels?teamId=&includeArchived=`| The labels the caller can see. With `teamId`: those an issue of that team may carry (the workspace's and the team's). Answers `{ labels }`. |
| `POST /labels`                        | Create. `{ name, color, teamId?, parentId?, isGroup? }` → 201 `{ label, txid }`. |
| `PATCH /labels/:labelId`              | Rename, recolor or move to another group: `{ name?, color?, parentId? }`.    |
| `POST /labels/:labelId/archive`       | Archive. Doing it twice changes nothing.                                     |

A label with no `teamId` belongs to the workspace and can go on an issue of any team; a label with a `teamId` belongs
to that team. A group (`isGroup: true`) only groups: it is never put on an issue and has no parent. A child label
points at a group of the same scope (workspace with workspace, team with the same team); putting a label of a group on
an issue takes any other label of that group off it. `color` is `#rrggbb`, `name` is 1 to 80 characters and unique
per scope among labels that are not archived (compared without regard to case). Archived labels stay on the issues
that carry them, can still be edited and cannot be unarchived.

## Workflow states

| Call                                                | What it does                                                   |
| --------------------------------------------------- | -------------------------------------------------------------- |
| `GET /teams/:teamId/workflow-states?includeArchived=` | The states of a team in order → `{ states }`.                 |
| `POST /teams/:teamId/workflow-states`               | Create `{ name, type, color?, position? }` → 201 `{ state, txid }`. |
| `PATCH /teams/:teamId/workflow-states/:stateId`     | Rename, recolor or move `{ name?, color?, position? }`.        |
| `POST /teams/:teamId/workflow-states/:stateId/archive` | Archive; body `{ moveIssuesTo? }`.                          |

`type` is one of `backlog`, `unstarted`, `started`, `completed`, `canceled` and never changes. A team always keeps at
least one `backlog` or `unstarted` state and one `completed` state: archiving the last one answers 422
`workflow_state_required`. Archiving a state that still has issues needs `moveIssuesTo` (another state of the team that
is not archived), otherwise 422 `move_target_required`; the issues move in the same transaction and each move is
recorded in its history. An archived state takes no new issues (setting it on an issue is 400 `invalid_state`), frees
its name and stays readable. Names are unique per team among states that are not archived.

## Errors

Every answer that is not a success has the body `{ "error": "<code>", "message": "<text>", "details": { … } }`.
`error` is a stable code to switch on; `message` is English text for developers; `details` is optional and
machine-readable (for example `{ "field": "stateId" }`). More fields may be added to the body later, so ignore what you
do not know. Answers are never cached (`Cache-Control: no-store`).

| Status | `error`                                       | Meaning                                                                    |
| ------ | --------------------------------------------- | -------------------------------------------------------------------------- |
| 400    | `invalid_input`                               | The body, a query value, a cursor or the `Idempotency-Key` is not valid.   |
| 400    | `invalid_state`                               | The state is not a usable state of the issue's team (another team, or archived). |
| 400    | `invalid_assignee`                            | The assignee must be an active member who can see the issue.               |
| 401    | `unauthenticated`                             | Not signed in.                                                             |
| 403    | `forbidden`                                   | Allowed to see it, not to change it.                                       |
| 404    | `not_found`                                   | Missing, in another workspace, or invisible to the caller: all look alike. |
| 409    | `issue_archived`                              | The issue is archived: unarchive it first.                                 |
| 409    | `relation_exists`                             | These two issues already have this relation.                               |
| 409    | `external_ref_exists`                         | Another issue holds this `source` and `id`.                                |
| 409    | `label_name_taken`                            | A label of this scope already has the name.                                |
| 409    | `workflow_state_name_taken`                   | A state of this team already has the name.                                 |
| 413    | `invalid_input`                               | The body is too large.                                                     |
| 422    | `invalid_reference`                           | An id in the body (label, parent, subscriber, group…) does not exist or cannot be used here; `details.field` names it. |
| 422    | `parent_cycle`                                | The parent would make an issue its own ancestor.                           |
| 422    | `idempotency_key_reused`                      | The key was used before with a different body.                             |
| 422    | `workflow_state_required`                     | The team would be left without a needed state.                             |
| 422    | `move_target_required`                        | The state has issues: say where they move.                                 |

A refusal never confirms that something exists. A relation or a parent that points at an issue of a team the caller
cannot see is refused like one that does not exist, and a read never returns the title or number of such an issue.

## History and events

Every change of an issue writes one history row per changed field, label, relation, subscriber or link, and an event, in
the same transaction as the change. Each row says who acted and how (`web` today). Text is never copied into history or
events: a description change records that it changed, not what it said.

## What is planned

Not available yet; do not build on it:

- Access tokens for integrations, scoped to the teams an administrator lists, with per-token rate limits (429 with
  `Retry-After`).
- A versioned public API at `/api/v1` with an OpenAPI description.
- Pulling the events described above, with the actor and the external reference.
