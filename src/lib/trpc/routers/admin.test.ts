import { beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "@supabase/supabase-js";

import type { AdminAccount } from "@/lib/db/repos/profiles";
import type { Profile, ProfileRole, ProfileStatus } from "@/lib/db/schema";

/**
 * Tests for the admin router.
 *
 * The repo and the auth wrapper are both mocked, so nothing here touches a
 * database or the network. The live proof that an admin still cannot read task
 * data is `tests/integration/rls-boundary.test.ts`; repeating it against a mock
 * would prove only that the mock was written to agree.
 *
 * What this file owns is the part a database cannot check: that the ladder
 * refuses the accounts it should, that Zod refuses bad input *before* any query
 * runs, that an admin cannot aim any of this at themselves, that an illegal
 * transition is refused server-side however the UI got there, and that the
 * status write happens before the auth ban.
 */

vi.mock("@/lib/db/repos/profiles", () => ({
  listAccountsAsAdmin: vi.fn(),
  findAccountAsAdmin: vi.fn(),
  setAccountStatusAsAdmin: vi.fn(),
  countActiveAdminsAsAdmin: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  setAccountBanned: vi.fn(),
  sendRecoveryEmail: vi.fn(),
}));

import * as profilesRepo from "@/lib/db/repos/profiles";
import { sendRecoveryEmail, setAccountBanned } from "@/lib/supabase/admin";

import { createCallerFactory, type Context } from "../server";
import { adminRouter } from "./admin";

const createCaller = createCallerFactory(adminRouter);

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_ID = "22222222-2222-4222-8222-222222222222";

function fakeUser(id = ADMIN_ID): User {
  return {
    id,
    email: "admin@example.com",
    aud: "authenticated",
    app_metadata: {},
    user_metadata: {},
    created_at: new Date().toISOString(),
  } as User;
}

function fakeProfile(status: ProfileStatus, role: ProfileRole): Profile {
  return {
    id: ADMIN_ID,
    email: "admin@example.com",
    displayName: "The Admin",
    timezone: "UTC",
    role,
    status,
    approvedAt: new Date("2026-01-01T00:00:00Z"),
    approvedBy: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  };
}

function contextFor(
  status: ProfileStatus = "active",
  role: ProfileRole = "admin",
): Context {
  return { supabase: null, user: fakeUser(), profile: fakeProfile(status, role) };
}

const anonymousContext: Context = { supabase: null, user: null, profile: null };

function fakeAccount(overrides: Partial<AdminAccount> = {}): AdminAccount {
  return {
    id: TARGET_ID,
    email: "member@example.com",
    displayName: null,
    role: "member",
    status: "pending",
    approvedAt: null,
    createdAt: new Date("2026-08-01T00:00:00Z"),
    lastSignInAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(profilesRepo.listAccountsAsAdmin).mockResolvedValue([]);
  vi.mocked(profilesRepo.findAccountAsAdmin).mockResolvedValue(fakeAccount());
  vi.mocked(profilesRepo.setAccountStatusAsAdmin).mockResolvedValue({
    ok: true,
    account: fakeAccount({ status: "active" }),
  });
});

describe("the procedure ladder", () => {
  it("rejects an anonymous caller as UNAUTHORIZED", async () => {
    await expect(createCaller(anonymousContext).list()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("rejects an active MEMBER as FORBIDDEN", async () => {
    await expect(
      createCaller(contextFor("active", "member")).list(),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  /**
   * `adminProcedure` is composed on top of `activeProcedure`, so status is
   * checked before role. Losing your account access has to cost you your admin
   * access too, or suspension is not a revocation.
   */
  it.each(["pending", "rejected", "suspended"] as const)(
    "rejects a %s admin as FORBIDDEN",
    async (status) => {
      await expect(
        createCaller(contextFor(status, "admin")).list(),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    },
  );

  it("never reaches the database for a caller it refuses", async () => {
    await expect(
      createCaller(contextFor("active", "member")).list(),
    ).rejects.toThrow();
    expect(profilesRepo.listAccountsAsAdmin).not.toHaveBeenCalled();
  });

  it("lets an active admin through", async () => {
    await expect(createCaller(contextFor()).list()).resolves.toEqual([]);
  });
});

describe("no procedure may target the caller's own account", () => {
  it.each([
    [
      "setStatus",
      (caller: ReturnType<typeof createCaller>) =>
        caller.setStatus({ userId: ADMIN_ID, action: "suspend" }),
    ],
    [
      "sendPasswordReset",
      (caller: ReturnType<typeof createCaller>) =>
        caller.sendPasswordReset({ userId: ADMIN_ID }),
    ],
  ] as const)("refuses a self-targeted %s", async (_label, call) => {
    await expect(call(createCaller(contextFor()))).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  /**
   * The check runs before the lookup, so it costs nothing and cannot be
   * confused with a NOT_FOUND — and, more importantly, no write is attempted.
   */
  it("refuses without reading or writing anything", async () => {
    await expect(
      createCaller(contextFor()).setStatus({
        userId: ADMIN_ID,
        action: "suspend",
      }),
    ).rejects.toThrow();

    expect(profilesRepo.findAccountAsAdmin).not.toHaveBeenCalled();
    expect(profilesRepo.setAccountStatusAsAdmin).not.toHaveBeenCalled();
    expect(setAccountBanned).not.toHaveBeenCalled();
  });
});

describe("input validation happens before any query", () => {
  it.each([
    ["a non-uuid id", { userId: "not-a-uuid", action: "approve" }],
    ["an action that does not exist", { userId: TARGET_ID, action: "delete" }],
    ["a promotion attempt", { userId: TARGET_ID, action: "promote" }],
    ["a missing action", { userId: TARGET_ID }],
  ])("rejects %s without calling the repo", async (_label, input) => {
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createCaller(contextFor()).setStatus(input as any),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(profilesRepo.setAccountStatusAsAdmin).not.toHaveBeenCalled();
  });

  /**
   * There is no `role` or `status` field in any schema in this router, so a
   * client cannot even express "make this person an admin" or "set them to
   * active directly". Ownership of those columns stays with the transition
   * table.
   */
  it("ignores a role smuggled into the input", async () => {
    await createCaller(contextFor()).setStatus(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { userId: TARGET_ID, action: "approve", role: "admin" } as any,
    );

    const [call] = vi.mocked(profilesRepo.setAccountStatusAsAdmin).mock.calls;
    expect(call[0]).not.toHaveProperty("role");
    expect(call[0].status).toBe("active");
  });
});

describe("the transition table is re-decided server-side", () => {
  it.each([
    ["suspend", "pending"],
    ["suspend", "rejected"],
    ["suspend", "suspended"],
    ["reject", "active"],
    ["reject", "suspended"],
    ["reinstate", "pending"],
    ["reinstate", "active"],
    ["approve", "active"],
  ] as const)("refuses %s on a %s account", async (action, status) => {
    vi.mocked(profilesRepo.findAccountAsAdmin).mockResolvedValue(
      fakeAccount({ status }),
    );

    await expect(
      createCaller(contextFor()).setStatus({ userId: TARGET_ID, action }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(profilesRepo.setAccountStatusAsAdmin).not.toHaveBeenCalled();
  });

  it.each([
    // Only `suspend` bans. A banned account cannot sign in at all — measured —
    // so banning on reject would stop a rejected user ever reaching the
    // /no-access screen criterion 2 says they must see. The other three lift
    // the ban, so the auth state is a pure function of the last action.
    ["approve", "pending", "active", false],
    ["approve", "rejected", "active", false],
    ["reject", "pending", "rejected", false],
    ["suspend", "active", "suspended", true],
    ["reinstate", "suspended", "active", false],
  ] as const)(
    "allows %s on a %s account -> %s (bans: %s)",
    async (action, status, result, bans) => {
      vi.mocked(profilesRepo.findAccountAsAdmin).mockResolvedValue(
        fakeAccount({ status }),
      );

      await createCaller(contextFor()).setStatus({
        userId: TARGET_ID,
        action,
      });

      expect(profilesRepo.setAccountStatusAsAdmin).toHaveBeenCalledWith({
        actorId: ADMIN_ID,
        targetId: TARGET_ID,
        status: result,
        stampApproval: result === "active",
      });
      expect(setAccountBanned).toHaveBeenCalledWith(TARGET_ID, bans);
    },
  );
});

describe("the status write happens before the auth ban", () => {
  /**
   * There is no transaction spanning Postgres and the auth service, so one of
   * the two has to go first. This order leaves a failed ban as a status change
   * the admin can see and retry; the other leaves an account locked out of the
   * app with no record of why.
   */
  it("does not ban when the row write was refused", async () => {
    vi.mocked(profilesRepo.findAccountAsAdmin).mockResolvedValue(
      fakeAccount({ status: "active", role: "admin" }),
    );
    vi.mocked(profilesRepo.setAccountStatusAsAdmin).mockResolvedValue({
      ok: false,
      reason: "last_admin",
    });

    await expect(
      createCaller(contextFor()).setStatus({
        userId: TARGET_ID,
        action: "suspend",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(setAccountBanned).not.toHaveBeenCalled();
  });

  it("surfaces a failed ban rather than reporting success", async () => {
    vi.mocked(setAccountBanned).mockRejectedValue(new Error("auth is down"));

    await expect(
      createCaller(contextFor()).setStatus({
        userId: TARGET_ID,
        action: "approve",
      }),
    ).rejects.toThrow(/auth is down/);
  });
});

describe("outcomes map to honest tRPC codes", () => {
  it("reports a missing account as NOT_FOUND", async () => {
    vi.mocked(profilesRepo.findAccountAsAdmin).mockResolvedValue(null);

    await expect(
      createCaller(contextFor()).setStatus({
        userId: TARGET_ID,
        action: "approve",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("reports the last-admin refusal as CONFLICT", async () => {
    vi.mocked(profilesRepo.findAccountAsAdmin).mockResolvedValue(
      fakeAccount({ status: "active", role: "admin" }),
    );
    vi.mocked(profilesRepo.setAccountStatusAsAdmin).mockResolvedValue({
      ok: false,
      reason: "last_admin",
    });

    await expect(
      createCaller(contextFor()).setStatus({
        userId: TARGET_ID,
        action: "suspend",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("reports a row that vanished mid-request as NOT_FOUND", async () => {
    vi.mocked(profilesRepo.setAccountStatusAsAdmin).mockResolvedValue({
      ok: false,
      reason: "not_found",
    });

    await expect(
      createCaller(contextFor()).setStatus({
        userId: TARGET_ID,
        action: "approve",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("sendPasswordReset", () => {
  it("sends to the address on the account, never one supplied by the caller", async () => {
    vi.mocked(profilesRepo.findAccountAsAdmin).mockResolvedValue(
      fakeAccount({ email: "real@example.com" }),
    );

    await createCaller(contextFor()).sendPasswordReset(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { userId: TARGET_ID, email: "attacker@example.com" } as any,
    );

    expect(sendRecoveryEmail).toHaveBeenCalledWith("real@example.com");
  });

  it("returns the address it went to and nothing resembling a link", async () => {
    const result = await createCaller(contextFor()).sendPasswordReset({
      userId: TARGET_ID,
    });

    expect(result).toEqual({ id: TARGET_ID, email: "member@example.com" });
  });

  it("changes no status", async () => {
    await createCaller(contextFor()).sendPasswordReset({ userId: TARGET_ID });
    expect(profilesRepo.setAccountStatusAsAdmin).not.toHaveBeenCalled();
    expect(setAccountBanned).not.toHaveBeenCalled();
  });
});

describe("the projection", () => {
  /**
   * Criterion 8. The admin tier shows account metadata and nothing else — not a
   * task, not a count of tasks. Asserted as an exact key set so a field added
   * later has to be a decision somebody makes on purpose.
   */
  it("emits exactly the account fields, and nothing task-shaped", async () => {
    vi.mocked(profilesRepo.listAccountsAsAdmin).mockResolvedValue([
      fakeAccount(),
    ]);

    const [account] = await createCaller(contextFor()).list();

    expect(Object.keys(account).sort()).toEqual([
      "approvedAt",
      "createdAt",
      "displayName",
      "email",
      "id",
      "lastSignInAt",
      "role",
      "status",
    ]);
  });

  /** The link has no transformer, so a `Date` would arrive as a string anyway. */
  it("emits ISO strings for every instant", async () => {
    vi.mocked(profilesRepo.listAccountsAsAdmin).mockResolvedValue([
      fakeAccount({
        approvedAt: new Date("2026-08-02T10:00:00Z"),
        lastSignInAt: new Date("2026-08-05T09:30:00Z"),
      }),
    ]);

    const [account] = await createCaller(contextFor()).list();

    expect(account.createdAt).toBe("2026-08-01T00:00:00.000Z");
    expect(account.approvedAt).toBe("2026-08-02T10:00:00.000Z");
    expect(account.lastSignInAt).toBe("2026-08-05T09:30:00.000Z");
  });

  it("keeps a never-signed-in account's last sign-in null rather than inventing one", async () => {
    vi.mocked(profilesRepo.listAccountsAsAdmin).mockResolvedValue([
      fakeAccount({ lastSignInAt: null }),
    ]);

    const [account] = await createCaller(contextFor()).list();
    expect(account.lastSignInAt).toBeNull();
  });

  it("does not expose the account holder's timezone", async () => {
    vi.mocked(profilesRepo.listAccountsAsAdmin).mockResolvedValue([
      fakeAccount(),
    ]);

    const [account] = await createCaller(contextFor()).list();
    expect(account).not.toHaveProperty("timezone");
  });
});
