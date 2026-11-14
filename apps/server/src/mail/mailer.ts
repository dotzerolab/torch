// Outgoing mail behind one small interface: SMTP in production and dev (Mailpit), memory in unit tests.
import nodemailer from 'nodemailer';

export type MailMessage = { to: string; subject: string; text: string; html: string };
export type Mailer = { send(message: MailMessage): Promise<void> };

/** SMTP through nodemailer; `smtpUrl` is `smtp://host:port` (credentials and `smtps://` work too). */
export function createSmtpMailer(smtpUrl: string, from: { name: string; address: string }): Mailer {
  const transport = nodemailer.createTransport(smtpUrl);
  return {
    async send(message) {
      await transport.sendMail({
        from: { name: from.name, address: from.address },
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
    },
  };
}

/** Test double: keeps every message it was asked to send. */
export function createMemoryMailer(): Mailer & { sent: MailMessage[] } {
  const sent: MailMessage[] = [];
  return {
    sent,
    async send(message) {
      sent.push(message);
    },
  };
}
