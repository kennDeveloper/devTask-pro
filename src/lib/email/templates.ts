/**
 * The reminder email, as a pure function of what it is about.
 *
 * No transport, no environment, no clock — the whole message is derived from its
 * arguments, so it is unit-testable without a mail server and the copy is
 * asserted rather than eyeballed. `send.ts` is the only thing that talks to SMTP.
 *
 * ## The time is rendered in the recipient's zone, never the server's
 *
 * This is criterion 19's rule reaching one layer further than the UI. A reminder
 * that says "due at 01:00" because the job ran in UTC is wrong in exactly the
 * way the whole timezone design exists to prevent, and unlike a page nobody is
 * there to notice. The zone arrives as an argument for the same reason `now`
 * does elsewhere: a formatter that reads the ambient zone cannot be tested, and
 * would be reading the wrong one anyway.
 *
 * ## Plain on purpose
 *
 * Both parts are text-first. `AGENTS.md` scopes its no-raw-hex rule to
 * `src/components/**` and `src/app/**`, so a colour here would not fail the
 * grep — but a reminder is a sentence and a link, and mail clients are the one
 * place where a layout is genuinely likely to arrive broken. There is no image,
 * no table, no web font, and the HTML is a legible fallback of the text rather
 * than a different message.
 */

/** Everything the message says, and nothing about how it is delivered. */
export interface ReminderEmailInput {
  title: string;
  /** The instant the task is due. */
  deadlineAt: Date;
  /** The account holder's IANA zone, from `profiles.timezone`. */
  timeZone: string;
  /** Absolute URL back into the app. */
  url: string;
  /** Minutes of lead, for the "in 30 minutes" phrasing. */
  leadMinutes: number;
}

export interface EmailMessage {
  subject: string;
  text: string;
  html: string;
}

/**
 * Pinned locale, for the reason `format-date.ts` pins it: `en-GB` gives an
 * unambiguous day-first short form, and a host-dependent format would make the
 * same reminder read differently depending on which machine sent it.
 */
const LOCALE = "en-GB";

/** `"7 Aug 2026 at 09:00"`, as read on a clock in `timeZone`. */
export function formatDeadline(deadlineAt: Date, timeZone: string): string {
  const date = new Intl.DateTimeFormat(LOCALE, {
    timeZone,
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(deadlineAt);

  const time = new Intl.DateTimeFormat(LOCALE, {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(deadlineAt);

  return `${date} at ${time}`;
}

/**
 * "in 30 minutes", "in 1 hour", "in 1 day" — the lead, as somebody would say it.
 *
 * Whole units only, and it falls back to minutes rather than inventing "in 1.5
 * hours": the presets are all whole hours or days, and a lead written through
 * the API that is not deserves the literal number rather than a rounded one.
 */
export function describeLead(leadMinutes: number): string {
  if (leadMinutes <= 0) return "now";
  if (leadMinutes % 1440 === 0) return plural(leadMinutes / 1440, "day");
  if (leadMinutes % 60 === 0) return plural(leadMinutes / 60, "hour");
  return plural(leadMinutes, "minute");
}

function plural(count: number, unit: string): string {
  return `in ${count} ${unit}${count === 1 ? "" : "s"}`;
}

/**
 * Escape the four characters that would let a task title change the shape of
 * the HTML part.
 *
 * A title is free text the account holder wrote, and it is interpolated into
 * markup here. Nobody but its author receives this message, so the blast radius
 * is one person's own inbox — but "the user is the only one harmed" is not a
 * reason to emit broken markup, and a title containing `<b>` should read as
 * `<b>` rather than turn the rest of the mail bold.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** The reminder, both parts, from what it is about. */
export function reminderEmail(input: ReminderEmailInput): EmailMessage {
  const { title, deadlineAt, timeZone, url, leadMinutes } = input;

  const when = formatDeadline(deadlineAt, timeZone);
  const lead = describeLead(leadMinutes);

  const text = [
    `${title} is due ${lead}.`,
    ``,
    `Due ${when}.`,
    ``,
    `Open it: ${url}`,
    ``,
    `— devtask-pro`,
  ].join("\n");

  const html = [
    `<p>${escapeHtml(title)} is due ${lead}.</p>`,
    `<p>Due ${when}.</p>`,
    `<p><a href="${escapeHtml(url)}">Open it</a></p>`,
    `<p>— devtask-pro</p>`,
  ].join("\n");

  return {
    // The title first, because a subject line is read in a list where the
    // reminder's own framing is the least useful part.
    subject: `${title} — due ${lead}`,
    text,
    html,
  };
}
