import { serviceClient } from "./accounts";

/**
 * Task seeding for e2e, using the service-role key.
 *
 * ## Why seed at all, when the app can create tasks
 *
 * A deadline in the *past* is the one thing the UI is deliberately awkward at:
 * `<input type="datetime-local">` takes a wall-clock reading with no zone, and
 * typing one that lands a known number of minutes before `now()` — the instant
 * the overdue predicate actually compares against — means doing the zone
 * arithmetic in the spec that `localInputToInstant` exists to do in the app. So
 * the arrangement is set up in SQL and the *behaviour* is exercised through the
 * browser, which is where the criteria live. Every spec that seeds also creates
 * at least one task through the real dialog.
 *
 * ## Why service-role, and why that is not cheating
 *
 * These rows bypass RLS on the way in — that is the point of the key, and the
 * same thing `createAccount` does. What is being tested is what the app does
 * with a row once it exists; the guarantee that a *user* cannot write somebody
 * else's row is proven in `tests/integration/rls-boundary.test.ts`, where it
 * belongs.
 *
 * ## Dates
 *
 * A profile created by `createAccount` carries the schema default timezone,
 * `UTC` (see `0001_initial_schema.sql`). So the app's idea of "today" is the UTC
 * calendar day, and `dayFromToday()` below computes exactly that. A spec that
 * moves a profile's timezone must not use these helpers without adjusting.
 */

export type SeededTaskStatus = "todo" | "in_progress" | "done";

export interface SeedTaskInput {
  title: string;
  /** `YYYY-MM-DD`. Defaults to today. */
  occursOn?: string;
  /** An ISO instant, or `null` for "no deadline" — which is never overdue. */
  deadlineAt?: string | null;
  status?: SeededTaskStatus;
  progressPct?: number;
  description?: string | null;
}

/** Insert one task owned by `userId`. Returns its id. */
export async function seedTask(
  userId: string,
  input: SeedTaskInput,
): Promise<string> {
  const { data, error } = await serviceClient()
    .from("task_occurrence")
    .insert({
      user_id: userId,
      title: input.title,
      description: input.description ?? null,
      occurs_on: input.occursOn ?? dayFromToday(0),
      deadline_at: input.deadlineAt ?? null,
      status: input.status ?? "todo",
      progress_pct: input.progressPct ?? 0,
    })
    .select("id")
    .single();

  if (error) throw error;
  return data.id as string;
}

/** The calendar day `offset` days from today, as `YYYY-MM-DD`. */
export function dayFromToday(offset: number): string {
  const day = new Date();
  day.setUTCDate(day.getUTCDate() + offset);
  return day.toISOString().slice(0, 10);
}

/** An ISO instant `offset` hours from now. Negative is the past. */
export function hoursFromNow(offset: number): string {
  return new Date(Date.now() + offset * 3_600_000).toISOString();
}
