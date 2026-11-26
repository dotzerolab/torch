// Prepares the attachment bucket of an installation: creates it when it is missing, applies the browser (CORS) rules
// for APP_URL and the lifecycle rules for unfinished uploads. Safe to run again. The bucket must stay private: nothing in it is ever served without a signed URL.
//   pnpm --filter @torch/server storage:setup
import { fileURLToPath } from 'node:url';
import { readStorageConfig } from '../files/config.ts';
import {
  type BucketAdmin,
  corsRules,
  createS3BucketAdmin,
  lifecycleRules,
} from '../files/storage.ts';

export type { BucketAdmin } from '../files/storage.ts';

/** Creates the bucket when missing, then applies the CORS rules for `appUrl` and the lifecycle rules. Reports whether it created the bucket. */
export async function setupBucket(
  admin: BucketAdmin,
  appUrl: string,
): Promise<{ created: boolean }> {
  try {
    if (!/^https?:$/.test(new URL(appUrl).protocol)) throw new Error('not http(s)');
  } catch {
    throw new Error('APP_URL must be an http(s) URL such as http://localhost:5173');
  }
  const created = !(await admin.bucketExists());
  if (created) await admin.createBucket();
  await admin.putCors(corsRules(appUrl));
  await admin.putLifecycle(lifecycleRules());
  return { created };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = readStorageConfig(process.env);
  if (!config) {
    console.error('S3_ENDPOINT is not set: there is no storage to set up (see .env.example).');
    process.exit(1);
  }
  try {
    const { created } = await setupBucket(createS3BucketAdmin(config), process.env.APP_URL ?? '');
    console.info(
      `bucket "${config.bucket}": ${created ? 'created' : 'already there'}, CORS and lifecycle rules applied`,
    );
  } catch (error) {
    console.error(`storage setup failed: ${(error as Error).message}`);
    process.exit(1);
  }
}
