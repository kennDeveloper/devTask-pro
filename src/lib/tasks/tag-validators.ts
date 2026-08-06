/**
 * The boundary schema for a tag, and the copy that goes with it.
 *
 * Same shape as `./validators.ts` and `./series-validators.ts`: field schemas and
 * message constants as pure exports, nothing inline in JSX. The tag router
 * validates with these and the manager reuses them, so the sentence a user reads
 * before the round trip is the one the server would have produced.
 *
 * **Zod is the polite half; the database is the boundary.** Every rule mirrors a
 * constraint in `supabase/migrations/0007_tags.sql` — name 1..40 after trimming,
 * colour from the six `Badge` tones, and uniqueness per user *case-insensitively*.
 * If the two disagree the constraint wins, loudly.
 */

import { z } from "zod";

import { TAG_COLORS } from "@/lib/db/schema";

/** Mirrors `check (length(btrim(name)) between 1 and 40)`. */
export const TAG_NAME_MAX_LENGTH = 40;

/** The exact strings the manager renders. Tests assert against these. */
export const TAG_MESSAGES = {
  nameRequired: "Give the tag a name.",
  nameTooLong: `Use ${TAG_NAME_MAX_LENGTH} characters or fewer.`,
  colorInvalid: "Choose a colour from the list.",
  duplicate: "You already have a tag with that name.",
  nothingToUpdate: "Provide at least one field to update.",
} as const;

/**
 * The form of a name that decides whether two tags are the same one.
 *
 * `lower(btrim(name))` — character for character what `tags_user_name_uniq` in
 * 0007 indexes on. Exported because the manager needs to compare a draft against
 * the tags already on screen to warn *before* the round trip, and a second
 * spelling of "the same tag" is how that warning starts disagreeing with the
 * error the database returns.
 */
export function normaliseTagName(name: string): string {
  return name.trim().toLowerCase();
}

/** True when `name` collides with one of `existing`, ignoring `exceptId`. */
export function isDuplicateTagName(
  name: string,
  existing: ReadonlyArray<{ id: string; name: string }>,
  exceptId?: string,
): boolean {
  const target = normaliseTagName(name);
  return existing.some(
    (tag) => tag.id !== exceptId && normaliseTagName(tag.name) === target,
  );
}

export const tagIdField = z.uuid();

/**
 * Trimmed before length is judged, exactly as `length(btrim(name))` does —
 * otherwise "   " passes a `min(1)` here and fails the constraint there.
 */
export const tagNameField = z
  .string({ error: TAG_MESSAGES.nameRequired })
  .trim()
  .min(1, { error: TAG_MESSAGES.nameRequired })
  .max(TAG_NAME_MAX_LENGTH, { error: TAG_MESSAGES.nameTooLong });

/** A `Badge` tone name. Never a hex — see the note on `TAG_COLORS`. */
export const tagColorField = z.enum(TAG_COLORS, {
  error: TAG_MESSAGES.colorInvalid,
});

/** Input for `tag.create`. Colour is optional; the column defaults to neutral. */
export const tagInput = z.object({
  name: tagNameField,
  color: tagColorField.optional(),
});

/**
 * Input for `tag.update` — a patch. Renaming and recolouring are separate
 * gestures in the manager, so neither should have to round-trip the other.
 */
export const tagUpdateInput = z
  .object({
    id: tagIdField,
    name: tagNameField.optional(),
    color: tagColorField.optional(),
  })
  .refine((value) => value.name !== undefined || value.color !== undefined, {
    error: TAG_MESSAGES.nothingToUpdate,
  });

/**
 * The tags to attach to a task or a series, as a whole set.
 *
 * A replacement rather than add/remove deltas: the picker holds the full
 * selection anyway, and a delta API would need the client to know which links
 * already exist — which is a second source of truth for something the server can
 * simply be told.
 *
 * De-duplicated here so `setForOccurrence` can insert without worrying about it,
 * and capped because the picker is a list of checkboxes rather than a search.
 */
export const tagIdsField = z
  .array(tagIdField)
  .max(50)
  .optional()
  .transform((value) => (value === undefined ? undefined : [...new Set(value)]));

export type TagInput = z.output<typeof tagInput>;
export type TagUpdateInput = z.output<typeof tagUpdateInput>;
