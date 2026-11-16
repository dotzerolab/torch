// Test harness for the auth tests: the real app over a temp database, the memory mailer and a movable clock.
import type { Brand } from '@torch/shared/brand';
import { vi } from 'vitest';
import { createApp } from '../app.ts';
import { createSessionActorResolver } from '../auth/resolver.ts';
import type { Db } from '../db.ts';
import { createMemoryMailer } from '../mail/mailer.ts';
import type { AccessBus } from '../sync/access-bus.ts';

export const testBrand: Brand = {
  productName: 'Acme Tasks',
  logoLight: '/acme/logo-light.svg',
  logoDark: '/acme/logo-dark.svg',
  favicon: '/acme/favicon.svg',
  accentColor: '#3366ff',
  emailSenderName: 'Acme Tasks',
  emailSenderAddress: 'no-reply@acme.example',
};

export type RequestOptions = {
  cookie?: string;
  /** Origin header; defaults to the app origin. `null` sends none. */
  origin?: string | null;
  /** Socket address the server sees. */
  ip?: string;
  headers?: Record<string, string>;
};

export function createAuthTestApp(
  db: Db,
  opts: {
    appUrl?: string;
    trustProxy?: boolean;
    mailerFails?: boolean;
    accessBus?: AccessBus;
  } = {},
) {
  const appUrl = opts.appUrl ?? 'http://app.example.test';
  const clock = { current: new Date() };
  const now = () => new Date(clock.current);
  const mailer = createMemoryMailer();
  const sendingMailer = opts.mailerFails
    ? {
        send: async () => {
          throw new Error('smtp down');
        },
      }
    : mailer;
  const auth = createSessionActorResolver({ orm: db.orm, appUrl, now });
  const app = createApp({
    brand: testBrand,
    db,
    config: { appUrl, trustProxy: opts.trustProxy ?? false },
    mailer: sendingMailer,
    auth,
    now,
    accessBus: opts.accessBus,
  });
  const origin = new URL(appUrl).origin;

  function request(method: string, path: string, body: unknown, o: RequestOptions = {}) {
    const headers: Record<string, string> = { ...o.headers };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (o.cookie) headers.cookie = o.cookie;
    const sent = o.origin === undefined ? origin : o.origin;
    if (sent !== null) headers.origin = sent;
    const env = { incoming: { socket: { remoteAddress: o.ip ?? '10.0.0.1' } } };
    return app.fetch(
      new Request(`${origin}${path}`, {
        method,
        headers,
        body:
          body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      }),
      env,
    );
  }

  const post = (path: string, body: unknown, o?: RequestOptions) => request('POST', path, body, o);
  const get = (path: string, o?: RequestOptions) => request('GET', path, undefined, o);

  /** Waits until the memory mailer holds `count` messages. */
  const waitForMail = (count: number) =>
    vi.waitFor(() => {
      if (mailer.sent.length !== count) throw new Error(`mails: ${mailer.sent.length}/${count}`);
    });
  /** Lets background work (mail sending) finish when a test asserts that nothing happens. */
  const flush = () => new Promise((resolve) => setTimeout(resolve, 40));

  const tokenOf = (index: number): string => {
    const text = mailer.sent[index]?.text ?? '';
    const match = /token=([A-Za-z0-9_-]+)/.exec(text);
    if (!match?.[1]) throw new Error(`no sign-in link in mail ${index}`);
    return match[1];
  };

  /** Full sign-in: request the link, wait for the mail, press "Continue". */
  async function signIn(email: string, o: RequestOptions = {}) {
    const before = mailer.sent.length;
    const requested = await post('/api/auth/magic-link', { email }, o);
    if (requested.status !== 202) throw new Error(`magic-link answered ${requested.status}`);
    await waitForMail(before + 1);
    const token = tokenOf(before);
    const verified = await post('/api/auth/verify', { token }, o);
    const setCookie = verified.headers.getSetCookie()[0] ?? '';
    const cookie = setCookie.split(';')[0] ?? '';
    return { token, verified, cookie, cookieValue: cookie.split('=').slice(1).join('=') };
  }

  return {
    app,
    appUrl,
    origin,
    clock,
    now,
    mailer,
    auth,
    post,
    get,
    request,
    waitForMail,
    flush,
    tokenOf,
    signIn,
  };
}
