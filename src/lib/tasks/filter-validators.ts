/**
 * The boundary schema for the search box and the three filter controls.
 *
 * Separate from `./filters.ts` on purpose. That module is the *definition* — a
 * pure predicate and its SQL twin — and it is imported by
 * `src/lib/db/repos/occurrences.ts`. Putting a Zod schema there would drag the
 * validator into the repo layer for no reason; putting the predicate here would
 * drag Zod into a module that wants to stay dependency-light. One holds the
 * meaning, the other holds what a client is allowed to send.
 */

import { z } from "zod";

import { TASK_STATUSES } from "@/lib/db/schema";

import { isCalendarDate } from "./validators";
import { tagIdField } from "./tag-validators";

/** Long enough for a sentence, short enough that nobody pastes a document. */
export const SEARCH_MAX_LENGTH = 200;

export const FILTER_MESSAGES = {
  searchTooLong: `Use ${SEARCH_MAX_LENGTH} characters or fewer.`,
  dateInvalid: "Choose a valid date.",
  rangeBackwards: "The end date cannot be before the start date.",
} as const;

const filterDateField = z
  .string()
  .refine(isCalendarDate, { error: FILTER_MESSAGES.dateInvalid })
  .optional();

/**
 * What the client may ask to filter by.
 *
 * Every field optional, because every one is a control the user may not have
 * touched. `statuses` and `tagIds` are arrays because both controls are
 * multi-select and both are OR-ed within — see `./filters.ts`.
 *
 * The whitespace trim happens here as well as in `hasAnyFilter` so that a search
 * of `"   "` arrives as `""` and is treated as no search at all, rather than as
 * a filter matching every title that contains a space.
 */
export const taskFiltersInput = z
  .object({
    search: z
      .string()
      .max(SEARCH_MAX_LENGTH, { error: FILTER_MESSAGES.searchTooLong })
      .trim()
      .optional(),
    statuses: z.array(z.enum(TASK_STATUSES)).max(TASK_STATUSES.length).optional(),
    from: filterDateField,
    to: filterDateField,
    tagIds: z.array(tagIdField).max(50).optional(),
  })
  .refine(
    (value) => !value.from || !value.to || value.from <= value.to,
    { error: FILTER_MESSAGES.rangeBackwards, path: ["to"] },
  );

export type TaskFiltersInput = z.output<typeof taskFiltersInput>;
