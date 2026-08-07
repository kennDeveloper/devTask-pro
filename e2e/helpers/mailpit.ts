/**
 * Mailpit helpers — the local stack's mail catcher.
 *
 * Email confirmation is ON (`enable_confirmations = true`), so a signup does not
 * produce a session. Any e2e that walks the real signup journey has to go and read
 * the confirmation link out of the inbox, exactly as a person would.
 *
 * ## Why the port is derived rather than hard-coded
 *
 * This used to be a literal `54424`, which is **main's** inbox. Every worktree
 * runs its own Supabase stack on its own port base — phase 3/4 on 5443x, phase 5
 * on 5444x — so in any of them that literal pointed at a different stack's mail
 * catcher.
 *
 * The failure is quiet and misleading rather than loud: the fetch succeeds, the
 * inbox is genuinely reachable, it simply never contains the message *this* stack
 * just sent. The spec then fails with "No mail for … within 15000ms", which reads
 * as a broken signup rather than as a harness pointed at the wrong port. It cost
 * a debugging session before it was understood.
 *
 * Deriving it from `NEXT_PUBLIC_SUPABASE_URL` — which `playwright.config.ts`
 * already loads from `.env.local`, and which is per-worktree by construction —
 * means a new worktree needs no extra environment at all. Setting a variable in
 * every `.env.worktree` would also work, and would be one more untracked thing to
 * remember exactly once per worktree and then debug when it is forgotten.
 */

/**
 * Mailpit sits three ports above the API — in every stack here, and in Supabase's
 * own default config (`api 54321`, `db 54322`, `studio 54323`, `inbucket 54324`).
 * Each worktree was created by shifting that whole base, so the offset survives:
 * main 54421 → 54424, phase 3/4 54431 → 54434, phase 5 54441 → 54444.
 *
 * A convention rather than a guarantee, which is exactly what `MAILPIT_URL` is
 * for: anyone who breaks the layout says so explicitly instead of editing this.
 */
const MAILPIT_PORT_OFFSET = 3;

function resolveMailpitUrl(): string {
  // An explicit override always wins.
  if (process.env.MAILPIT_URL) return process.env.MAILPIT_URL;

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (supabaseUrl) {
    try {
      const url = new URL(supabaseUrl);
      const apiPort = Number(url.port);
      if (Number.isInteger(apiPort) && apiPort > 0) {
        return `${url.protocol}//${url.hostname}:${apiPort + MAILPIT_PORT_OFFSET}`;
      }
    } catch {
      // A malformed URL falls through to the default rather than throwing out of
      // module initialisation, which would take down every spec in the suite
      // instead of only the ones that actually read mail.
    }
  }

  return "http://127.0.0.1:54424";
}

const MAILPIT = resolveMailpitUrl();

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
 * Every captured message addressed to `email`, newest first.
 *
 * Unlike `latestFor` this does not poll and does not throw on an empty inbox,
 * because its callers are asserting *how many* arrived — including zero, and
 * including "still exactly one after running the job twice", which is acceptance
 * criterion 21. A helper that waited for at least one could not express that.
 */
export async function messagesFor(email: string): Promise<MailpitSummary[]> {
  const res = await fetch(`${MAILPIT}/api/v1/messages?limit=200`);
  if (!res.ok) throw new Error(`Mailpit list: HTTP ${res.status}`);

  const { messages } = (await res.json()) as { messages: MailpitSummary[] };

  return messages.filter((message) =>
    message.To.some((to) => to.Address.toLowerCase() === email.toLowerCase()),
  );
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
