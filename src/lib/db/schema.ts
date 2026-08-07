/**
 * Drizzle schema — a TYPED MIRROR, not the source of truth.
 *
 * ============================================================================
 * THE SQL IS AUTHORITATIVE. THIS FILE FOLLOWS IT, BY HAND.
 * ============================================================================
 *
 * The real schema lives in `supabase/migrations/*.sql`, hand-written and numbered.
 * This file exists so application code gets types and a query builder — nothing more.
 *
 * When you change the schema:
 *   1. Write a new numbered migration in `supabase/migrations/`.
 *   2. Run `pnpm db:reset` to apply it.
 *   3. Update this file by hand to match.
 *
 * NEVER run `drizzle-kit generate` to author DDL. `drizzle.config.ts` points `out` at
 * the migrations directory purely so `db:generate` can be used as a diff-check, and
 * drizzle-kit cannot express the parts of this schema that matter most anyway:
 * the `security definer` trigger on `auth.users`, the RLS policies, or the
 * self-promotion guard trigger.
 *
 * Things present in the SQL that intentionally have no representation below, because
 * Drizzle has no vocabulary for them — read the migrations for these:
 *   - `profiles.id` is `references auth.users(id) on delete cascade`  (0001)
 *   - `handle_new_user()` / `touch_updated_at()` triggers              (0002)
 *   - RLS, the grants, and `guard_profile_privileged_columns()`        (0003)
 *   - RLS + grants on `task_occurrence`, `sync_task_completed_at()`,
 *     and the partial index behind `task_occurrence_user_deadline_idx` (0004)
 *   - RLS + grants on `task_series`, its six cross-column CHECKs, the
 *     partial index behind `task_series_user_live_idx`, and the partial
 *     unique index `task_occurrence_series_day_uniq`                    (0005)
 *   - RLS + grants on `tags`, `series_tags` and `occurrence_tags`, and the
 *     functional unique index `tags_user_name_uniq` on
 *     `(user_id, lower(btrim(name)))`                                    (0006)
 *   - RLS on `reminder_log` — and note it has only TWO policies and only
 *     `select, insert` granted, because it is an append-only ledger; the
 *     two partial unique indexes behind its two identities                (0007)
 */

import { sql } from "drizzle-orm";
import {
  check,
  date,
  foreignKey,
  index,
  integer,
  pgSchema,
  pgTable,
  primaryKey,
  text,
  time,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

/**
 * `auth.users` — Supabase's own table, mirrored READ-ONLY and only far enough to
 * read one column.
 *
 * ============================================================================
 * THIS IS NOT OURS. NEVER WRITE TO IT. NEVER RUN `drizzle-kit generate` ON IT.
 * ============================================================================
 *
 * The auth service owns this table and we do not get to add columns to it —
 * that is why `public.profiles` exists at all (see 0001). It appears here for
 * exactly one reason: the admin account list shows **last sign-in**, and that
 * fact lives nowhere else. Copying it into `profiles` would mean a trigger, a
 * column and a migration to keep a value in sync that we can simply join to.
 *
 * Two facts, both measured against the local stack rather than assumed:
 *
 *   - `dbAdmin` connects as `postgres`, which **can** select from `auth.users`.
 *   - The `authenticated` role **cannot** — `permission denied for table users`.
 *
 * So this column is unreachable from every user-facing path by construction,
 * with no policy for us to write and nothing to get wrong. The only consumer is
 * `listAccountsAsAdmin` / `findAccountAsAdmin` in `repos/profiles.ts`.
 *
 * Only the columns actually read are declared. A fuller mirror would be a
 * standing invitation to reach for one of them, and `drizzle-kit generate` —
 * which this project never runs to author DDL — would try to emit the `auth`
 * schema as if we owned it.
 */
const authSchema = pgSchema("auth");

export const authUsers = authSchema.table("users", {
  id: uuid("id").primaryKey(),
  /** Maintained by GoTrue on every successful sign-in. Null until the first one. */
  lastSignInAt: timestamp("last_sign_in_at", { withTimezone: true }),
});

/** The four account states the access gate routes on. Mirrors the CHECK in 0001. */
export const PROFILE_STATUSES = [
  "pending",
  "active",
  "rejected",
  "suspended",
] as const;
export type ProfileStatus = (typeof PROFILE_STATUSES)[number];

/** Mirrors the CHECK in 0001. `admin` governs access only; it never defeats RLS. */
export const PROFILE_ROLES = ["member", "admin"] as const;
export type ProfileRole = (typeof PROFILE_ROLES)[number];

/**
 * `public.profiles` — one row per auth user, created by the `handle_new_user`
 * trigger in 0002. See `supabase/migrations/0001_initial_schema.sql` for the
 * reasoning behind each column.
 */
export const profiles = pgTable(
  "profiles",
  {
    /**
     * Same uuid as `auth.users.id`. The FK and its `on delete cascade` are declared
     * in SQL — Drizzle cannot reference a table in the `auth` schema from here.
     */
    id: uuid("id").primaryKey(),
    email: text("email").notNull(),
    displayName: text("display_name"),
    timezone: text("timezone").notNull().default("UTC"),
    role: text("role").notNull().default("member").$type<ProfileRole>(),
    status: text("status").notNull().default("pending").$type<ProfileStatus>(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: uuid("approved_by").references(
      (): AnyPgColumn => profiles.id,
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("profiles_status_idx").on(table.status),
    check("profiles_role_check", sql`${table.role} in ('member', 'admin')`),
    check(
      "profiles_status_check",
      sql`${table.status} in ('pending', 'active', 'rejected', 'suspended')`,
    ),
  ],
);

export type Profile = typeof profiles.$inferSelect;
export type NewProfile = typeof profiles.$inferInsert;

/** The three states a task moves between. Mirrors the CHECK in 0004. Freely reversible. */
export const TASK_STATUSES = ["todo", "in_progress", "done"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

// ---------------------------------------------------------------------------
// The recurrence vocabulary
// ---------------------------------------------------------------------------
//
// Declared here rather than in `src/lib/recurrence/` for the reason
// `src/lib/tasks/status.ts` gives about `TASK_STATUSES`: each of these mirrors a
// `check (col in (...))` in `0005_task_series.sql`, and that CHECK is the actual
// authority. A second literal list in the engine would be one more place to
// forget when a value is added — so the engine imports these and owns only what
// the database has no opinion about (what the words mean, what order they go in,
// which dates they name).

/** Mirrors `check (freq in (...))` in 0005. */
export const RECURRENCE_FREQUENCIES = [
  "daily",
  "weekly",
  "monthly",
  "yearly",
] as const;
export type RecurrenceFrequency = (typeof RECURRENCE_FREQUENCIES)[number];

/**
 * RFC 5545 `BYDAY` codes, in ISO week order (Monday first).
 *
 * The order is load-bearing, not cosmetic: `WEEKDAYS.indexOf(code)` is how the
 * expander turns a code into a day-of-week offset from the start of an ISO week,
 * and RFC 5545's default `WKST` is `MO`. Reordering this to put Sunday first
 * would silently shift every weekly rule by a day.
 */
export const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/**
 * The two monthly rules. Mirrors `check (month_mode in (...))` in 0005.
 *
 * They are genuinely different questions — "the 15th" and "the last Friday" pick
 * different dates in every month, and neither is derivable from the other.
 */
export const MONTH_MODES = ["by_date", "by_nth_weekday"] as const;
export type MonthMode = (typeof MONTH_MODES)[number];

/** The five end conditions collapse to three modes. Mirrors 0005's CHECK. */
export const ENDS_MODES = ["never", "on", "after"] as const;
export type EndsMode = (typeof ENDS_MODES)[number];

/** `-1` is "last". Mirrors `check (nth_week in (1, 2, 3, 4, -1))` in 0005. */
export const NTH_WEEKS = [1, 2, 3, 4, -1] as const;
export type NthWeek = (typeof NTH_WEEKS)[number];

/**
 * `public.task_series` — a repeat rule.
 *
 * A series names dates. It carries no status, no progress and no completion:
 * the trackable unit is still a `task_occurrence`, and one is written the first
 * time somebody touches a particular date. See
 * `supabase/migrations/0005_task_series.sql` for the reasoning behind every
 * column, and for the RLS policies that keep a series as private as the
 * occurrences it produces.
 *
 * Three things below are load-bearing and easy to "tidy" wrongly:
 *
 * - **`startsOn` and `endsOn` are `date` in `mode: "string"`**, like `occursOn` —
 *   bare `YYYY-MM-DD` calendar squares, never `Date`s with a time and a zone
 *   attached.
 * - **`deadlineTime` is a bare `time`**, a wall-clock reading with no zone. The
 *   instant is computed per occurrence by resolving it in the owner's timezone,
 *   which is what makes 09:00 stay 09:00 across a DST transition (criterion 20).
 * - **`rrule` is derived, never input.** `src/lib/recurrence/serialize.ts`
 *   produces it from the columns above it. Writing it by hand would let the
 *   string and the columns describe different rules.
 */
export const taskSeries = pgTable(
  "task_series",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** FK to `profiles.id`, which is also the auth user id. Cascades on delete. */
    userId: uuid("user_id")
      .notNull()
      .references((): AnyPgColumn => profiles.id, { onDelete: "cascade" }),

    title: text("title").notNull(),
    description: text("description"),

    freq: text("freq").notNull().$type<RecurrenceFrequency>(),
    interval: integer("interval").notNull().default(1),
    /**
     * WEEKLY only, and empty for every other frequency — 0005 enforces that with
     * `task_series_weekly_days_check`. An empty array on a weekly rule means
     * "the weekday `startsOn` falls on", per RFC 5545.
     */
    byweekday: text("byweekday")
      .array()
      .notNull()
      .$type<Weekday[]>()
      .default(sql`'{}'::text[]`),

    monthMode: text("month_mode").$type<MonthMode>(),
    monthDay: integer("month_day"),
    nthWeek: integer("nth_week").$type<NthWeek>(),
    nthWeekday: text("nth_weekday").$type<Weekday>(),

    startsOn: date("starts_on", { mode: "string" }).notNull(),
    /** `HH:MM:SS` wall clock, or null for "these occurrences have no deadline". */
    deadlineTime: time("deadline_time"),

    endsMode: text("ends_mode").notNull().default("never").$type<EndsMode>(),
    endsOn: date("ends_on", { mode: "string" }),
    endsCount: integer("ends_count"),

    rrule: text("rrule").notNull(),
    /** Phase 6. Declared so adding it later is not a second policy migration. */
    reminderLeadMinutes: integer("reminder_lead_minutes"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Soft delete — a deleted series is never expanded; its rows survive. */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    // The real index in 0005 is partial (`where deleted_at is null`). Drizzle
    // cannot express that here; this entry exists so the mirror names the index,
    // not so it could recreate it.
    index("task_series_user_live_idx").on(table.userId),
    check(
      "task_series_freq_check",
      sql`${table.freq} in ('daily', 'weekly', 'monthly', 'yearly')`,
    ),
    check(
      "task_series_interval_check",
      sql`${table.interval} between 1 and 365`,
    ),
    check(
      "task_series_month_mode_check",
      sql`${table.monthMode} in ('by_date', 'by_nth_weekday')`,
    ),
    check(
      "task_series_ends_mode_check",
      sql`${table.endsMode} in ('never', 'on', 'after')`,
    ),
    // The six cross-column CHECKs in 0005 (monthly ⇔ month_mode, by_date ⇔
    // month_day, by_nth_weekday ⇔ nth_week + nth_weekday, weekdays ⇒ weekly, the
    // ends triple, and ends_on >= starts_on) have no representation here.
    // Drizzle's `check` can hold the expression, but they are the part of this
    // table most worth reading in SQL — see the migration.
  ],
);

export type TaskSeries = typeof taskSeries.$inferSelect;
export type NewTaskSeries = typeof taskSeries.$inferInsert;

/**
 * `public.task_occurrence` — the trackable unit of work.
 *
 * A one-off task is a row with `seriesId = null`, which is every row phase 2 writes.
 * See `supabase/migrations/0004_task_occurrence.sql` for the reasoning behind each
 * column, and for the RLS policies that are the actual product guarantee.
 *
 * Two things below are load-bearing and easy to "tidy" wrongly:
 *
 * - **`occursOn` is a `date`, read as a string.** `mode: "string"` keeps it a bare
 *   `YYYY-MM-DD` instead of letting the driver build a `Date`, which would attach a
 *   time and a zone to something that has neither. The day a task sits on must not
 *   shift because the process moved.
 * - **`deadlineAt` is `timestamptz`.** Overdue is `deadlineAt < now()`, an absolute
 *   comparison, so it is correct whatever the server's timezone (criterion 18).
 */
export const taskOccurrence = pgTable(
  "task_occurrence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** FK to `profiles.id`, which is also the auth user id. Cascades on delete. */
    userId: uuid("user_id")
      .notNull()
      .references((): AnyPgColumn => profiles.id, { onDelete: "cascade" }),
    /**
     * Null for a one-off, set for a materialised occurrence of a series.
     *
     * The FK and the partial unique index `(series_id, occurs_on) where
     * series_id is not null` were both added by 0005, against phase-2 data where
     * every value was NULL. The uniqueness is what `materialize()` targets with
     * ON CONFLICT, so first-touch is one statement that cannot race itself —
     * and it is partial so that one-off tasks, which all share `series_id IS
     * NULL`, are not caught by it.
     */
    seriesId: uuid("series_id").references((): AnyPgColumn => taskSeries.id, {
      onDelete: "cascade",
    }),
    title: text("title").notNull(),
    description: text("description"),
    occursOn: date("occurs_on", { mode: "string" }).notNull(),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }),
    status: text("status").notNull().default("todo").$type<TaskStatus>(),
    progressPct: integer("progress_pct").notNull().default(0),
    /**
     * Minutes before `deadline_at` to email a reminder, or null for none (0007).
     *
     * Seeded from the series at materialisation and independent thereafter —
     * the same rule every other series field follows. Bounded 0..10080 by a
     * `check` in the SQL, mirrored by `reminderLeadMinutesField` at the Zod
     * boundary.
     */
    reminderLeadMinutes: integer("reminder_lead_minutes"),
    /** Maintained by `sync_task_completed_at()` in 0004, never by application code. */
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("task_occurrence_user_day_idx").on(table.userId, table.occursOn),
    // The real index in 0004 is partial (`where deadline_at is not null and status
    // <> 'done'`). Drizzle cannot express that here; this entry exists so the mirror
    // names the index, not so it could recreate it.
    index("task_occurrence_user_deadline_idx").on(
      table.userId,
      table.deadlineAt,
    ),
    // Also partial in 0005 (`where series_id is not null`), which Drizzle cannot
    // express — named here so the mirror knows the constraint exists.
    uniqueIndex("task_occurrence_series_day_uniq").on(
      table.seriesId,
      table.occursOn,
    ),
    check(
      "task_occurrence_status_check",
      sql`${table.status} in ('todo', 'in_progress', 'done')`,
    ),
    check(
      "task_occurrence_progress_pct_check",
      sql`${table.progressPct} between 0 and 100`,
    ),
  ],
);

export type TaskOccurrence = typeof taskOccurrence.$inferSelect;
export type NewTaskOccurrence = typeof taskOccurrence.$inferInsert;

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

/**
 * The colours a tag may take. Mirrors `check (color in (...))` in 0006.
 *
 * **Tone names, not hex.** `AGENTS.md` forbids raw hex under `src/components/**`
 * and `src/app/**`; storing one in the database would smuggle it past that rule
 * into a place the dark theme cannot adjust. These six are exactly the tones
 * `src/components/ui/badge.tsx` implements, so a tag renders as a `Badge` with no
 * translation step.
 */
export const TAG_COLORS = [
  "neutral",
  "info",
  "success",
  "warning",
  "danger",
  "default",
] as const;
export type TagColor = (typeof TAG_COLORS)[number];

/**
 * `public.tags` — a user-defined label.
 *
 * Unique per user **case-insensitively**, which the SQL enforces with a
 * functional index on `(user_id, lower(btrim(name)))`. Drizzle cannot express a
 * functional index, so that constraint has no representation below — see 0006,
 * and `normaliseTagName` in `src/lib/tasks/tag-validators.ts` for the boundary
 * half of the same rule.
 */
export const tags = pgTable(
  "tags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references((): AnyPgColumn => profiles.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color").notNull().default("neutral").$type<TagColor>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("tags_user_idx").on(table.userId),
    /**
     * Redundant as a key — `id` is already unique — and deliberately so. It
     * exists because a composite foreign key needs a unique constraint covering
     * exactly the columns it references, and both join tables reference
     * `(id, user_id)` to carry ownership. See the long note in 0006.
     */
    unique("tags_id_user_key").on(table.id, table.userId),
    check(
      "tags_color_check",
      sql`${table.color} in ('neutral', 'info', 'success', 'warning', 'danger', 'default')`,
    ),
  ],
);

export type Tag = typeof tags.$inferSelect;
export type NewTag = typeof tags.$inferInsert;

/**
 * `public.series_tags` — a series' **template** tags.
 *
 * Copied onto an occurrence when it materialises, exactly as the series' title
 * and deadline time already are. Editing them afterwards does not reach back
 * into occurrences that already exist.
 *
 * ## The composite foreign keys are the security-relevant part
 *
 * A foreign key check does **not** consult RLS — it can see rows the caller
 * cannot. So referencing `series_id` and `tag_id` separately would let a
 * signed-in user write a link between their own tag and somebody else's series:
 * the insert policy is satisfied (`user_id = auth.uid()`), both keys resolve, and
 * a row lands in another person's data. Referencing `(id, user_id)` on both
 * parents makes "all three belong to the same person" something the database
 * enforces rather than something a policy is trusted for.
 */
export const seriesTags = pgTable(
  "series_tags",
  {
    userId: uuid("user_id").notNull(),
    seriesId: uuid("series_id").notNull(),
    tagId: uuid("tag_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.seriesId, table.tagId] }),
    foreignKey({
      columns: [table.seriesId, table.userId],
      foreignColumns: [taskSeries.id, taskSeries.userId],
      name: "series_tags_series_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tagId, table.userId],
      foreignColumns: [tags.id, tags.userId],
      name: "series_tags_tag_fk",
    }).onDelete("cascade"),
    index("series_tags_tag_idx").on(table.tagId),
    index("series_tags_user_idx").on(table.userId),
  ],
);

export type SeriesTag = typeof seriesTags.$inferSelect;
export type NewSeriesTag = typeof seriesTags.$inferInsert;

/**
 * `public.occurrence_tags` — an occurrence's own tags.
 *
 * Seeded from its series at materialisation and independent thereafter. Same
 * composite-FK reasoning as `series_tags` above.
 */
export const occurrenceTags = pgTable(
  "occurrence_tags",
  {
    userId: uuid("user_id").notNull(),
    occurrenceId: uuid("occurrence_id").notNull(),
    tagId: uuid("tag_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.occurrenceId, table.tagId] }),
    foreignKey({
      columns: [table.occurrenceId, table.userId],
      foreignColumns: [taskOccurrence.id, taskOccurrence.userId],
      name: "occurrence_tags_occurrence_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tagId, table.userId],
      foreignColumns: [tags.id, tags.userId],
      name: "occurrence_tags_tag_fk",
    }).onDelete("cascade"),
    index("occurrence_tags_tag_idx").on(table.tagId),
    index("occurrence_tags_user_idx").on(table.userId),
  ],
);

export type OccurrenceTag = typeof occurrenceTags.$inferSelect;
export type NewOccurrenceTag = typeof occurrenceTags.$inferInsert;

/**
 * `public.reminder_log` — the at-most-once ledger behind criteria 21 and 22.
 *
 * One row per reminder the job has claimed the right to send. Exactly one of
 * `seriesId` and `occurrenceId` is set (a `check` in 0007 Drizzle cannot
 * express), because a reminder is identified by *which occurrence it was about*
 * rather than by a row id:
 *
 *   a series occurrence  →  (series_id, occurs_on), materialised or not
 *   a one-off task       →  (occurrence_id)
 *
 * The series key not changing when a date is later materialised is what stops a
 * second reminder firing for it. **The job never writes `task_occurrence`** —
 * criteria 15 and 17 depend on untouched occurrences never being rows. The long
 * version is the header of `supabase/migrations/0007_reminders.sql`.
 *
 * Append-only: `authenticated` holds `select` and `insert` and nothing else, so
 * there is no `updated_at` and no touch trigger. An account that could delete
 * its own log rows could make the job send again.
 */
export const reminderLog = pgTable(
  "reminder_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references((): AnyPgColumn => profiles.id, { onDelete: "cascade" }),
    seriesId: uuid("series_id"),
    occurrenceId: uuid("occurrence_id"),
    /** The calendar square, set for both kinds. A bare `date`, read as a string. */
    occursOn: date("occurs_on", { mode: "string" }).notNull(),
    /**
     * The instant the reminder counted back from. For a projected occurrence
     * this is derived at send time and stored nowhere else, so the ledger would
     * not otherwise record why it fired.
     */
    deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
    /**
     * When the send was **claimed**, not when delivery was confirmed. The insert
     * wins the right to send; a throw afterwards is a missed reminder rather
     * than a retried one, which is what *at most once* asks for.
     */
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.seriesId, table.userId],
      foreignColumns: [taskSeries.id, taskSeries.userId],
      name: "reminder_log_series_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.occurrenceId, table.userId],
      foreignColumns: [taskOccurrence.id, taskOccurrence.userId],
      name: "reminder_log_occurrence_fk",
    }).onDelete("cascade"),
    // Both real indexes in 0007 are partial (`where series_id is not null` and
    // `where occurrence_id is not null`), which Drizzle cannot express. These
    // entries exist so the mirror names them, not so it could recreate them —
    // the same caveat `task_occurrence` carries on its own partial indexes.
    uniqueIndex("reminder_log_series_uniq").on(table.seriesId, table.occursOn),
    uniqueIndex("reminder_log_occurrence_uniq").on(table.occurrenceId),
    index("reminder_log_user_idx").on(table.userId),
  ],
);

export type ReminderLog = typeof reminderLog.$inferSelect;
export type NewReminderLog = typeof reminderLog.$inferInsert;
