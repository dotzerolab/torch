import { serve } from '@hono/node-server';
import { BrandConfigError, loadBrand } from '@torch/shared/brand';
import { createApp } from './app.ts';
import { createSessionActorResolver } from './auth/resolver.ts';
import { startCleanupSchedule } from './db/cleanup.ts';
import { createDb } from './db.ts';
import { createSmtpMailer } from './mail/mailer.ts';
import { ElectricConfigError, readElectricConfig } from './sync/config.ts';

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`PORT must be an integer between 1 and 65535, got "${process.env.PORT}"`);
}

let brand: ReturnType<typeof loadBrand>;
try {
  brand = loadBrand(process.env);
} catch (error) {
  if (!(error instanceof BrandConfigError)) throw error;
  console.error(error.message);
  process.exit(1);
}

// Sign-in needs a database; its links and cookie flags need the public URL of the web app.
let config: { appUrl: string; trustProxy: boolean } | undefined;
if (process.env.DATABASE_URL) {
  const appUrl = process.env.APP_URL ?? '';
  try {
    if (!/^https?:$/.test(new URL(appUrl).protocol)) throw new Error('not http(s)');
  } catch {
    throw new Error(`APP_URL must be an http(s) URL (e.g. http://localhost:5173), got "${appUrl}"`);
  }
  const trustProxy = process.env.TRUST_PROXY ?? 'false';
  if (trustProxy !== 'true' && trustProxy !== 'false') {
    throw new Error(`TRUST_PROXY must be "true" or "false", got "${trustProxy}"`);
  }
  config = { appUrl, trustProxy: trustProxy === 'true' };
}

let electric: ReturnType<typeof readElectricConfig>;
try {
  electric = readElectricConfig(process.env);
} catch (error) {
  if (!(error instanceof ElectricConfigError)) throw error;
  console.error(error.message);
  process.exit(1);
}

const db = process.env.DATABASE_URL ? createDb(process.env.DATABASE_URL) : undefined;
const mailer = process.env.SMTP_URL
  ? createSmtpMailer(process.env.SMTP_URL, {
      name: brand.emailSenderName,
      address: brand.emailSenderAddress,
    })
  : undefined;
if (db && !mailer)
  console.warn('SMTP_URL is not set: sign-in emails cannot be sent, sign-in is off');
const auth =
  db && config ? createSessionActorResolver({ orm: db.orm, appUrl: config.appUrl }) : undefined;
// The same resolver feeds the sync proxy and the mutation routes: one session decides what a request may see and change.
const app = createApp({ brand, db, config, mailer, auth, electric });
const server = serve({ fetch: app.fetch, port });

console.info(`server listening on port ${port}`);

// Expired sign-in tokens, old sessions and dead invitations: once at startup, then every 6 hours (counts are logged).
const stopCleanup = db ? startCleanupSchedule(db.orm) : undefined;

function shutdown() {
  stopCleanup?.();
  server.close(() => {
    void (db ? db.close() : Promise.resolve()).finally(() => process.exit(0));
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
