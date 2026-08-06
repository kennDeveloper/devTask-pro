import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Account helpers for e2e, using the service-role key.
 *
 * These stand in for the admin tier, which does not exist until phase 5. Approving
 * by direct write is deliberate: phase 1's job is to prove the *gate* works, not the
 * UI that eventually drives it.
 *
 * Note this exercises the same path a real admin action will take — service_role
 * carries no JWT `sub`, so `auth.uid()` is null and the escalation guard in
 * `0003_rls_policies.sql` lets the role/status change through. A user doing this to
 * their own row is rejected; there is an integration test for both directions.
 */

export type AccountStatus = "pending" | "active" | "rejected" | "suspended";

function admin(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing — is .env.local loaded?",
    );
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** A unique address per run, so a re-run never collides with a leftover account. */
export function uniqueEmail(prefix = "e2e"): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@devtask.local`;
}

export const TEST_PASSWORD = "correct-horse-battery-staple";

/**
 * Create an already-confirmed account at a given status, skipping the mail journey.
 * Used by specs that need to *be* signed in rather than to test signing up.
 */
export async function createAccount(
  email: string,
  status: AccountStatus = "active",
  role: "member" | "admin" = "member",
): Promise<string> {
  const supabase = admin();

  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password: TEST_PASSWORD,
    email_confirm: true,
  });
  if (error) throw error;

  const id = data.user!.id;
  await setStatus(email, status, role);
  return id;
}

/** Move an account's gate columns — the thing the phase-5 admin UI will do. */
export async function setStatus(
  email: string,
  status: AccountStatus,
  role?: "member" | "admin",
): Promise<void> {
  const supabase = admin();
  const patch: Record<string, unknown> = { status };
  if (role) patch.role = role;
  if (status === "active") patch.approved_at = new Date().toISOString();

  const { error } = await supabase
    .from("profiles")
    .update(patch)
    .eq("email", email);
  if (error) throw error;
}

/** Read a profile back, for asserting the trigger did its job. */
export async function getProfile(email: string) {
  const supabase = admin();
  const { data, error } = await supabase
    .from("profiles")
    .select("id, email, status, role, timezone")
    .eq("email", email)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function deleteAccount(email: string): Promise<void> {
  const supabase = admin();
  const profile = await getProfile(email);
  if (profile?.id) await supabase.auth.admin.deleteUser(profile.id);
}
