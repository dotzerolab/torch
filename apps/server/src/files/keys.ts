// The two keys of an attachment in the storage. The browser may write one of them and only that one: the staging key,
// under a prefix of its own so the bucket can expire what is left there (a lifecycle filter is a key prefix). The
// published key is written by the server alone, with a copy made inside the storage after the staged object passed
// the checks, and nothing the browser holds can write it.

/** Where the browser puts a file first; the bucket expires everything under it after a day. */
export const UPLOAD_PREFIX = 'uploads/';

/** The key a presigned upload request names. */
export const stagingKeyOf = (workspaceId: string, attachmentId: string) =>
  `${UPLOAD_PREFIX}${workspaceId}/${attachmentId}`;

/** The key of a verified file: what the row stores and what reads are signed for. */
export const finalKeyOf = (workspaceId: string, attachmentId: string) =>
  `workspaces/${workspaceId}/attachments/${attachmentId}`;
