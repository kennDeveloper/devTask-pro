import { describe, expect, it } from "vitest";

import {
  ALWAYS_ALLOWED_PREFIXES,
  APP_HOME_PATH,
  isAlwaysAllowed,
  NO_ACCESS_PATH,
  parseAccountStatus,
  PENDING_PATH,
  routeForStatus,
  SIGN_IN_PATH,
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
];

const GROUPS = {
  // (app) routes — the things the gate exists to protect.
  protected: ["/today", "/tasks", "/tasks/9d0c1e", "/overdue", "/settings"],
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
    "entry auth": null,
    "recovery auth": null,
    gate: null,
    callback: null,
    asset: null,
  },
  pending: {
    protected: PENDING_PATH,
    "entry auth": null,
    "recovery auth": null,
    gate: null,
    callback: null,
    asset: null,
  },
  active: {
    protected: null,
    "entry auth": APP_HOME_PATH,
    "recovery auth": null,
    gate: null,
    callback: null,
    asset: null,
  },
  rejected: {
    protected: NO_ACCESS_PATH,
    "entry auth": null,
    "recovery auth": null,
    gate: null,
    callback: null,
    asset: null,
  },
  suspended: {
    protected: NO_ACCESS_PATH,
    "entry auth": null,
    "recovery auth": null,
    gate: null,
    callback: null,
    asset: null,
  },
  "no profile row": {
    protected: SIGN_IN_PATH,
    "entry auth": null,
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
    ({ status, isSignedIn, pathname, expected }) => {
      expect(routeForStatus({ status, isSignedIn, pathname })).toBe(expected);
    },
  );

  it("covers every status and every path group", () => {
    // Guards the table itself: adding an AccountStatus without adding a row
    // here should fail loudly rather than silently skip.
    expect(CALLERS).toHaveLength(6);
    expect(GROUP_NAMES).toHaveLength(6);
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

  it("never redirects to a path it would redirect away from again", () => {
    // The fixed-point property, which is what "no loop" actually means: apply
    // the function to its own answer and it must settle immediately.
    const everyPath = GROUP_NAMES.flatMap((group) => [...GROUPS[group]]);

    for (const caller of CALLERS) {
      for (const pathname of everyPath) {
        const destination = routeForStatus({
          status: caller.status,
          isSignedIn: caller.isSignedIn,
          pathname,
        });
        if (destination === null) continue;

        expect(
          routeForStatus({
            status: caller.status,
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
        // active user is moved on to the app rather than shown a sign-in form.
        const expected =
          caller.status === "active" &&
          (prefix === "/sign-in" || prefix === "/sign-up")
            ? APP_HOME_PATH
            : null;

        expect(
          routeForStatus({
            status: caller.status,
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
    // Role is enforced by the (admin) layout and adminProcedure in phase 5;
    // this function only knows about status.
    expect(
      routeForStatus({
        status: "active",
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
    // /today is the one destination that is NOT always allowed — it is the app,
    // and only an active user is sent there.
    expect(isAlwaysAllowed(APP_HOME_PATH)).toBe(false);
  });
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
