# Comments, files and documents: start here

One page for code that works with the text people write around an issue: comments, attached files and a team's
documents. Each part has its own contract page with every call and error; this page ties them together and shows the
sequences that are easy to get wrong.

- [Comments](comments.md), [attachments](attachments.md) and [documents](documents.md): every call, rule and error.
- [Issues](issues.md): the conventions all of them share (paths under `/api/w/:workspaceId`, JSON bodies, UUIDs, the
  `txid` of a write, the error body `{ error, message, details? }`, an `Origin` header on writes).
- [Permissions](../permissions.md): who may do what. An object the caller cannot see answers 404, never 403.

## Limits and types

| What                    | Limit                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------ |
| A comment               | 1 to 20,000 characters, trimmed.                                                                       |
| A document              | Title 1 to 255 characters; body up to 100,000 characters.                                              |
| A file                  | 25 MiB (`ATTACHMENT_MAX_BYTES` may lower it), 50 files per issue, 10 open uploads per person.          |
| File types              | PNG, JPEG, GIF, WebP, AVIF, PDF, plain text, CSV, Markdown, JSON, zip, docx, xlsx, pptx. Never HTML, SVG, XML, scripts, video or audio. |
| Signed upload and read  | An upload request is valid for 5 minutes, a download address for 60 seconds.                           |

## Writing a comment without writing it twice

`POST /issues/:issueId/comments` takes the header `Idempotency-Key` (1 to 128 visible characters). Send the same key
again with the same body, for example after a lost answer, and the server answers with the comment it already made and
adds `Idempotent-Replayed: true`. The same key with another body is refused with 422 `idempotency_key_reused`.

```sh
curl -X POST "$BASE/api/w/$WS/issues/$ISSUE/comments" \
  -H "Origin: $BASE" -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" -b "sid=$SESSION" \
  -d '{"body":"Deployed to staging."}'
# 201 {"comment":{"id":"…","body":"Deployed to staging.", …},"txid":123}
```

A comment is one level deep: `parentId` must name a top-level comment of the same issue. A deleted comment stays as a
tombstone with no text, and no earlier text of it is kept anywhere.

## Attaching a file

The file never passes through this server. The server presigns a request, you send the file to the storage, and the
server then checks what is stored.

1. `POST /issues/:issueId/attachments` with `{ "fileName": "shot.png", "contentType": "image/png", "size": 12345 }`
   (the exact size in bytes). The answer is 201 `{ attachment, upload }`; the attachment is `pending` and invisible.
2. Send the file to `upload.url` as `multipart/form-data`: every entry of `upload.fields` first, in order, then the file
   as the last field named `file`. Send no cookie to the storage. The storage itself refuses a body over the declared
   size or of another type.
3. `POST /attachments/:attachmentId/complete`. The storage copies the staged file to the file's own key, and the server
   compares the stored size, type and first bytes of that copy with what was declared and publishes the file. A file that is not what it said is deleted: 422 `file_rejected`.

If a step fails, start again from step 1; an upload nobody completes is removed after 24 hours.

To read a file, `GET /attachments/:attachmentId/file` answers 302 to an address that works for 60 seconds. Ask again
for a new one each time; do not store it.

## Reading what is there

- `GET /issues/:issueId/comments` lists every comment of an issue, oldest first. The history of one comment:
  `GET /comments/:commentId/history` (anyone who can see the issue reads it).
- `GET /issues/:issueId/attachments` lists the published files; `GET /teams/:teamId/documents` lists a team's documents
  without their text, and `GET /documents/:documentId` reads one with its text. Earlier versions:
  `GET /documents/:documentId/revisions`.
- **Event.** A new comment writes `comment.created` with ids and the issue identifier, never the text: read the comment
  over REST, where the permission check applies. Adding or removing a file rides the `issue.updated` event.

## Errors worth knowing

| Status | `error`                                  | When                                                                       |
| ------ | ---------------------------------------- | -------------------------------------------------------------------------- |
| 404    | `not_found`                              | The object does not exist, or the caller cannot see it, or it is in another workspace. |
| 409    | `issue_archived`, `document_archived`    | The issue or the document is archived: it is read-only.                    |
| 409    | `comment_deleted`                        | The comment was deleted.                                                   |
| 413    | `file_too_large`                         | The declared size is over the limit.                                       |
| 415    | `file_type_not_allowed`                  | The type is not on the list.                                               |
| 422    | `file_rejected`                          | The stored file does not match what was declared.                          |
| 422    | `idempotency_key_reused`                 | The same `Idempotency-Key` with another body.                              |
| 429    | `rate_limited`                           | Too many requests, or 10 uploads already open.                             |
| 503    | `storage_unavailable`                    | No file storage is configured, or it did not answer.                       |

## For people who synchronise a copy

The web app reads comments, files and a document's text as snapshots of one opened issue or document, read again when
the issue's `updated_at` changes (every comment and file write moves it, in the same transaction) and right after the
person's own write. Document titles are a live shape per team. A synced row never carries a storage key.
