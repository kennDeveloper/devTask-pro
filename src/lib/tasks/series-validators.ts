/**
 * The boundary schema for a repeat rule, and the copy that goes with it.
 *
 * Same job and same shape as `./validators.ts` does for a one-off task: field
 * schemas and message constants as pure exports, nothing inline in JSX.
 * `src/lib/trpc/routers/series.ts` validates every mutation with the schemas
 * below and the editor reuses the very same ones, so the sentence a user reads
 * before the round trip is the sentence the server would have produced.
 *
 * **Zod is the polite half; the database is the boundary.** Every rule here
 * mirrors a constraint in `supabase/migrations/0005_task_series.sql` — the four
 * frequencies, interval 1..365, the six cross-column rules, `ends_on >=
 * starts_on`. If the two ever disagree the constraint wins, loudly, which is the
 * correct failure. What Zod buys is a message naming the field instead of
 * `task_series_month_day_required_check`.
 */

import { z } from "zod";

import {
  ENDS_MODES,
  MONTH_MODES,
  NTH_WEEKS,
  RECURRENCE_FREQUENCIES,
  WEEKDAYS,
} from "@/lib/db/schema";
import { normaliseRule, type RecurrenceRule } from "@/lib/recurrence/rule";

import {
  isCalendarDate,
  taskDescriptionField,
  taskIdField,
  taskReminderLeadField,
  taskTitleField,
} from "./validators";

/** Mirrors `check (interval between 1 and 365)` in 0005. */
export const INTERVAL_MIN = 1;
export const INTERVAL_MAX = 365;

/** Mirrors `check (ends_count between 1 and 365)` in 0005. */
export const ENDS_COUNT_MIN = 1;
export const ENDS_COUNT_MAX = 365;

/** The exact strings the editor renders. Tests assert against these. */
export const SERIES_MESSAGES = {
  freqInvalid: "Choose how often it repeats.",
  intervalOutOfRange: `Repeat every ${INTERVAL_MIN} to ${INTERVAL_MAX}.`,
  intervalNotWhole: "Use a whole number.",
  weekdaysRequired: "Pick at least one day of the week.",
  weekdayInvalid: "That is not a day of the week.",
  monthModeRequired: "Choose how the monthly repeat is worked out.",
  monthDayRequired: "Choose a day of the month.",
  monthDayOutOfRange: "Days of the month run from 1 to 31.",
  nthWeekRequired: "Choose which week of the month.",
  nthWeekdayRequired: "Choose a day of the week.",
  startsOnInvalid: "Choose a valid start date.",
  deadlineTimeInvalid: "Use a time like 09:00.",
  endsOnRequired: "Choose the date it stops on.",
  endsOnInvalid: "Choose a valid end date.",
  endsOnBeforeStart: "The end date cannot be before the start date.",
  endsCountRequired: "Choose how many times it repeats.",
  endsCountOutOfRange: `Repeat between ${ENDS_COUNT_MIN} and ${ENDS_COUNT_MAX} times.`,
} as const;

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

/** A `date` column read as a string — never a `Date`. See `./validators.ts`. */
export const seriesStartsOnField = z
  .string({ error: SERIES_MESSAGES.startsOnInvalid })
  .refine(isCalendarDate, { error: SERIES_MESSAGES.startsOnInvalid });

/**
 * `HH:MM`, a wall clock with no zone.
 *
 * Accepts `HH:MM:SS` too and normalises it away, because that is the spelling
 * Postgres reads a `time` column back as — so a value that has been to the
 * database and returned still validates without the caller trimming it. `""`
 * collapses to `null`, exactly as an emptied `<textarea>` does in
 * `taskDescriptionField`: a column with two spellings of "no deadline" is a
 * column every later `is null` check has to know about.
 */
export const seriesDeadlineTimeField = z
  .string()
  .trim()
  .nullable()
  .optional()
  .transform((value) => {
    if (value === undefined) return undefined;
    return value ? value : null;
  })
  .refine(
    (value) => value == null || /^\d{2}:\d{2}(:\d{2})?$/.test(value),
    { error: SERIES_MESSAGES.deadlineTimeInvalid },
  )
  .transform((value) => (value == null ? value : value.slice(0, 5)));

const freqField = z.enum(RECURRENCE_FREQUENCIES, {
  error: SERIES_MESSAGES.freqInvalid,
});

const intervalField = z
  .number({ error: SERIES_MESSAGES.intervalOutOfRange })
  .int({ error: SERIES_MESSAGES.intervalNotWhole })
  .min(INTERVAL_MIN, { error: SERIES_MESSAGES.intervalOutOfRange })
  .max(INTERVAL_MAX, { error: SERIES_MESSAGES.intervalOutOfRange });

const byweekdayField = z
  .array(z.enum(WEEKDAYS, { error: SERIES_MESSAGES.weekdayInvalid }))
  .default([]);

const monthDayField = z
  .number({ error: SERIES_MESSAGES.monthDayOutOfRange })
  .int({ error: SERIES_MESSAGES.monthDayOutOfRange })
  .min(1, { error: SERIES_MESSAGES.monthDayOutOfRange })
  .max(31, { error: SERIES_MESSAGES.monthDayOutOfRange })
  .nullable()
  .default(null);

const nthWeekField = z
  .union(
    NTH_WEEKS.map((value) => z.literal(value)) as [
      z.ZodLiteral<1>,
      z.ZodLiteral<2>,
      z.ZodLiteral<3>,
      z.ZodLiteral<4>,
      z.ZodLiteral<-1>,
    ],
    { error: SERIES_MESSAGES.nthWeekRequired },
  )
  .nullable()
  .default(null);

const endsCountField = z
  .number({ error: SERIES_MESSAGES.endsCountOutOfRange })
  .int({ error: SERIES_MESSAGES.endsCountOutOfRange })
  .min(ENDS_COUNT_MIN, { error: SERIES_MESSAGES.endsCountOutOfRange })
  .max(ENDS_COUNT_MAX, { error: SERIES_MESSAGES.endsCountOutOfRange })
  .nullable()
  .default(null);

/**
 * The rule itself, before the cross-field rules are applied.
 *
 * Nested under one key rather than flattened into the series payload because it
 * is one value: `normaliseRule` takes all ten fields together, `serialize` takes
 * all ten together, and a caller that could send half of them would be able to
 * express a rule the columns cannot hold.
 */
export const recurrenceRuleInput = z.object({
  freq: freqField,
  interval: intervalField.default(1),
  byweekday: byweekdayField,
  monthMode: z
    .enum(MONTH_MODES, { error: SERIES_MESSAGES.monthModeRequired })
    .nullable()
    .default(null),
  monthDay: monthDayField,
  nthWeek: nthWeekField,
  nthWeekday: z
    .enum(WEEKDAYS, { error: SERIES_MESSAGES.nthWeekdayRequired })
    .nullable()
    .default(null),
  endsMode: z.enum(ENDS_MODES).default("never"),
  endsOn: z
    .string()
    .refine(isCalendarDate, { error: SERIES_MESSAGES.endsOnInvalid })
    .nullable()
    .default(null),
  endsCount: endsCountField,
});

// ---------------------------------------------------------------------------
// The cross-field rules — the polite half of 0005's six CHECK constraints
// ---------------------------------------------------------------------------

/**
 * Everything the database's cross-column CHECKs enforce, said in English.
 *
 * Written as a `superRefine` over the whole object rather than as per-field
 * rules, because every one of them is a relationship: "a monthly rule needs a
 * mode" is not a fact about `monthMode` on its own. The paths are set so the
 * editor can attach each message to the control the user has to change.
 *
 * `weekdaysRequired` is the one rule here that the database does *not* enforce
 * — 0005 allows an empty `byweekday` on a weekly rule because RFC 5545 gives it
 * a meaning ("the weekday DTSTART falls on") and `expand()` honours it. The
 * editor cannot express that, so a weekly rule arriving with no days is a form
 * the user has not finished rather than a rule they meant.
 */
function checkRule(
  rule: z.output<typeof recurrenceRuleInput>,
  ctx: z.RefinementCtx,
  prefix: readonly PropertyKey[] = [],
): void {
  const at = (...path: PropertyKey[]) => [...prefix, ...path];

  if (rule.freq === "weekly" && rule.byweekday.length === 0) {
    ctx.addIssue({
      code: "custom",
      path: at("byweekday"),
      message: SERIES_MESSAGES.weekdaysRequired,
    });
  }

  if (rule.freq === "monthly") {
    if (rule.monthMode === null) {
      ctx.addIssue({
        code: "custom",
        path: at("monthMode"),
        message: SERIES_MESSAGES.monthModeRequired,
      });
    }
    if (rule.monthMode === "by_date" && rule.monthDay === null) {
      ctx.addIssue({
        code: "custom",
        path: at("monthDay"),
        message: SERIES_MESSAGES.monthDayRequired,
      });
    }
    if (rule.monthMode === "by_nth_weekday") {
      if (rule.nthWeek === null) {
        ctx.addIssue({
          code: "custom",
          path: at("nthWeek"),
          message: SERIES_MESSAGES.nthWeekRequired,
        });
      }
      if (rule.nthWeekday === null) {
        ctx.addIssue({
          code: "custom",
          path: at("nthWeekday"),
          message: SERIES_MESSAGES.nthWeekdayRequired,
        });
      }
    }
  }

  if (rule.endsMode === "on" && rule.endsOn === null) {
    ctx.addIssue({
      code: "custom",
      path: at("endsOn"),
      message: SERIES_MESSAGES.endsOnRequired,
    });
  }

  if (rule.endsMode === "after" && rule.endsCount === null) {
    ctx.addIssue({
      code: "custom",
      path: at("endsCount"),
      message: SERIES_MESSAGES.endsCountRequired,
    });
  }
}

const seriesFields = {
  title: taskTitleField,
  description: taskDescriptionField,
  startsOn: seriesStartsOnField,
  deadlineTime: seriesDeadlineTimeField,
  /**
   * The template lead. Seeded onto an occurrence at materialisation and owned by
   * the row thereafter, like every other series field — so editing it here
   * changes future untouched occurrences only. The same schema the one-off path
   * uses, imported rather than restated.
   */
  reminderLeadMinutes: taskReminderLeadField,
  rule: recurrenceRuleInput,
};

/**
 * `ends_on >= starts_on` — the one rule that crosses the rule and the series.
 *
 * A series that ends before it begins names no dates at all, which is a typo
 * rather than an intention. `task_series_ends_on_after_start_check` says the
 * same thing in SQL.
 */
function checkSeries(
  value: { startsOn: string; rule: z.output<typeof recurrenceRuleInput> },
  ctx: z.RefinementCtx,
): void {
  checkRule(value.rule, ctx, ["rule"]);

  if (
    value.rule.endsMode === "on" &&
    value.rule.endsOn !== null &&
    value.rule.endsOn < value.startsOn
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["rule", "endsOn"],
      message: SERIES_MESSAGES.endsOnBeforeStart,
    });
  }
}

/** Input for `series.create`. */
export const seriesInput = z.object(seriesFields).superRefine(checkSeries);

/**
 * Input for `series.update` — a **replacement**, not a patch.
 *
 * Deliberately unlike `taskUpdateInput`. A rule is one value: `normaliseRule`
 * and `serialize` both take all ten fields together, and a partial rule cannot
 * be normalised without inventing the missing half — which is how the typed
 * columns and the stored `rrule` end up describing different rules. The editor
 * holds the whole rule in state anyway, so sending it costs nothing.
 */
export const seriesUpdateInput = z
  .object({ id: taskIdField, ...seriesFields })
  .superRefine(checkSeries);

export type SeriesInput = z.output<typeof seriesInput>;
export type SeriesUpdateInput = z.output<typeof seriesUpdateInput>;

/**
 * The validated rule as the engine's own type, with the irrelevant fields
 * cleared.
 *
 * The bridge between "what a client may send" and "what the database will
 * store": Zod proves each field is in range, `normaliseRule` decides which of
 * them the chosen frequency actually uses. Running it here, once, is what stops
 * every caller having to remember that a monthly rule must not carry weekdays.
 */
export function toRecurrenceRule(
  input: z.output<typeof recurrenceRuleInput>,
): RecurrenceRule {
  return normaliseRule({
    freq: input.freq,
    interval: input.interval,
    byweekday: input.byweekday,
    monthMode: input.monthMode,
    monthDay: input.monthDay,
    nthWeek: input.nthWeek,
    nthWeekday: input.nthWeekday,
    endsMode: input.endsMode,
    endsOn: input.endsOn,
    endsCount: input.endsCount,
  });
}
