// First workspace of a real installation: creates the workspace and its owner. The owner then signs in with a
// magic link sent to that address.
//   pnpm --filter @torch/server bootstrap --name <name> --slug <slug> --email <email> --owner-name <name>
import { parseArgs } from 'node:util';
import { member, workspace } from '@torch/shared/db/schema';
import { eq } from 'drizzle-orm';
import { createDb, type Orm } from '../db.ts';

export type BootstrapInput = { name: string; slug: string; ownerEmail: string; ownerName: string };

const SLUG = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Creates the workspace and its owner in one transaction; returns their ids. */
export async function bootstrapWorkspace(
  orm: Orm,
  input: BootstrapInput,
): Promise<{ workspaceId: string; memberId: string }> {
  const name = input.name.trim();
  const ownerName = input.ownerName.trim();
  // Same normalisation as the member table's check constraint (`lower(btrim(email))`).
  const email = input.ownerEmail.trim().toLowerCase();
  if (!name) throw new Error('workspace name must not be empty');
  if (!SLUG.test(input.slug)) {
    throw new Error(
      'slug must be 2-40 characters: lower-case letters, digits and hyphens, no hyphen at either end',
    );
  }
  if (!EMAIL.test(email)) throw new Error('owner email is not a valid address');
  if (!ownerName) throw new Error('owner name must not be empty');

  return orm.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: workspace.id })
      .from(workspace)
      .where(eq(workspace.slug, input.slug))
      .limit(1);
    if (existing) throw new Error(`a workspace with slug "${input.slug}" already exists`);

    const [ws] = await tx.insert(workspace).values({ name, slug: input.slug }).returning();
    if (!ws) throw new Error('workspace insert returned no row');
    const handle = (email.split('@')[0] ?? '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const [owner] = await tx
      .insert(member)
      .values({
        workspaceId: ws.id,
        email,
        name: ownerName,
        handle: handle || 'owner',
        role: 'owner',
      })
      .returning();
    if (!owner) throw new Error('owner insert returned no row');
    return { workspaceId: ws.id, memberId: owner.id };
  });
}

export function parseBootstrapArgs(argv: string[]): BootstrapInput {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      name: { type: 'string' },
      slug: { type: 'string' },
      email: { type: 'string' },
      'owner-name': { type: 'string' },
    },
  });
  const need = (option: 'name' | 'slug' | 'email' | 'owner-name'): string => {
    const value = values[option];
    if (!value) throw new Error(`missing required option --${option}`);
    return value;
  };
  return {
    name: need('name'),
    slug: need('slug'),
    ownerEmail: need('email'),
    ownerName: need('owner-name'),
  };
}

if (import.meta.main) {
  const usage =
    'usage: bootstrap --name <name> --slug <slug> --email <email> --owner-name <name> (DATABASE_URL must be set)';
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error(`DATABASE_URL is not set (see .env.example)\n${usage}`);
    process.exit(1);
  }
  let input: BootstrapInput;
  try {
    input = parseBootstrapArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${(error as Error).message}\n${usage}`);
    process.exit(1);
  }
  const db = createDb(databaseUrl);
  try {
    const { workspaceId, memberId } = await bootstrapWorkspace(db.orm, input);
    console.info(`workspace ${workspaceId} created with owner ${memberId}`);
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  } finally {
    await db.close();
  }
}
