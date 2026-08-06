/**
 * Mailpit helpers — the local stack's mail catcher (port 54424).
 *
 * Email confirmation is ON (`enable_confirmations = true`), so a signup does not
 * produce a session. Any e2e that walks the real signup journey has to go and read
 * the confirmation link out of the inbox, exactly as a person would.
 */

const MAILPIT = process.env.MAILPIT_URL ?? "http://127.0.0.1:54424";

interface MailpitSummary {
  ID: string;
  Subject: string;
  To: { Address: string }[];
  Created: string;
}

/** Delete every captured message. Call before a journey so `latestFor` can't match a stale mail. */
export async function clearInbox(): Promise<void> {
  await fetch(`${MAILPIT}/api/v1/messages`, { method: "DELETE" });
}

/**
 * Poll for the most recent message addressed to `email`.
 *
 * Polls rather than waits-once because GoTrue sends asynchronously — asserting
 * immediately after submitting the form is racy and produces a test that fails
 * roughly one run in five.
 */
export async function latestFor(
  email: string,
  { timeoutMs = 15_000, intervalMs = 300 } = {},
): Promise<MailpitSummary> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const res = await fetch(`${MAILPIT}/api/v1/messages?limit=50`);
    if (res.ok) {
      const { messages } = (await res.json()) as { messages: MailpitSummary[] };
      const match = messages.find((m) =>
        m.To.some((t) => t.Address.toLowerCase() === email.toLowerCase()),
      );
      if (match) return match;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  throw new Error(`No mail for ${email} within ${timeoutMs}ms`);
}

/**
 * The first http(s) link in a message body.
 *
 * GoTrue's confirmation link points at the Supabase API's `/auth/v1/verify`, which
 * validates the token and then 302s to whatever `redirect_to` the signup requested —
 * for us, `/auth/callback`, which performs the PKCE exchange. Following this one URL
 * therefore exercises the whole chain.
 */
export async function linkFromMessage(id: string): Promise<string> {
  const res = await fetch(`${MAILPIT}/api/v1/message/${id}`);
  if (!res.ok) throw new Error(`Mailpit message ${id}: HTTP ${res.status}`);

  const body = (await res.json()) as { Text?: string; HTML?: string };
  const source = body.Text || body.HTML || "";
  const link = source.match(/https?:\/\/[^\s"'<>]+/)?.[0];

  if (!link) throw new Error(`No link found in message ${id}`);
  return link.replace(/&amp;/g, "&");
}

/** Convenience: wait for `email`'s newest mail and return its first link. */
export async function confirmationLinkFor(email: string): Promise<string> {
  const message = await latestFor(email);
  return linkFromMessage(message.ID);
}
