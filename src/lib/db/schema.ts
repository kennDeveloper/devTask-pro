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
 */

import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  integer,
  pgSchema,
  pgTable,
  text,
  timestamp,
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
     * Null for a one-off. Phase 3 creates `task_series` and adds the FK plus the
     * partial unique index — deliberately absent here, since no row references
     * anything yet.
     */
    seriesId: uuid("series_id"),
    title: text("title").notNull(),
    description: text("description"),
    occursOn: date("occurs_on", { mode: "string" }).notNull(),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }),
    status: text("status").notNull().default("todo").$type<TaskStatus>(),
    progressPct: integer("progress_pct").notNull().default(0),
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
