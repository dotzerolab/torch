/** An attachment as the REST API describes it (the synced row is `SyncedAttachment`). */
export type AttachmentDto = {
  id: string;
  issueId: string;
  fileName: string;
  contentType: string;
  size: number;
  uploaderId: string;
  createdAt: string;
  status: 'pending' | 'ready';
};

/** The request the server presigned for the browser to send the file with. */
export type UploadRequest = {
  url: string;
  method: 'POST' | 'PUT';
  fields?: Record<string, string>;
  headers?: Record<string, string>;
};
