import type { User } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import type { Profile, ProfileRole, ProfileStatus } from "@/lib/db/schema";

import { profileUpdateInput } from "./routers/profile";
import {
  activeProcedure,
  adminProcedure,
  createCallerFactory,
  protectedProcedure,
  publicProcedure,
  router,
  type Context,
} from "./server";

/**
 * Unit tests for the procedure ladder. No database, no HTTP, no Supabase — the
 * contexts are hand-built, which is the point: these assert what each rung does
 * with a given context, independently of how a real one gets assembled.
 *
 * The router below is test-only on purpose. Pinning these assertions to
 * `profile.get` / `profile.update` would mean a future change to the profile
 * router could quietly stop exercising a rung, and the resolvers would need a
 * live database. One trivial procedure per rung keeps the access model itself
 * as the thing under test.
 */

const testRouter = router({
  open: publicProcedure.query(() => "open"),

  // Each resolver dereferences the field its rung is supposed to have proven
  // non-null. If the narrowing regressed, these stop compiling — the type-level
  // half of the contract is asserted by `pnpm typecheck`, not by an assertion.
  authed: protectedProcedure.query(({ ctx }) => ctx.user.id),
  active: activeProcedure.query(({ ctx }) => ctx.profile.status),
  admin: adminProcedure.query(({ ctx }) => ctx.profile.role),

  // Proves middleware context overrides *merge* into the base context rather
  // than replacing it, so untouched fields survive the ladder.
  merged: activeProcedure.query(({ ctx }) => ({
    id: ctx.user.id,
    email: ctx.profile.email,
    supabase: ctx.supabase,
  })),
});

const createCaller = createCallerFactory(testRouter);

const USER_ID = "11111111-1111-4111-8111-111111111111";

function fakeUser(): User {
  return {
    id: USER_ID,
    email: "member@example.com",
    aud: "authenticated",
    app_metadata: {},
    user_metadata: {},
    created_at: new Date().toISOString(),
  } as User;
}

function fakeProfile(role: ProfileRole, status: ProfileStatus): Profile {
  return {
    id: USER_ID,
    email: "member@example.com",
    displayName: "Test Member",
    timezone: "UTC",
    role,
    status,
    approvedAt: null,
    approvedBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/** Signed out. No user, no profile. */
const anonymousContext: Context = {
  supabase: null,
  user: null,
  profile: null,
};

/** Signed in, with a profile in the given role/status. */
function contextFor(role: ProfileRole, status: ProfileStatus): Context {
  return {
    supabase: null,
    user: fakeUser(),
    profile: fakeProfile(role, status),
  };
}

/**
 * Signed in, but the profile row could not be loaded — the fail-closed branch
 * in `buildContext`.
 */
const profilelessContext: Context = {
  supabase: null,
  user: fakeUser(),
  profile: null,
};

describe("publicProcedure", () => {
  it("lets an anonymous caller through", async () => {
    const caller = createCaller(anonymousContext);
    await expect(caller.open()).resolves.toBe("open");
  });
});

describe("protectedProcedure", () => {
  it("rejects an anonymous context with UNAUTHORIZED", async () => {
    const caller = createCaller(anonymousContext);
    await expect(caller.authed()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("lets an authenticated but still-pending user through", async () => {
    // The reason this rung is weak: /pending has to render for exactly the
    // accounts activeProcedure rejects, and it renders by reading its profile.
    const caller = createCaller(contextFor("member", "pending"));
    await expect(caller.authed()).resolves.toBe(USER_ID);
  });
});

describe("activeProcedure", () => {
  it("lets an active member through", async () => {
    const caller = createCaller(contextFor("member", "active"));
    await expect(caller.active()).resolves.toBe("active");
  });

  it("rejects status 'pending' with FORBIDDEN", async () => {
    const caller = createCaller(contextFor("member", "pending"));
    await expect(caller.active()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects status 'suspended' with FORBIDDEN", async () => {
    // The token is still valid — suspension has to bite on the row, not on the
    // JWT, or revocation waits for the token to expire.
    const caller = createCaller(contextFor("member", "suspended"));
    await expect(caller.active()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects status 'rejected' with FORBIDDEN", async () => {
    const caller = createCaller(contextFor("member", "rejected"));
    await expect(caller.active()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects an authenticated user with no profile row", async () => {
    const caller = createCaller(profilelessContext);
    await expect(caller.active()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("reports an anonymous caller as UNAUTHORIZED, not FORBIDDEN", async () => {
    // Precedence matters to the client: "sign in" and "you are not allowed"
    // lead to different screens.
    const caller = createCaller(anonymousContext);
    await expect(caller.active()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("passes the untouched base context through the narrowing", async () => {
    const supabase = { marker: true } as never;
    const caller = createCaller({ ...contextFor("member", "active"), supabase });
    await expect(caller.merged()).resolves.toEqual({
      id: USER_ID,
      email: "member@example.com",
      supabase,
    });
  });
});

describe("adminProcedure", () => {
  it("lets an active admin through", async () => {
    const caller = createCaller(contextFor("admin", "active"));
    await expect(caller.admin()).resolves.toBe("admin");
  });

  it("rejects an active member with FORBIDDEN", async () => {
    const caller = createCaller(contextFor("member", "active"));
    await expect(caller.admin()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects a suspended admin — losing account access costs admin access", async () => {
    const caller = createCaller(contextFor("admin", "suspended"));
    await expect(caller.admin()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects a pending admin", async () => {
    const caller = createCaller(contextFor("admin", "pending"));
    await expect(caller.admin()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("reports an anonymous caller as UNAUTHORIZED", async () => {
    const caller = createCaller(anonymousContext);
    await expect(caller.admin()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});

describe("profile.update input", () => {
  it("accepts a real IANA time zone", () => {
    expect(
      profileUpdateInput.safeParse({ timezone: "Australia/Sydney" }).success,
    ).toBe(true);
  });

  it("accepts 'UTC', the column default", () => {
    // Regression guard. `Intl.supportedValuesOf("timeZone")` returns canonical
    // identifiers only and omits "UTC" entirely, so a naive set-membership
    // check rejects the value `profiles.timezone` defaults to.
    expect(Intl.supportedValuesOf("timeZone")).not.toContain("UTC");
    expect(profileUpdateInput.safeParse({ timezone: "UTC" }).success).toBe(true);
  });

  it("still rejects a raw UTC offset", () => {
    // The point this guards: the validator did not become a bare
    // `Intl.DateTimeFormat` check, which accepts offsets happily. An offset
    // resolves to itself, is not in the enumerated list, and is refused.
    expect(profileUpdateInput.safeParse({ timezone: "+10:00" }).success).toBe(
      false,
    );
    expect(profileUpdateInput.safeParse({ timezone: "-05:30" }).success).toBe(
      false,
    );
  });

  /**
   * Changed deliberately in phase 2. These used to be rejected outright, on the
   * grounds that an alias is not "a zone we want persisted". The column still
   * never receives one — but because the input is normalised to the canonical
   * spelling, not because the request is bounced.
   *
   * The reason this had to change: `supportedValuesOf` enumerates different
   * spellings on different engines, so the old membership test rejected
   * "Asia/Kolkata" on this Node and left users in India unable to save their
   * settings at all.
   */
  it("normalises an alternative spelling instead of rejecting it", () => {
    for (const [sent, stored] of [
      ["Asia/Kolkata", "Asia/Calcutta"],
      ["US/Eastern", "America/New_York"],
    ] as const) {
      const result = profileUpdateInput.safeParse({ timezone: sent });
      expect(result.success).toBe(true);
      // Note what is asserted: not that it parsed, but what it parsed *to*.
      expect(result.success && result.data.timezone).toBe(stored);
    }
  });

  it("rejects a plausible-looking but non-existent zone", () => {
    expect(
      profileUpdateInput.safeParse({ timezone: "Australia/Sidney" }).success,
    ).toBe(false);
  });

  it("rejects a UTC offset string", () => {
    expect(profileUpdateInput.safeParse({ timezone: "+10:00" }).success).toBe(
      false,
    );
  });

  it("trims the display name", () => {
    const parsed = profileUpdateInput.parse({ displayName: "  Ada  " });
    expect(parsed.displayName).toBe("Ada");
  });

  it("rejects a blank display name", () => {
    expect(profileUpdateInput.safeParse({ displayName: "   " }).success).toBe(
      false,
    );
  });

  it("rejects an empty update", () => {
    expect(profileUpdateInput.safeParse({}).success).toBe(false);
  });

  it("ignores role and status if a caller tries to smuggle them in", () => {
    // Belt-and-braces only. The real guard is the BEFORE UPDATE trigger
    // `guard_profile_privileged_columns()` in 0003 — this just proves the
    // fields never reach the resolver's `.set()` object.
    const parsed = profileUpdateInput.parse({
      timezone: "Europe/London",
      role: "admin",
      status: "active",
    } as never);
    expect(parsed).not.toHaveProperty("role");
    expect(parsed).not.toHaveProperty("status");
  });
});
