import { NextResponse } from "next/server";

import { runReminders } from "@/lib/reminders/run";

/**
 * The reminder job's entry point, invoked by Vercel Cron.
 *
 * Parses, delegates, serialises — `AGENTS.md`'s rule for a route handler, and it
 * matters more here than usual: everything that decides *which* reminders go out
 * is in `src/lib/reminders/`, where it is unit-tested without a request. This
 * file's whole job is the bearer check and the shape of the response.
 *
 * `GET` because that is what Vercel Cron issues. No route config is needed to
 * keep it dynamic: Next 16 does not cache Route Handlers by default, and reading
 * `request.headers` would stop prerendering regardless.
 *
 * The proxy already lets this through — `/api` is in `ALWAYS_ALLOWED_PREFIXES`
 * (`src/lib/access/status-route.ts`), where phase 1 named this endpoint by name
 * on the grounds that a route handler carries its own authorization. It does,
 * below.
 *
 * ## The schedule, and the one thing to check before deploying
 *
 * `vercel.json` declares a five-minute schedule, which is what
 * `REMINDER_PRESETS`' floor of 15 minutes is sized against. (The cron expression
 * is not quoted here: it contains a star-slash, which would close this comment.)
 * **Vercel's Hobby plan caps cron at one
 * invocation per day**, which would leave every preset but "1 day before"
 * meaningless — reminders would be claimed and sent only once daily, and any
 * whose deadline had already passed would be skipped rather than delivered late.
 * That needs Pro or an external scheduler hitting this URL. Deployment is
 * deferred project-wide, so this is a thing to settle then, not now. JSON has no
 * comments, which is why the caveat is here rather than beside the schedule.
 */

/**
 * Compare two secrets without leaking their common prefix through timing.
 *
 * Somewhat belt-and-braces for a cron endpoint whose worst case is an unwanted
 * mail run, but the alternative is `===` on a credential, which is the kind of
 * thing that gets copied into a context where it does matter.
 *
 * The length check is deliberately outside the loop: lengths are not secret, and
 * comparing different-length strings needs an answer before the loop can run.
 */
function secretsMatch(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;

  let difference = 0;
  for (let index = 0; index < provided.length; index += 1) {
    difference |= provided.charCodeAt(index) ^ expected.charCodeAt(index);
  }

  return difference === 0;
}

export async function GET(request: Request) {
  const expected = process.env.CRON_SECRET;

  // An unset secret is a **refusal**, not an open door. A deploy that forgot the
  // variable should send no mail and say so, rather than expose an endpoint that
  // reads every active account's tasks to anybody who finds the path.
  if (!expected) {
    return NextResponse.json(
      { error: "CRON_SECRET is not configured." },
      { status: 401 },
    );
  }

  const provided = request.headers.get("authorization") ?? "";
  const token = provided.startsWith("Bearer ") ? provided.slice(7) : "";

  if (!secretsMatch(token, expected)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // One instant for the whole run, so every account is judged against the same
    // moment — and so a run that takes a minute does not treat its last account
    // differently from its first.
    const summary = await runReminders(new Date());

    // Aggregate counts only, deliberately. Per-account detail would be useful in
    // development and would turn a leaked secret into an account enumeration —
    // the run already logs what failed, server-side, where it belongs.
    return NextResponse.json(summary);
  } catch (error) {
    console.error("[reminders] run failed", error);

    return NextResponse.json(
      { error: "The reminder run failed." },
      { status: 500 },
    );
  }
}
