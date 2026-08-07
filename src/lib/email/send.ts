import nodemailer, { type Transporter } from "nodemailer";

import type { EmailMessage } from "./templates";

/**
 * The one place this application talks to a mail server.
 *
 * Everything else composes an `EmailMessage` and hands it here, so the provider
 * is one module's problem. `docs/gsd/devtask-pro-v1.md` named Resend; SMTP is
 * how that intent is satisfied without a second code path, because Resend speaks
 * SMTP too (`smtp.resend.com`) — as does every other provider worth switching
 * to, and as does the Mailpit instance in the local stack. So the transport that
 * runs in production is the transport the e2e suite exercises, rather than a
 * production-only branch that nothing local ever executes.
 *
 * ## Configuration
 *
 * `SMTP_HOST`, `SMTP_PORT`, `EMAIL_FROM` are required; `SMTP_USER` and
 * `SMTP_PASS` are optional because the local catcher wants no authentication
 * and offering it one makes the connection fail. Locally these are
 * `127.0.0.1`, `54425` — the port `[local_smtp]` in `supabase/config.toml`
 * exposes — and any address at all.
 *
 * ## Why the transport is built lazily and then kept
 *
 * Built on first use rather than at module scope: this file is imported by a
 * route handler, and a missing variable should fail a cron run with a sentence
 * naming it rather than crash the process that also serves the app. Kept
 * afterwards because a transport holds a connection pool, and rebuilding it per
 * message would open a new SMTP connection per reminder.
 */

let transporter: Transporter | null = null;

/** Read a required variable, or say which one is missing. */
function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set — the reminder job cannot send mail without it.`,
    );
  }
  return value;
}

/** Discard the cached transport. For tests, and for a config change in dev. */
export function resetTransport(): void {
  transporter = null;
}

function getTransport(): Transporter {
  if (transporter) return transporter;

  const host = required("SMTP_HOST");
  const port = Number(required("SMTP_PORT"));
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`SMTP_PORT must be a port number, got "${process.env.SMTP_PORT}".`);
  }

  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  transporter = nodemailer.createTransport({
    host,
    port,
    // Implicit TLS on 465, STARTTLS above it. The local catcher speaks neither,
    // which is why this is derived from the port rather than hard-coded on.
    secure: port === 465,
    ...(user && pass ? { auth: { user, pass } } : {}),
  });

  return transporter;
}

export interface SendEmailInput extends EmailMessage {
  to: string;
}

/**
 * Deliver one message. Throws on failure — **and the caller must let it**.
 *
 * `runReminders` catches per candidate and counts the failure, because one
 * unreachable address must not stop the other recipients' mail. What it does
 * *not* do is retry: the claim in `reminder_log` has already been written by the
 * time this is called, so a throw here is a missed reminder rather than a
 * duplicated one. That ordering is acceptance criterion 21, and the trade-off is
 * recorded on `reminders.claim()`.
 */
export async function sendEmail(input: SendEmailInput): Promise<void> {
  const from = required("EMAIL_FROM");

  await getTransport().sendMail({
    from,
    to: input.to,
    subject: input.subject,
    text: input.text,
    html: input.html,
  });
}
