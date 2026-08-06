/**
 * The progress percentage, and the one thing it must never learn about.
 *
 * ============================================================================
 * PROGRESS IS INDEPENDENT OF STATUS. NOTHING IN THIS FILE IMPORTS `status.ts`.
 * ============================================================================
 *
 * A `done` task may sit at 40%, and both facts have to survive — that is
 * acceptance criterion 12, and it is a product decision, not an oversight.
 * Someone marks a task done because they have stopped working on it; the 40%
 * is how far they actually got, and it is the more interesting number of the
 * two. The tempting "helpers" are therefore forbidden here:
 *
 *   - nothing coerces progress to 100 when status becomes `done`
 *   - nothing flips status to `done` when progress reaches 100
 *   - nothing derives one from the other in either direction
 *
 * The missing import above is what keeps that true: a future edit that wants
 * to couple them has to add a dependency this comment says not to add, rather
 * than quietly extending a function that already had both values in scope.
 *
 * The bounds themselves mirror `check (progress_pct between 0 and 100)` in
 * `supabase/migrations/0004_task_occurrence.sql`. The database is the boundary;
 * these constants exist so the slider and the Zod schema agree with it.
 */

/** Inclusive. 0 is a real, saveable value — not "unset". */
export const PROGRESS_MIN = 0;

/** Inclusive, and *not* a synonym for done. See the header. */
export const PROGRESS_MAX = 100;

/**
 * True for a value the column would accept.
 *
 * Integral is part of the contract: `progress_pct` is an `integer`, so 42.5
 * would be silently rounded by the driver and the value read back would not be
 * the value sent. Rejecting it here means the user is told, rather than
 * surprised.
 */
export function isValidProgress(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= PROGRESS_MIN &&
    value <= PROGRESS_MAX
  );
}

/**
 * The nearest value the column would accept.
 *
 * For display and for controls, never as a substitute for validation — a
 * mutation payload goes through `taskProgressField` in `./validators`, which
 * rejects out-of-range input instead of silently rewriting it. Clamping a
 * *submitted* 101 to 100 would save something the user did not ask for.
 *
 * `NaN` collapses to `PROGRESS_MIN`, because an empty or half-typed numeric
 * input evaluates to `NaN` and a slider positioned at "not a number" renders
 * as nothing at all.
 */
export function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return PROGRESS_MIN;
  return Math.min(PROGRESS_MAX, Math.max(PROGRESS_MIN, Math.round(value)));
}

/**
 * The readout next to the slider, in the table cell, and on the mobile card.
 *
 * Three renderers, one string — the alternative is `{pct}%` written out three
 * times and one of them eventually growing a space or a decimal.
 */
export function formatProgress(value: number): string {
  return `${clampProgress(value)}%`;
}
