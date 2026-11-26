# Comments: the REST contract

Comments live on issues. This page covers what exists today; read [issues](issues.md) first for the conventions every
call shares (paths under `/api/w/:workspaceId`, JSON bodies, UUIDs, `txid`, the error body, `Origin` on writes).
Everything is checked against the caller's permissions, see [permissions](../permissions.md).

## Rules in short

- A comment belongs to an issue and follows the issue's team: whoever can see the team can read, write, react and
  resolve, a guest included. An issue the caller cannot see answers 404, never 403.
- **Threads are one level deep.** A reply points at a top-level comment of the same issue; a reply to a reply is refused
  with 422 `invalid_reference` (`details.field` is `parentId`). Only a top-level comment can be resolved.
- Only the **author** edits a comment (an owner or admin included: 403). The previous text goes to the history, which
  keeps the newest 50 versions of each comment.
- The **author, an owner or an admin** deletes a comment. A deleted comment stays in its thread as a tombstone
  (`deleted: true`, empty text, no reactions, no history): the database keeps no deleted text and no earlier version of
  it. Nobody is sent it after the delete either: the live comment stream of the issue starts a new snapshot at every
  delete, so a reader that starts from nothing never receives the text or its earlier versions, and a reader that holds
  the old stream is told to start over (`409 must-refetch`, which the sync client handles by itself). The sync service
  keeps the log of the retired stream on its own disk until it drops unused shapes; nothing can read it through this
  server. Deleting twice changes nothing.
- **An archived issue is read-only**: every write answers 409 `issue_archived`. Reading stays open.
- Every write moves the `updated_at` of the issue, in the same transaction.
- A comment is at most 20,000 characters, trimmed, never empty.

## Calls

| Call                                                        | What it does                                                                 |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `GET /issues/:issueId/comments`                             | The comments of the issue, oldest first, one page at a time (below). Answers `{ comments, nextCursor }`. |
| `POST /issues/:issueId/comments`                            | Add `{ body, parentId? }`. Answers 201 `{ comment, txid }`.                  |
| `PATCH /comments/:commentId`                                | Change the text `{ body }`. Author only. Answers `{ txid }`.                 |
| `DELETE /comments/:commentId`                               | Delete (tombstone). Answers `{ txid }`.                                      |
| `POST /comments/:commentId/resolve`, `/unresolve`           | Resolve or reopen a thread. Doing either twice changes nothing. `{ txid }`.  |
| `PUT`, `DELETE /comments/:commentId/reactions/:emoji`       | Add or remove your reaction; the emoji is URL-encoded. `{ txid }`.           |
| `GET /comments/:commentId/history`                          | The earlier versions of the text (the newest 50), oldest first. Answers `{ edits }`. |

`GET /issues/:issueId/comments` takes the same paging as [the issue list](issues.md): `limit` (1 to 100, default 50) and
`cursor` (the `nextCursor` of the previous page; `null` on the last page, and an opaque value you never build). A limit
or a cursor that is not valid is 400 `invalid_input`.

The reactions are a fixed set of eight: 👍 👎 😄 🎉 😕 ❤️ 🚀 👀. Any other emoji is 400 `invalid_input`.

`POST` accepts the header `Idempotency-Key` (1 to 128 visible characters). Sending the same key and the same body again
returns the first answer with the header `Idempotent-Replayed: true` and writes nothing; the same key with another body
is 422 `idempotency_key_reused`. Bodies up to 128 KiB are read; larger ones are 413.

### The comment

```json
{
  "id": "…",
  "issueId": "…",
  "parentId": null,
  "authorId": "…",
  "body": "Looks right to me.",
  "reactions": { "👍": ["<member id>"] },
  "createdAt": "2026-01-02T10:00:00.000Z",
  "editedAt": null,
  "resolvedAt": null,
  "resolvedBy": null,
  "deleted": false
}
```

## Errors

The codes of [issues](issues.md#errors) apply, plus:

| Status | `error`           | Meaning                                                                          |
| ------ | ----------------- | -------------------------------------------------------------------------------- |
| 409    | `comment_deleted` | The comment was deleted: it cannot be edited, reacted to, resolved or replied to. |
| 422    | `invalid_input`   | Resolving a reply: only the first comment of a thread is a thread.               |

## Events

A new comment writes the event `comment.created` (version 1) in the same transaction. It carries ids and the issue
identifier, never the text: `{ issueId, identifier, commentId, parentId }`. A consumer reads the comment over REST,
where the permission check applies. Edits, reactions and deletes write no event.
