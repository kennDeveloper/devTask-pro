/**
 * The repeat-rule form, as values and payloads rather than as JSX.
 *
 * Exactly the split `task-form.ts` uses, and for the same reason: everything
 * that decides *what to send* lives here so it can be unit-tested without a DOM
 * and without a tRPC provider, which is AGENTS.md's "validation and predicates
 * go in a lib file, not JSX".
 *
 * ## The values are flat and the payload is nested
 *
 * One control binds one key — a `<select>` cannot bind to `values.rule.freq`
 * without a setter that rebuilds the nested object on every keystroke. The
 * flattening is undone once, in `toRulePayload`, on the way out.
 *
 * ## Every mode keeps a usable value, even while it is hidden
 *
 * `monthDay`, `nthWeek`, `endsCount` and the rest hold real defaults whatever
 * the current frequency is, so switching Monthly → by_nth_weekday → back does
 * not leave a control empty and a form unsubmittable. What stops those stale
 * values reaching the database is `normaliseRule` on the server, which clears
 * whatever the chosen frequency does not use — and `task_series_weekly_days_check`
 * and friends in 0005 if it ever failed to.
 *
 * ## The schemas are imported, not restated
 *
 * `buildSeriesInput` runs `seriesInput` and `buildSeriesUpdateInput` runs
 * `seriesUpdateInput` — the exact schemas `src/lib/trpc/routers/series.ts`
 * validates with. The user reads the same sentence before the round trip that
 * the server would have produced after it.
 */

import type {
  EndsMode,
  MonthMode,
  NthWeek,
  RecurrenceFrequency,
  Weekday,
} from "@/lib/db/schema";
import { weekdayCode } from "@/lib/recurrence/calendar";
import type { RecurrenceRule } from "@/lib/recurrence/rule";
import {
  seriesInput,
  seriesUpdateInput,
} from "@/lib/tasks/series-validators";

import type { Series, SeriesCreateInput, SeriesUpdateInput, TaskClock } from "./types";

/** What the controls hold. Flat, because each one binds a single key. */
export interface SeriesFormValues {
  title: string;
  description: string;
  /** `YYYY-MM-DD` — the first candidate date and the anchor everything counts from. */
  startsOn: string;
  /** `HH:MM` as read on a clock in `TaskClock.timeZone`, or `""` for no deadline. */
  deadlineTime: string;
  freq: RecurrenceFrequency;
  interval: number;
  byweekday: Weekday[];
  monthMode: MonthMode;
  monthDay: number;
  nthWeek: NthWeek;
  nthWeekday: Weekday;
  endsMode: EndsMode;
  /** `YYYY-MM-DD`, or `""` while another end mode is selected. */
  endsOn: string;
  endsCount: number;
}

export interface SeriesFormErrors {
  title?: string;
  description?: string;
  startsOn?: string;
  deadlineTime?: string;
  freq?: string;
  interval?: string;
  byweekday?: string;
  monthMode?: string;
  monthDay?: string;
  nthWeek?: string;
  nthWeekday?: string;
  endsMode?: string;
  endsOn?: string;
  endsCount?: string;
  /** An issue that names no field — a whole-object rule. */
  form?: string;
}

export type SeriesFormResult<T> =
  | { ok: true; data: T }
  | { ok: false; errors: SeriesFormErrors };

/**
 * Schema path → form field.
 *
 * The rule's fields are nested one level on the wire and flat in the form, so
 * `rule.byweekday` has to find `byweekday`. Written as a map rather than by
 * stripping the prefix, because `deadlineTime` and `title` are *not* nested and
 * a blanket rule would mangle them.
 */
const FIELD_FOR_PATH: Record<string, keyof SeriesFormErrors> = {
  title: "title",
  description: "description",
  startsOn: "startsOn",
  deadlineTime: "deadlineTime",
  "rule.freq": "freq",
  "rule.interval": "interval",
  "rule.byweekday": "byweekday",
  "rule.monthMode": "monthMode",
  "rule.monthDay": "monthDay",
  "rule.nthWeek": "nthWeek",
  "rule.nthWeekday": "nthWeekday",
  "rule.endsMode": "endsMode",
  "rule.endsOn": "endsOn",
  "rule.endsCount": "endsCount",
};

/** First issue per field wins — see the note in `task-form.ts`. */
function errorsFromIssues(
  issues: readonly {
    readonly path: readonly PropertyKey[];
    readonly message: string;
  }[],
): SeriesFormErrors {
  const errors: SeriesFormErrors = {};

  for (const issue of issues) {
    const field = FIELD_FOR_PATH[issue.path.map(String).join(".")] ?? "form";
    if (errors[field] === undefined) errors[field] = issue.message;
  }

  return errors;
}

/**
 * Seed values for the dialog.
 *
 * Creating seeds `startsOn` from `clock.today` — the *user's* day, resolved on
 * the server. A `new Date()` here would seed the browser's day, which is a
 * different day for anyone east of the server after their evening and would
 * differ between the SSR pass and hydration (criterion 19).
 *
 * The weekday is seeded from that same day, so the first thing the editor
 * renders already describes a real rule rather than one naming no days.
 */
export function initialSeriesFormValues(
  series: Series | null,
  clock: TaskClock,
): SeriesFormValues {
  const startsOn = series?.startsOn ?? clock.today;
  const fallbackWeekday = weekdayCode(startsOn);

  return {
    title: series?.title ?? "",
    description: series?.description ?? "",
    startsOn,
    deadlineTime: series?.deadlineTime ?? "",
    freq: series?.rule.freq ?? "weekly",
    interval: series?.rule.interval ?? 1,
    byweekday:
      series && series.rule.byweekday.length > 0
        ? [...series.rule.byweekday]
        : [fallbackWeekday],
    monthMode: series?.rule.monthMode ?? "by_date",
    monthDay: series?.rule.monthDay ?? Number(startsOn.slice(8, 10)),
    nthWeek: series?.rule.nthWeek ?? 1,
    nthWeekday: series?.rule.nthWeekday ?? fallbackWeekday,
    endsMode: series?.rule.endsMode ?? "never",
    endsOn: series?.rule.endsOn ?? "",
    endsCount: series?.rule.endsCount ?? 10,
  };
}

/**
 * The values as the rule the engine and the schema both speak.
 *
 * Exported because the dialog renders `describeRule(toRule(values))` as a live
 * preview — the same function the repeat button in the list uses, so what the
 * editor promises and what the list later says are one string.
 */
export function toRule(values: SeriesFormValues): RecurrenceRule {
  return {
    freq: values.freq,
    interval: values.interval,
    byweekday: values.byweekday,
    monthMode: values.freq === "monthly" ? values.monthMode : null,
    monthDay: values.monthDay,
    nthWeek: values.nthWeek,
    nthWeekday: values.nthWeekday,
    endsMode: values.endsMode,
    endsOn: values.endsOn || null,
    endsCount: values.endsCount,
  };
}

/**
 * The rule half of the payload.
 *
 * Only the fields the chosen shape uses are sent, so the server's
 * `normaliseRule` has less to clear and a reader of the network tab sees the
 * rule that was meant. It is belt and braces rather than the guarantee — the
 * guarantee is `normaliseRule` on the server and the CHECK constraints under it.
 */
function toRulePayload(values: SeriesFormValues) {
  const monthly = values.freq === "monthly";

  return {
    freq: values.freq,
    interval: values.interval,
    byweekday: values.freq === "weekly" ? values.byweekday : [],
    monthMode: monthly ? values.monthMode : null,
    monthDay: monthly && values.monthMode === "by_date" ? values.monthDay : null,
    nthWeek:
      monthly && values.monthMode === "by_nth_weekday" ? values.nthWeek : null,
    nthWeekday:
      monthly && values.monthMode === "by_nth_weekday" ? values.nthWeekday : null,
    endsMode: values.endsMode,
    endsOn: values.endsMode === "on" ? values.endsOn || null : null,
    endsCount: values.endsMode === "after" ? values.endsCount : null,
  };
}

function toPayload(values: SeriesFormValues) {
  return {
    title: values.title,
    description: values.description,
    startsOn: values.startsOn,
    deadlineTime: values.deadlineTime,
    rule: toRulePayload(values),
  };
}

/** The payload for `series.create`, or the messages to show instead. */
export function buildSeriesInput(
  values: SeriesFormValues,
): SeriesFormResult<SeriesCreateInput> {
  const parsed = seriesInput.safeParse(toPayload(values));
  if (!parsed.success) {
    return { ok: false, errors: errorsFromIssues(parsed.error.issues) };
  }
  return { ok: true, data: parsed.data as SeriesCreateInput };
}

/**
 * The payload for `series.update` — a **replacement**, not a patch.
 *
 * Unlike `buildUpdatePatch` in `task-form.ts`, which sends only what changed.
 * A rule is one value: `normaliseRule` and `serialize` both take all ten fields
 * together, so a partial rule cannot be normalised without inventing the missing
 * half. The editor holds the whole rule anyway.
 */
export function buildSeriesUpdateInput(
  values: SeriesFormValues,
  id: string,
): SeriesFormResult<SeriesUpdateInput> {
  const parsed = seriesUpdateInput.safeParse({ id, ...toPayload(values) });
  if (!parsed.success) {
    return { ok: false, errors: errorsFromIssues(parsed.error.issues) };
  }
  return { ok: true, data: parsed.data as SeriesUpdateInput };
}
