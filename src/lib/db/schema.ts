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
 */

import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

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
