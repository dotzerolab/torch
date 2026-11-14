// drizzle-kit reads the shared schema and writes SQL migrations next to the server. Generate with
// `pnpm --filter @torch/server db:generate`; apply with `db:migrate` (the server never migrates by itself).
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: '../../packages/shared/src/db/schema.ts',
  out: './migrations',
});
