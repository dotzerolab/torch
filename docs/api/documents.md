# Documents: the REST contract

A team's documents: a title and a Markdown body, with their earlier versions. Read [issues](issues.md) first for the
conventions every call shares (paths under `/api/w/:workspaceId`, JSON bodies, UUIDs, `txid`, the error body, `Origin`
on writes). Everything is checked against the caller's permissions, see [permissions](../permissions.md).

## Rules in short

- A document belongs to a team. Whoever can see the team reads its documents; **anybody but a guest** who can see the
  team creates, edits and archives them. A guest in the team gets 403 on a write; a person who cannot see the team gets
  404 on everything.
- Edits are **last-writer-wins**: a change to the title or the body replaces it, and the previous title and body are
  kept as a revision (only when something changed; the newest 50 are kept). Two people editing at once both keep their
  version: one is the current text, the other is in the revisions.
- An **archived** document stays readable and is read-only until it is unarchived: an edit answers 409
  `document_archived`.
- Title: 1 to 255 characters, trimmed. Body: up to 100,000 characters, may be empty. Bodies up to 512 KiB are read;
  larger ones are 413.
- A list never carries bodies. Read one document to get its text.

## Calls

| Call                                         | What it does                                                                         |
| -------------------------------------------- | ------------------------------------------------------------------------------------ |
| `GET /teams/:teamId/documents`               | The team's documents without bodies, the most recently edited first. `?includeArchived=true` adds archived ones. Answers `{ documents }`. |
| `POST /teams/:teamId/documents`              | Create `{ title, body? }`. Answers 201 `{ document, txid }`.                         |
| `GET /documents/:documentId`                 | One document with its body. Answers `{ document }`.                                  |
| `PATCH /documents/:documentId`               | Change `{ title?, body? }` (at least one). Answers `{ txid }`.                       |
| `POST /documents/:documentId/archive`, `/unarchive` | Archive or unarchive. Doing either twice changes nothing. Answers `{ txid }`. |
| `GET /documents/:documentId/revisions`       | The earlier versions, newest first, at most 50. Answers `{ revisions }`.             |

`POST` accepts the header `Idempotency-Key` (1 to 128 visible characters): the same key and the same content again
returns the first answer with `Idempotent-Replayed: true` and writes nothing; the same key with other content is 422
`idempotency_key_reused`.

### The document

```json
{
  "id": "…",
  "teamId": "…",
  "title": "Runbook",
  "body": "Step one…",
  "createdBy": "…",
  "updatedBy": "…",
  "createdAt": "2026-01-02T10:00:00.000Z",
  "updatedAt": "2026-01-03T09:30:00.000Z",
  "archivedAt": null
}
```

`body` is absent from a list. A revision is `{ id, title, body, editedBy, createdAt }`.

## Errors

The codes of [issues](issues.md#errors) apply, plus:

| Status | `error`              | Meaning                                                        |
| ------ | -------------------- | -------------------------------------------------------------- |
| 409    | `document_archived`  | The document is archived: unarchive it first.                  |
