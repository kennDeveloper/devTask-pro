/**
 * Integration proof for the `profiles` access boundary.
 *
 * Runs against the LIVE local Supabase stack — `pnpm db:start && pnpm db:reset` first,
 * then `pnpm test:integration`. It is excluded from `pnpm test` because CI has no stack.
 *
 * What it proves, and why each one matters:
 *   1. Signing up through the ANON client creates exactly one profiles row, pending/member.
 *      -> the handle_new_user trigger (0002) fires for the door real users come through,
 *         and new accounts land behind the gate rather than in front of it.
 *   2. That user can edit their own display_name and timezone.
 *      -> the update policy (0003) is not so tight that settings stop working.
 *   3. That user CANNOT set their own role='admin' or status='active'.
 *      -> the escalation guard (0003) closes the self-promotion hole. This is the
 *         assertion the whole phase exists for.
 *   4. `pnpm admin:create` yields an admin/active profile, idempotently.
 *      -> the bootstrap path still works, i.e. the guard blocks users without also
 *         blocking the service-role operations that legitimately move role and status.
 */

import { execFileSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL!;

const TEST_PASSWORD = "devtask-test-password";

/**
 * Unique per run so repeated runs never collide on an already-registered address,
 * and a crashed run's leftovers never poison the next one. A plain test file — the
 * usual "don't use Date.now()" caution about non-determinism does not apply here.
 */
const RUN_ID = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
let emailCounter = 0;
const uniqueEmail = () => `devtask-test-${RUN_ID}-${++emailCounter}@example.com`;

/** Service-role client. Bypasses RLS — used only for setup, teardown, and assertions. */
const adminClient: SupabaseClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/** An unauthenticated client — the one a signup form would use. */
const anonClient: SupabaseClient = createClient(SUPABASE_URL, ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/**
 * A client that acts AS a given user. Passing the access token explicitly (rather than
 * relying on an in-memory session) makes it unambiguous which identity each query runs
 * under — the whole point of these tests.
 */
function clientFor(accessToken: string): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

const createdUserIds: string[] = [];

/** Sign up through the anon client, confirm the address, and sign in for a token. */
async function signUpAndSignIn(email: string) {
  const { error: signUpError } = await anonClient.auth.signUp({
    email,
    password: TEST_PASSWORD,
  });
  expect(signUpError).toBeNull();

  // Look the user up service-side rather than trusting signUp's return shape: with
  // enable_confirmations = true it yields no session, and GoTrue deliberately
  // obfuscates parts of the user object to prevent address enumeration.
  const { data: list, error: listError } = await adminClient.auth.admin.listUsers({
    page: 1,
    perPage: 1000,
  });
  expect(listError).toBeNull();
  const user = list!.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
  expect(user, `no auth user created for ${email}`).toBeDefined();
  createdUserIds.push(user!.id);

  // Confirmation normally happens by clicking the emailed link. Short-circuit it here:
  // this suite is about the profiles boundary, not about the mail catcher (that is
  // covered end-to-end by the Playwright spec). Note it does NOT touch profiles.status.
  const { error: confirmError } = await adminClient.auth.admin.updateUserById(user!.id, {
    email_confirm: true,
  });
  expect(confirmError).toBeNull();

  const { data: session, error: signInError } = await anonClient.auth.signInWithPassword({
    email,
    password: TEST_PASSWORD,
  });
  expect(signInError).toBeNull();
  expect(session.session?.access_token).toBeTruthy();

  return { id: user!.id, email, accessToken: session.session!.access_token };
}

describe("profiles — signup trigger, RLS, and the escalation guard", () => {
  let member: Awaited<ReturnType<typeof signUpAndSignIn>>;
  let memberClient: SupabaseClient;

  beforeAll(async () => {
    member = await signUpAndSignIn(uniqueEmail());
    memberClient = clientFor(member.accessToken);
  });

  afterAll(async () => {
    // Delete the auth users this run created; the profiles rows go with them via the
    // `on delete cascade` on profiles.id -> auth.users.id. The bootstrap admin is left
    // alone: it is a legitimate local artifact and `pnpm admin:create` re-converges it.
    for (const id of createdUserIds) {
      await adminClient.auth.admin.deleteUser(id);
    }
  });

  it("creates exactly one pending/member profile when a user signs up via the anon client", async () => {
    const { data, error, count } = await adminClient
      .from("profiles")
      .select("id, email, role, status, timezone, approved_at, approved_by", {
        count: "exact",
      })
      .eq("id", member.id);

    expect(error).toBeNull();
    expect(count).toBe(1);

    const profile = data![0];
    expect(profile.status).toBe("pending");
    expect(profile.role).toBe("member");
    expect(profile.email.toLowerCase()).toBe(member.email.toLowerCase());
    expect(profile.timezone).toBe("UTC");
    expect(profile.approved_at).toBeNull();
    expect(profile.approved_by).toBeNull();
  });

  it("shows the signed-in user exactly their own row and nothing else", async () => {
    // Premise for the update tests below: if the select policy were wrong, an
    // 'update succeeded' result would not mean what we think it means.
    const { data, error } = await memberClient.from("profiles").select("id");

    expect(error).toBeNull();
    expect(data!.map((row) => row.id)).toEqual([member.id]);
  });

  it("lets the user update their own display_name and timezone", async () => {
    const { data, error } = await memberClient
      .from("profiles")
      .update({ display_name: "Test Member", timezone: "Asia/Manila" })
      .eq("id", member.id)
      .select("display_name, timezone")
      .single();

    expect(error).toBeNull();
    expect(data!.display_name).toBe("Test Member");
    expect(data!.timezone).toBe("Asia/Manila");
  });

  it("rejects the user promoting their own role to admin", async () => {
    const { error } = await memberClient
      .from("profiles")
      .update({ role: "admin" })
      .eq("id", member.id);

    expect(error).not.toBeNull();
    expect(error!.message).toContain(
      "role and status cannot be changed by the account holder",
    );

    const { data } = await adminClient
      .from("profiles")
      .select("role")
      .eq("id", member.id)
      .single();
    expect(data!.role).toBe("member");
  });

  it("rejects the user activating their own status", async () => {
    const { error } = await memberClient
      .from("profiles")
      .update({ status: "active" })
      .eq("id", member.id);

    expect(error).not.toBeNull();
    expect(error!.message).toContain(
      "role and status cannot be changed by the account holder",
    );

    const { data } = await adminClient
      .from("profiles")
      .select("status")
      .eq("id", member.id)
      .single();
    expect(data!.status).toBe("pending");
  });

  it("rejects the escalation even when smuggled alongside a legitimate field", async () => {
    // The guard compares OLD to NEW per column, so mixing an allowed change into the
    // same statement must not launder the forbidden one.
    const { error } = await memberClient
      .from("profiles")
      .update({ display_name: "Sneaky", role: "admin", status: "active" })
      .eq("id", member.id);

    expect(error).not.toBeNull();

    const { data } = await adminClient
      .from("profiles")
      .select("display_name, role, status")
      .eq("id", member.id)
      .single();
    expect(data!.role).toBe("member");
    expect(data!.status).toBe("pending");
    // The whole statement rolled back, so the allowed field did not land either.
    expect(data!.display_name).toBe("Test Member");
  });
});

describe("admin bootstrap", () => {
  beforeAll(() => {
    // Idempotent, so running it here is safe whether or not it has been run before —
    // and it makes this suite self-contained immediately after a `pnpm db:reset`.
    execFileSync("pnpm", ["admin:create"], { stdio: "pipe" });
  });

  it("leaves `pnpm admin:create`'s account as role=admin, status=active", async () => {
    const { data, error, count } = await adminClient
      .from("profiles")
      .select("id, role, status, approved_at", { count: "exact" })
      .eq("email", ADMIN_EMAIL.toLowerCase());

    expect(error).toBeNull();
    expect(count).toBe(1);
    expect(data![0].role).toBe("admin");
    expect(data![0].status).toBe("active");
    expect(data![0].approved_at).not.toBeNull();
  });

  it("is a no-op on a second run", async () => {
    const before = await adminClient
      .from("profiles")
      .select("id, approved_at")
      .eq("email", ADMIN_EMAIL.toLowerCase())
      .single();

    execFileSync("pnpm", ["admin:create"], { stdio: "pipe" });

    const after = await adminClient
      .from("profiles")
      .select("id, approved_at")
      .eq("email", ADMIN_EMAIL.toLowerCase())
      .single();

    // Same account, and the approval timestamp was not rewritten.
    expect(after.data!.id).toBe(before.data!.id);
    expect(after.data!.approved_at).toBe(before.data!.approved_at);
  });
});
