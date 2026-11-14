import { describe, expect, it } from 'vitest';
import { createMemoryMailer, createSmtpMailer } from './mailer.ts';

describe('memory mailer', () => {
  it('records messages', async () => {
    const mailer = createMemoryMailer();
    const message = { to: 'a@example.test', subject: 's', text: 't', html: '<p>t</p>' };

    await mailer.send(message);
    await mailer.send({ ...message, to: 'b@example.test' });

    expect(mailer.sent.map((m) => m.to)).toEqual(['a@example.test', 'b@example.test']);
    expect(mailer.sent[0]).toEqual(message);
  });
});

const smtpUrl = process.env.SMTP_URL;
const mailpitApi = process.env.MAILPIT_API_URL;

// Integration: needs Mailpit from the dev compose. Skipped, loudly, when MAILPIT_API_URL is not set.
if (!mailpitApi || !smtpUrl) {
  console.warn(
    '[mailer.test] SKIPPED the SMTP integration test: SMTP_URL or MAILPIT_API_URL is not set. ' +
      'Start `docker compose -f docker-compose.dev.yml up -d --wait mail` and set both (see .env.example).',
  );
}

describe.skipIf(!mailpitApi || !smtpUrl)('SMTP mailer (Mailpit)', () => {
  it('SMTP mailer delivers to Mailpit', async () => {
    const to = `smtp-${crypto.randomUUID()}@example.test`;
    const mailer = createSmtpMailer(smtpUrl as string, {
      name: 'Acme Tasks',
      address: 'no-reply@acme.example',
    });

    await mailer.send({
      to,
      subject: 'Hello Mailpit',
      text: 'plain body',
      html: '<p>html body</p>',
    });

    const res = await fetch(`${mailpitApi}/api/v1/messages`);
    const body = (await res.json()) as {
      messages: {
        Subject: string;
        From: { Name: string; Address: string };
        To: { Address: string }[];
      }[];
    };
    const found = body.messages.find((m) => m.To.some((r) => r.Address === to));
    expect(found?.Subject).toBe('Hello Mailpit');
    expect(found?.From).toEqual({ Name: 'Acme Tasks', Address: 'no-reply@acme.example' });
  });
});
