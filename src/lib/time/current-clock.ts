import { cache } from "react";

import { createClient } from "@/lib/supabase/server";
import { resolveTimeZone, todayInZone } from "@/lib/time/user-tz";
import { buildContext } from "@/lib/trpc/server";

/**
 * One reading of the clock, in the account holder's terms.
 *
 * The three fields are only ever correct *together* — `today` is
 * `todayInZone(timeZone, now)` and nothing else — which is why they travel as
 * one object rather than three props a caller could refresh independently.
 * Structurally identical to `TaskClock` in `src/components/tasks/types.ts`, and
 * deliberately declared here instead of imported from there: a `src/lib` module
 * that depended on a component directory would have the arrow pointing the
 * wrong way. The pages assert the match by annotating the call site.
 */
export interface UserClock {
  /** The instant the page render began. "Overdue" is judged against this. */
  now: Date;
  /** The account holder's IANA zone, taken from `profiles.timezone`. */
  timeZone: string;
  /** Their current calendar day as `YYYY-MM-DD`. */
  today: string;
}

/**
 * Read the clock for whoever is signed in — on the server, exactly once.
 *
 * **Server-only.** It reaches for the request's cookies (through
 * `createClient`), so importing it from a `"use client"` module is a build
 * error rather than a subtle runtime one. That is the intended failure.
 *
 * ## Why this exists at all, rather than four lines in each page
 *
 * Criterion 19: the "today" boundary has to resolve *identically* on the server
 * and in the browser, so SSR and hydration agree and nobody watches the screen
 * flip to a different day a beat after it loads. The mechanism behind that
 * criterion is stated in `user-tz.ts`: nothing in that module reads the ambient
 * clock, because the day is decided **once**, server-side, from the profile
 * that has already been loaded — and the result is then handed to client
 * components as plain props.
 *
 * This function is the *once*. Concentrating it here means the criterion is
 * auditable by grep: a `new Date()` anywhere under `src/components/**` that
 * decides what day it is, or how late something is, is a bug — and there is
 * exactly one legitimate call site to compare it against.
 *
 * `cache()` earns its keep on `/today`, which renders two task groups from one
 * clock: without it the overdue group and the day group would each take their
 * own reading, and two `new Date()` calls a few milliseconds apart can put a
 * task in neither bucket. With it, every list on the page agrees about "late".
 *
 * ## Why the zone comes from the profile and never from the browser
 *
 * `profiles.timezone` is the account holder's stated day boundary. A browser's
 * `Intl.DateTimeFormat().resolvedOptions().timeZone` is a fact about the device
 * they happen to be holding — correct often, wrong on a borrowed laptop, and
 * unavailable during SSR, which is the whole problem. `resolveTimeZone` turns a
 * missing or since-renamed column value into `UTC` rather than throwing: a task
 * list a few hours out beats a task list that 500s.
 *
 * ## The cost, stated
 *
 * `(app)/layout.tsx` already calls `buildContext` for the sidebar, so a page
 * that calls this does a second `getUser()` round-trip plus a second profile
 * read. `cache()` collapses repeats within one render pass but not across the
 * layout/page boundary, because the layout asks `buildContext` directly for the
 * whole context while this asks for one field of it. Same trade `AGENTS.md`
 * accepts for the proxy's live status read: correctness first, and the extra
 * round-trip is the accepted price.
 *
 * `profile` is nullable in the type system even though `(app)/layout.tsx` has
 * already redirected anyone without one. The layout is the guarantee; the `?.`
 * is the compiler not knowing that, and UTC is the answer if both are ever
 * wrong at once.
 */
export const currentUserClock = cache(
  async function currentUserClock(): Promise<UserClock> {
    const supabase = await createClient();
    const { profile } = await buildContext(supabase);

    const now = new Date();
    const timeZone = resolveTimeZone(profile?.timezone);

    return { now, timeZone, today: todayInZone(timeZone, now) };
  },
);
