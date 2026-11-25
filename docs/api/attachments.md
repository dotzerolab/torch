# Attachments: the REST contract

Files attached to issues. Files never pass through the Torch server: it presigns an upload, the browser sends the file
straight to the storage, then the server verifies the stored object and publishes it. Read [issues](issues.md) first for
the conventions every call shares (paths under `/api/w/:workspaceId`, JSON bodies, UUIDs, `txid`, the error body,
`Origin` on writes). Everything is checked against the caller's permissions, see [permissions](../permissions.md).

## Rules in short

- A file follows the issue's team: whoever can see the team can attach, list and read, a guest included. An issue the
  caller cannot see answers 404.
- **Who removes:** the uploader, or anybody but a guest who can see the team. A guest cannot remove another person's
  file (403).
- **Limits:** 25 MiB per file, 50 files per issue (pending uploads count), 10 open uploads per person. A limit is
  `413 file_too_large`, `409 too_many_attachments` or `429 rate_limited`.
- **Types:** PNG, JPEG, GIF, WebP, AVIF, PDF, plain text, CSV, Markdown, JSON, zip and the Office formats (docx, xlsx,
  pptx). Anything else is `415 file_type_not_allowed`. HTML, SVG, XML, scripts, video and audio are never accepted.
- **The storage checks the size and the type itself** (the presigned request carries a policy), and the server checks
  them again, and the first bytes of the file, when the upload is completed. A file that is not what it said is deleted
  and answers 422 `file_rejected`.
- **An archived issue is read-only**, uploads included (409 `issue_archived`).
- An upload nobody completes is removed after 24 hours, with its object.
- The name is cleaned (no directory, quote, line break or hidden formatting character; at most 200 characters) and the
  file is stored under an id, never under its name.

## Calls

| Call                                          | What it does                                                                                       |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `POST /issues/:issueId/attachments`           | Start an upload with `{ fileName, contentType, size }`. Answers 201 `{ attachment, upload }`.      |
| `POST /attachments/:attachmentId/complete`    | Verify the stored file and publish it. Uploader only. Answers `{ attachment, txid }`.              |
| `GET /issues/:issueId/attachments`            | The published files of the issue, oldest first. Answers `{ attachments }`.                         |
| `GET /attachments/:attachmentId/file`         | Answers 302 to a signed URL valid for 60 seconds. `?inline=1` asks to show an image in the page.   |
| `DELETE /attachments/:attachmentId`           | Remove a file. Answers `{ txid }`.                                                                 |

Without file storage on the server, every call but the list answers 503 `storage_unavailable`.

### Uploading

1. `POST /issues/:issueId/attachments` with the name, the type and the exact size in bytes. The answer holds
   `upload: { url, method, fields }` and the `attachment` (status `pending`).
2. Send the file to `upload.url` as `multipart/form-data`: first every entry of `upload.fields`, in order, then the file
   itself as the last field named `file`. The request is valid for 5 minutes. The storage refuses a body that is
   larger than the declared size or that has another content type.
3. `POST /attachments/:attachmentId/complete`. The file is listed (and the issue moves) only after this succeeds.

### Reading

`GET /attachments/:attachmentId/file` answers 302 with the signed URL in `Location`, `Cache-Control: no-store` and
`Referrer-Policy: no-referrer`. The URL is minted after the permission check, on every request, and is never stored: a
person removed from the team gets 404 on the next request whatever URL they kept. Files are served as downloads; only
raster images are shown inline, and only when `inline=1` is sent and the name carries the image's own extension.

### The attachment

```json
{
  "id": "…",
  "issueId": "…",
  "fileName": "shot.png",
  "contentType": "image/png",
  "size": 48213,
  "uploaderId": "…",
  "createdAt": "2026-01-02T10:00:00.000Z",
  "status": "ready"
}
```

The object key is never part of an answer, but the upload request names it (it holds ids only).

## Errors

The codes of [issues](issues.md#errors) apply, plus:

| Status | `error`                 | Meaning                                                                      |
| ------ | ----------------------- | ---------------------------------------------------------------------------- |
| 409    | `too_many_attachments`  | The issue holds 50 files or pending uploads.                                 |
| 413    | `file_too_large`        | The declared size is over the limit.                                         |
| 415    | `file_type_not_allowed` | The type is not on the list.                                                 |
| 422    | `file_rejected`         | The stored file is missing, or its size, type or first bytes do not match.   |
| 429    | `rate_limited`          | The person already has 10 uploads open.                                      |
| 503    | `storage_unavailable`   | No file storage is configured, or it did not answer.                         |

## History and events

Adding or removing a file writes a history row (`issue.attachment_added`, `issue.attachment_removed`) and an
`issue.updated` event with `changes.attachments`, in the same transaction. They carry the file's id, name, size and type,
never its storage key.
