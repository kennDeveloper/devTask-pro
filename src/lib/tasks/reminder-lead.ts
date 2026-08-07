/**
 * The reminder lead time — how far before a deadline the email goes out.
 *
 * Same job `progress.ts` does for the percentage: the bounds mirror a `check`
 * constraint, and they live here so the select, the Zod schema and the reminder
 * job all agree with the database rather than each restating a number.
 *
 * The bounds mirror `check (reminder_lead_minutes is null or … between 0 and
 * 10080)` in `0005_task_series.sql` and `0007_reminders.sql`. **NULL is the off
 * switch**, and it is the default — a task reminds only because somebody asked
 * it to.
 *
 * ## Why the shortest offered preset is 15 minutes and not 5, or 1
 *
 * The job sends inside `[deadline − lead, deadline)` — a reminder that missed
 * its moment is skipped rather than delivered late — and the cron runs every 5
 * minutes. A lead shorter than the cadence would give the job a window it can
 * step straight over, so the reminder would fire or not depending on where the
 * tick landed. At 15 minutes the window always contains at least two runs.
 *
 * The *column* still accepts anything from 0 to a week, so a free-text control
 * or a shorter cadence later is additive and needs no migration. What is
 * constrained here is only what the UI offers.
 */

/** Inclusive. 0 means "at the deadline itself", not "no reminder". */
export const REMINDER_LEAD_MIN = 0;

/** Inclusive — one week, matching both `check` constraints. */
export const REMINDER_LEAD_MAX = 10_080;

/**
 * The cron cadence, in minutes, as declared in `vercel.json`.
 *
 * Here rather than in the job because it is the reason the preset list starts
 * where it does — the two numbers are related and should be read together.
 */
export const REMINDER_CADENCE_MINUTES = 5;

export interface ReminderPreset {
  /** Minutes before the deadline, or `null` for no reminder. */
  value: number | null;
  label: string;
}

/**
 * What the dialogs offer, in order. `null` first because it is the default and
 * the way back out.
 */
export const REMINDER_PRESETS: readonly ReminderPreset[] = [
  { value: null, label: "No reminder" },
  { value: 15, label: "15 minutes before" },
  { value: 30, label: "30 minutes before" },
  { value: 60, label: "1 hour before" },
  { value: 1440, label: "1 day before" },
] as const;

/**
 * True for a value the column would accept.
 *
 * Integral is part of the contract, for the reason `isProgress` gives: the
 * column is an `integer`, so 42.5 would be silently rounded by the driver and
 * the value read back would not be the value sent.
 *
 * Deliberately wider than `REMINDER_PRESETS` — the boundary's job is to mirror
 * the constraint, not to enforce the menu. A payload of 45 is a legitimate lead
 * that no preset happens to offer, and rejecting it here would make the schema
 * disagree with the database it exists to mirror.
 */
export function isReminderLead(value: number): boolean {
  return (
    Number.isInteger(value) &&
    value >= REMINDER_LEAD_MIN &&
    value <= REMINDER_LEAD_MAX
  );
}

/**
 * The label for a stored lead, for a control that has to render a value the
 * preset list may not contain — an older task, or one written through the API.
 */
export function reminderLeadLabel(value: number | null): string {
  const preset = REMINDER_PRESETS.find((option) => option.value === value);
  if (preset) return preset.label;

  return value === 1 ? "1 minute before" : `${value} minutes before`;
}
