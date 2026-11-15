// Reads the sign-in emails the stack sends to Mailpit (MAILPIT_API_URL). Every e2e member has its own address,
// so a mailbox is "the messages to that address".
const api = () => {
  const url = process.env.MAILPIT_API_URL;
  if (!url) throw new Error('MAILPIT_API_URL is not set (see .env.example)');
  return url.replace(/\/+$/, '');
};

type Summary = { ID: string; Subject: string; Created: string };
type Message = { ID: string; Subject: string; Text: string };

const search = (email: string) =>
  `${api()}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`;

/** Empties the mailbox of one address, so the next message found is the one the test just caused. */
export async function clearMailbox(email: string): Promise<void> {
  const res = await fetch(search(email), { method: 'DELETE' });
  if (!res.ok) throw new Error(`Mailpit DELETE failed with status ${res.status}`);
}

/** The newest message to `email`, waiting up to `timeoutMs` for it to arrive. */
export async function waitForMessage(
  email: string,
  timeoutMs = 10_000,
): Promise<{ subject: string; text: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(search(email));
    if (!res.ok) throw new Error(`Mailpit search failed with status ${res.status}`);
    const found = (await res.json()) as { messages: Summary[] };
    const newest = [...found.messages].sort((a, b) => b.Created.localeCompare(a.Created))[0];
    if (newest) {
      const message = (await (
        await fetch(`${api()}/api/v1/message/${newest.ID}`)
      ).json()) as Message;
      return { subject: message.Subject, text: message.Text };
    }
    if (Date.now() > deadline) throw new Error(`no email to ${email} within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** The sign-in link of the newest message to `email` (the first `/auth/verify#token=` URL in its text part). */
export async function latestSignInLink(email: string): Promise<string> {
  const { text } = await waitForMessage(email);
  const link = text.match(/https?:\/\/[^\s<>"]+\/auth\/verify#token=[\w-]+/)?.[0];
  if (!link) throw new Error(`no sign-in link in the email to ${email}`);
  return link;
}

/** The invitation link of the newest message to `email` (the first `/invite#token=` URL in its text part). */
export async function latestInviteLink(email: string): Promise<string> {
  const { text } = await waitForMessage(email);
  const link = text.match(/https?:\/\/[^\s<>"]+\/invite#token=[\w-]+/)?.[0];
  if (!link) throw new Error(`no invitation link in the email to ${email}`);
  return link;
}
