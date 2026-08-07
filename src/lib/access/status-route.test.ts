import { describe, expect, it } from "vitest";

import {
  ADMIN_HOME_PATH,
  ALWAYS_ALLOWED_PREFIXES,
  APP_HOME_PATH,
  isAlwaysAllowed,
  NO_ACCESS_PATH,
  parseAccountRole,
  parseAccountStatus,
  PENDING_PATH,
  routeForStatus,
  SIGN_IN_PATH,
  type AccountRole,
  type AccountStatus,
} from "./status-route";

/**
 * The access model, asserted as a table.
 *
 * `routeForStatus` is pure, so the whole gate can be proven here without a
 * request, a cookie, a session or a database — which is the entire reason the
 * decision logic was pulled out of `src/middleware.ts`.
 *
 * The cases that matter most are the loop cases at the bottom: every screen
 * this function redirects to must itself be reachable by the caller it just
 * redirected, or the app spins.
 */

type Caller = {
  label: string;
  status: AccountStatus | null;
  /** Absent means "member", which is what an unread or unrecognised role becomes. */
  role?: AccountRole;
  isSignedIn: boolean;
};

const CALLERS: Caller[] = [
  { label: "signed out", status: null, isSignedIn: false },
  { label: "pending", status: "pending", isSignedIn: true },
  { label: "active", status: "active", isSignedIn: true },
  { label: "rejected", status: "rejected", isSignedIn: true },
  { label: "suspended", status: "suspended", isSignedIn: true },
  // The trigger in migration 0002 should make this impossible, but a failed
  // read produces it and middleware must not crash or fall open.
  { label: "no profile row", status: null, isSignedIn: true },
  // Phase 5. An admin is `active` too — the difference is entirely which tier
  // they belong to, and the row below is what pins that they are sent to it.
  { label: "admin", status: "active", role: "admin", isSignedIn: true },
];

const GROUPS = {
  // (app) routes — the things the gate exists to protect.
  protected: ["/today", "/tasks", "/tasks/9d0c1e", "/overdue", "/settings"],
  // (admin) routes — protected by status like any other, but gated on ROLE by
  // the layout rather than here. Note what the `active` row expects below.
  admin: ["/admin", "/admin/users"],
  // (auth) routes you arrive at to *start* a session.
  "entry auth": ["/sign-in", "/sign-up"],
  // (auth) routes reached mid-recovery, sometimes already signed in.
  "recovery auth": ["/forgot-password", "/reset-password"],
  // (gate) routes — this task's own screens.
  gate: ["/pending", "/no-access"],
  // The PKCE code exchange.
  callback: ["/auth/callback"],
  // Anything served as a file rather than rendered as a route.
  asset: [
    "/_next/static/chunks/main.js",
    "/favicon.ico",
    "/robots.txt",
    "/fonts/inter.woff2",
  ],
} as const;

type GroupName = keyof typeof GROUPS;

const GROUP_NAMES = Object.keys(GROUPS) as GroupName[];

/** caller label -> path group -> expected redirect (or null to pass through). */
const EXPECTED: Record<string, Record<GroupName, string | null>> = {
  "signed out": {
    protected: SIGN_IN_PATH,
    admin: SIGN_IN_PATH,
    "entry auth": null,
    "recovery auth": null,
    gate: null,
    callback: null,
    asset: null,
  },
  pending: {
    protected: PENDING_PATH,
    admin: PENDING_PATH,
    "entry auth": null,
    "recovery auth": null,
    gate: null,
    callback: null,
    asset: null,
  },
  active: {
    protected: null,
    // An active MEMBER on /admin/* passes through on purpose, so the (admin)
    // layout can answer 404 — brief criterion 5, and `auth-flow.spec.ts`
    // asserts that status code through a browser. A redirect here would look
    // tidier and would silently bypass the guard that does the work.
    admin: null,
    "entry auth": APP_HOME_PATH,
    "recovery auth": null,
    gate: null,
    callback: null,
    asset: null,
  },
  rejected: {
    protected: NO_ACCESS_PATH,
    admin: NO_ACCESS_PATH,
    "entry auth": null,
    "recovery auth": null,
    gate: null,
    callback: null,
    asset: null,
  },
  suspended: {
    protected: NO_ACCESS_PATH,
    admin: NO_ACCESS_PATH,
    "entry auth": null,
    "recovery auth": null,
    gate: null,
    callback: null,
    asset: null,
  },
  "no profile row": {
    protected: SIGN_IN_PATH,
    admin: SIGN_IN_PATH,
    "entry auth": null,
    "recovery auth": null,
    gate: null,
    callback: null,
    asset: null,
  },
  admin: {
    // Criterion 11: the tiers are disjoint, so every (app) route sends an
    // admin home rather than rendering a shell whose whole job is task links.
    protected: ADMIN_HOME_PATH,
    admin: null,
    "entry auth": ADMIN_HOME_PATH,
    "recovery auth": null,
    gate: null,
    callback: null,
    asset: null,
  },
};

const CASES = CALLERS.flatMap((caller) =>
  GROUP_NAMES.flatMap((group) =>
    GROUPS[group].map((pathname) => ({
      label: caller.label,
      status: caller.status,
      role: caller.role,
      isSignedIn: caller.isSignedIn,
      group,
      pathname,
      expected: EXPECTED[caller.label][group],
    })),
  ),
);

describe("routeForStatus — the status x path-group matrix", () => {
  it.each(CASES)(
    "$label on $pathname ($group) -> $expected",
    ({ status, role, isSignedIn, pathname, expected }) => {
      expect(routeForStatus({ status, role, isSignedIn, pathname })).toBe(
        expected,
      );
    },
  );

  it("covers every status and every path group", () => {
    // Guards the table itself: adding an AccountStatus without adding a row
    // here should fail loudly rather than silently skip.
    expect(CALLERS).toHaveLength(7);
    expect(GROUP_NAMES).toHaveLength(7);
    expect(CASES).toHaveLength(
      CALLERS.length *
        GROUP_NAMES.reduce((total, group) => total + GROUPS[group].length, 0),
    );
  });
});

describe("routeForStatus — loop avoidance", () => {
  it("lets a pending user sit on /pending", () => {
    expect(
      routeForStatus({
        status: "pending",
        isSignedIn: true,
        pathname: "/pending",
      }),
    ).toBeNull();
  });

  it("lets a suspended user sit on /no-access", () => {
    expect(
      routeForStatus({
        status: "suspended",
        isSignedIn: true,
        pathname: "/no-access",
      }),
    ).toBeNull();
  });

  it("lets a rejected user sit on /no-access", () => {
    expect(
      routeForStatus({
        status: "rejected",
        isSignedIn: true,
        pathname: "/no-access",
      }),
    ).toBeNull();
  });

  it("lets a signed-out visitor sit on /sign-in", () => {
    expect(
      routeForStatus({ status: null, isSignedIn: false, pathname: "/sign-in" }),
    ).toBeNull();
  });

  it("sends an active user off /sign-in to /today", () => {
    expect(
      routeForStatus({
        status: "active",
        isSignedIn: true,
        pathname: "/sign-in",
      }),
    ).toBe("/today");
  });

  it("sends an active user off /sign-up to /today", () => {
    expect(
      routeForStatus({
        status: "active",
        isSignedIn: true,
        pathname: "/sign-up",
      }),
    ).toBe("/today");
  });

  it("sends an admin off /sign-in to /admin/users, not to /today", () => {
    expect(
      routeForStatus({
        status: "active",
        role: "admin",
        isSignedIn: true,
        pathname: "/sign-in",
      }),
    ).toBe(ADMIN_HOME_PATH);
  });

  it("lets an admin sit on /admin/users", () => {
    expect(
      routeForStatus({
        status: "active",
        role: "admin",
        isSignedIn: true,
        pathname: "/admin/users",
      }),
    ).toBeNull();
  });

  it("never redirects to a path it would redirect away from again", () => {
    // The fixed-point property, which is what "no loop" actually means: apply
    // the function to its own answer and it must settle immediately. Phase 5's
    // role rule is exactly the kind of addition this catches — an admin bounced
    // off /today to a path they would also be bounced off would spin forever.
    const everyPath = GROUP_NAMES.flatMap((group) => [...GROUPS[group]]);

    for (const caller of CALLERS) {
      for (const pathname of everyPath) {
        const destination = routeForStatus({
          status: caller.status,
          role: caller.role,
          isSignedIn: caller.isSignedIn,
          pathname,
        });
        if (destination === null) continue;

        expect(
          routeForStatus({
            status: caller.status,
            role: caller.role,
            isSignedIn: caller.isSignedIn,
            pathname: destination,
          }),
          `${caller.label} on ${pathname} -> ${destination} -> loops`,
        ).toBeNull();
      }
    }
  });

  it("lets every always-allowed prefix through for every caller", () => {
    for (const caller of CALLERS) {
      for (const prefix of ALWAYS_ALLOWED_PREFIXES) {
        // `/sign-in` and `/sign-up` are the one documented exception: an
        // active user is moved on to their own tier rather than shown a
        // sign-in form.
        const expected =
          caller.status === "active" &&
          (prefix === "/sign-in" || prefix === "/sign-up")
            ? caller.role === "admin"
              ? ADMIN_HOME_PATH
              : APP_HOME_PATH
            : null;

        expect(
          routeForStatus({
            status: caller.status,
            role: caller.role,
            isSignedIn: caller.isSignedIn,
            pathname: prefix,
          }),
          `${caller.label} on ${prefix}`,
        ).toBe(expected);
      }
    }
  });
});

describe("routeForStatus — path handling", () => {
  it("treats the marketing root as public", () => {
    expect(
      routeForStatus({ status: null, isSignedIn: false, pathname: "/" }),
    ).toBeNull();
    expect(
      routeForStatus({ status: "pending", isSignedIn: true, pathname: "/" }),
    ).toBeNull();
  });

  it("lets API routes through — they do their own authorization", () => {
    expect(
      routeForStatus({
        status: "suspended",
        isSignedIn: true,
        pathname: "/api/trpc/profile.get",
      }),
    ).toBeNull();
  });

  it("ignores a trailing slash", () => {
    expect(
      routeForStatus({
        status: "pending",
        isSignedIn: true,
        pathname: "/pending/",
      }),
    ).toBeNull();
    expect(
      routeForStatus({
        status: "pending",
        isSignedIn: true,
        pathname: "/today/",
      }),
    ).toBe(PENDING_PATH);
  });

  it("matches allowed prefixes on segment boundaries only", () => {
    // `/pendings` must not inherit `/pending`'s pass-through.
    expect(
      routeForStatus({
        status: "pending",
        isSignedIn: true,
        pathname: "/pendings",
      }),
    ).toBe(PENDING_PATH);
    expect(
      routeForStatus({
        status: "pending",
        isSignedIn: true,
        pathname: "/sign-inbox",
      }),
    ).toBe(PENDING_PATH);
    // ...but a nested path under an allowed prefix still passes.
    expect(
      routeForStatus({
        status: "pending",
        isSignedIn: true,
        pathname: "/auth/callback/extra",
      }),
    ).toBeNull();
  });

  it("does not gate a protected admin path on status alone", () => {
    // Whether a caller may RENDER /admin/* is enforced by the (admin) layout
    // (`notFound()`) and independently by `adminProcedure`. Phase 5 taught this
    // function about role, but only to decide destinations — an active member
    // still passes through to /admin/users so the layout can 404 them, which is
    // what brief criterion 5 asks for and what `e2e/auth-flow.spec.ts` asserts.
    expect(
      routeForStatus({
        status: "active",
        isSignedIn: true,
        pathname: "/admin/users",
      }),
    ).toBeNull();
    expect(
      routeForStatus({
        status: "active",
        role: "member",
        isSignedIn: true,
        pathname: "/admin/users",
      }),
    ).toBeNull();
    expect(
      routeForStatus({
        status: "pending",
        isSignedIn: true,
        pathname: "/admin/users",
      }),
    ).toBe(PENDING_PATH);
  });

  it("treats an unreadable role as member, not as admin", () => {
    // Failing this direction is the safe one: an admin sent to /today is a
    // routing annoyance, whereas defaulting to admin would hand the admin
    // destination to a row nobody could read.
    expect(
      routeForStatus({
        status: "active",
        role: null,
        isSignedIn: true,
        pathname: "/today",
      }),
    ).toBeNull();
  });

  it("matches the admin prefix on segment boundaries only", () => {
    // `/administration` must not inherit `/admin`'s "this is your tier".
    expect(
      routeForStatus({
        status: "active",
        role: "admin",
        isSignedIn: true,
        pathname: "/administration",
      }),
    ).toBe(ADMIN_HOME_PATH);
    expect(
      routeForStatus({
        status: "active",
        role: "admin",
        isSignedIn: true,
        pathname: "/admin/users/9d0c1e",
      }),
    ).toBeNull();
  });
});

describe("isAlwaysAllowed", () => {
  it.each([
    "/",
    "/sign-in",
    "/sign-up",
    "/forgot-password",
    "/reset-password",
    "/pending",
    "/no-access",
    "/auth/callback",
    "/api/trpc/profile.get",
    "/_next/static/chunks/main.js",
    "/robots.txt",
    "/fonts/inter.woff2",
  ])("allows %s", (pathname) => {
    expect(isAlwaysAllowed(pathname)).toBe(true);
  });

  it.each(["/today", "/tasks/9d0c1e", "/overdue", "/settings", "/admin/users"])(
    "protects %s",
    (pathname) => {
      expect(isAlwaysAllowed(pathname)).toBe(false);
    },
  );

  it("allows every destination routeForStatus can return", () => {
    for (const destination of [SIGN_IN_PATH, PENDING_PATH, NO_ACCESS_PATH]) {
      expect(isAlwaysAllowed(destination)).toBe(true);
    }
    // The two homes are the destinations that are NOT always allowed — they are
    // the app itself, and only an active caller of the matching tier is sent
    // there. The fixed-point test above is what proves that is still loop-free.
    expect(isAlwaysAllowed(APP_HOME_PATH)).toBe(false);
    expect(isAlwaysAllowed(ADMIN_HOME_PATH)).toBe(false);
  });
});

describe("parseAccountRole", () => {
  it.each(["member", "admin"])("accepts %s", (value) => {
    expect(parseAccountRole(value)).toBe(value);
  });

  it.each([undefined, null, "", "ADMIN", "superuser", 1, {}, []])(
    "rejects %s as null",
    (value) => {
      expect(parseAccountRole(value)).toBeNull();
    },
  );
});

describe("parseAccountStatus", () => {
  it.each(["pending", "active", "rejected", "suspended"])(
    "accepts %s",
    (value) => {
      expect(parseAccountStatus(value)).toBe(value);
    },
  );

  it.each([undefined, null, "", "ACTIVE", "banned", 1, {}, []])(
    "rejects %s as null",
    (value) => {
      expect(parseAccountStatus(value)).toBeNull();
    },
  );

  it("fails closed: an unrecognised status cannot reach a protected route", () => {
    const status = parseAccountStatus("something-new");
    expect(
      routeForStatus({ status, isSignedIn: true, pathname: "/today" }),
    ).toBe(SIGN_IN_PATH);
  });
});
