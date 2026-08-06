/**
 * `pnpm admin:create` — create (or repair) the first admin account.
 *
 * WHY A SCRIPT AND NOT `supabase/seed.sql`
 * Seeding an admin in SQL means INSERTing straight into `auth.users`, which skips
 * password hashing and the `auth.identities` row the login flow needs, and only works
 * against a database you can reach with superuser credentials. This script goes
 * through the Supabase admin API instead, so the exact same command bootstraps the
 * local stack and a cloud project.
 *
 * IDEMPOTENT BY DESIGN. Running it twice is a no-op, not an error:
 *   - if the auth user already exists, it is looked up rather than re-created;
 *   - the profile promotion is an UPDATE that converges on the same values;
 *   - `approved_at` is only stamped the first time, so re-running does not rewrite
 *     the audit trail.
 *
 * The profile row itself is NOT created here — the `handle_new_user` trigger (0002)
 * does that the moment the auth user is inserted. This script only promotes it.
 * Because it uses the service-role key, `auth.uid()` is null for its writes, so the
 * self-promotion guard in 0003 lets them through. That is the whole point of the
 * guard's predicate: admin paths carry no JWT subject.
 */

import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import { config } from "dotenv";

config({ path: ".env.local" });

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing ${name}. Set it in .env.local (see .env.example), then re-run \`pnpm admin:create\`.`,
    );
  }
  return value;
}

const SUPABASE_URL = required("NEXT_PUBLIC_SUPABASE_URL");
const SERVICE_ROLE_KEY = required("SUPABASE_SERVICE_ROLE_KEY");
const ADMIN_EMAIL = required("ADMIN_EMAIL").toLowerCase();
const ADMIN_PASSWORD = required("ADMIN_PASSWORD");

/**
 * The admin API paginates. Walk the pages rather than assuming the account is on the
 * first one — this script has to keep working once the user list is non-trivial.
 */
async function findUserByEmail(
  admin: SupabaseClient,
  email: string,
): Promise<User | null> {
  const perPage = 200;
  for (let page = 1; ; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) throw error;

    const match = data.users.find((u) => u.email?.toLowerCase() === email);
    if (match) return match;

    if (data.users.length < perPage) return null;
  }
}

async function main(): Promise<void> {
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ---- 1. The auth user -----------------------------------------------------
  // `email_confirm: true` marks the address verified without sending mail. The
  // seeded admin must not be stuck behind the confirmation gate it exists to manage.
  let user: User;
  let createdUser = false;

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
    email_confirm: true,
  });

  if (createError) {
    // Already registered. Not a failure — this is the re-run path.
    const existing = await findUserByEmail(admin, ADMIN_EMAIL);
    if (!existing) throw createError;
    user = existing;
  } else {
    user = created.user;
    createdUser = true;
  }

  // ---- 2. The profile -------------------------------------------------------
  // Created by the handle_new_user trigger; promoted here. `approved_at` is left
  // alone if already set so a re-run does not rewrite history.
  const { data: before, error: readError } = await admin
    .from("profiles")
    .select("id, role, status, approved_at")
    .eq("id", user.id)
    .single();

  if (readError) {
    throw new Error(
      `No profiles row for ${ADMIN_EMAIL} (${user.id}). The handle_new_user trigger ` +
        `should have created one — check that migrations are applied (\`pnpm db:reset\`). ` +
        `Underlying error: ${readError.message}`,
    );
  }

  const alreadyPromoted = before.role === "admin" && before.status === "active";

  const { error: updateError } = await admin
    .from("profiles")
    .update({
      role: "admin",
      status: "active",
      approved_at: before.approved_at ?? new Date().toISOString(),
    })
    .eq("id", user.id);

  if (updateError) throw updateError;

  // ---- 3. Say what happened -------------------------------------------------
  const userLine = createdUser
    ? "created auth user"
    : "auth user already existed, reused";
  const profileLine = alreadyPromoted
    ? "profile already role=admin status=active, left as is"
    : `promoted profile ${before.role}/${before.status} -> admin/active`;

  console.log(`admin:create  ${ADMIN_EMAIL}`);
  console.log(`  id       ${user.id}`);
  console.log(`  auth     ${userLine}`);
  console.log(`  profile  ${profileLine}`);
  console.log(
    alreadyPromoted && !createdUser
      ? "  result   no-op (already bootstrapped)"
      : "  result   ok",
  );
}

main().catch((error: unknown) => {
  console.error("admin:create failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
