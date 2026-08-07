import { describe, expect, it } from "vitest";

import { PROFILE_STATUSES, type ProfileStatus } from "@/lib/db/schema";

import {
  ADMIN_ACTIONS,
  ADMIN_ACTION_SPECS,
  actionsFor,
  canApply,
  isAdminAction,
  resultOf,
  stampsApproval,
  type AdminAction,
} from "./transitions";

/**
 * The transition table, asserted exhaustively.
 *
 * Every `(action, status)` pair is covered — not a sample — because the failure
 * this guards against is not "the table is wrong" but "somebody added a status
 * and only half the table learned about it". The expected grid below is written
 * out by hand on purpose: deriving it from `ADMIN_ACTION_SPECS` would assert
 * that the table agrees with itself.
 */

/** action -> the statuses it is legal from. The hand-written half of the pair. */
const LEGAL: Record<AdminAction, ProfileStatus[]> = {
  approve: ["pending", "rejected"],
  reject: ["pending"],
  suspend: ["active"],
  reinstate: ["suspended"],
};

describe("the transition table", () => {
  const PAIRS = ADMIN_ACTIONS.flatMap((action) =>
    PROFILE_STATUSES.map((status) => ({
      action,
      status,
      legal: LEGAL[action].includes(status),
    })),
  );

  it("covers every action against every status", () => {
    expect(PAIRS).toHaveLength(ADMIN_ACTIONS.length * PROFILE_STATUSES.length);
    expect(PAIRS).toHaveLength(16);
  });

  it.each(PAIRS)(
    "canApply($action, $status) === $legal",
    ({ action, status, legal }) => {
      expect(canApply(action, status)).toBe(legal);
    },
  );

  it.each([
    ["approve", "active"],
    ["reject", "rejected"],
    ["suspend", "suspended"],
    ["reinstate", "active"],
  ] as const)("%s results in %s", (action, result) => {
    expect(resultOf(action)).toBe(result);
  });
});

describe("actionsFor — what a row offers", () => {
  it.each([
    // A signup awaiting a decision gets the decision, both ways.
    ["pending", ["approve", "reject"]],
    // Somebody already in can only be switched off. "Reject" is a signup
    // decision and must not be a second word for "suspend".
    ["active", ["suspend"]],
    // Both refusals are reversible, and each has exactly one way back.
    ["rejected", ["approve"]],
    ["suspended", ["reinstate"]],
  ] as const)("offers %s: %j", (status, expected) => {
    expect(actionsFor(status)).toEqual(expected);
  });

  it("never offers an action it would then refuse", () => {
    for (const status of PROFILE_STATUSES) {
      for (const action of actionsFor(status)) {
        expect(canApply(action, status)).toBe(true);
      }
    }
  });

  it("offers something for every status — no dead-end row", () => {
    for (const status of PROFILE_STATUSES) {
      expect(actionsFor(status).length).toBeGreaterThan(0);
    }
  });
});

describe("the flags the UI and the router read", () => {
  /** Criterion 13: the two actions that take access away must confirm first. */
  it("marks reject and suspend destructive, and only those", () => {
    const destructive = ADMIN_ACTIONS.filter(
      (action) => ADMIN_ACTION_SPECS[action].destructive,
    );
    expect(destructive).toEqual(["reject", "suspend"]);
  });

  it("gives every destructive action confirm copy, and the others none", () => {
    for (const action of ADMIN_ACTIONS) {
      const spec = ADMIN_ACTION_SPECS[action];
      if (spec.destructive) {
        expect(spec.confirmTitle.length).toBeGreaterThan(0);
        expect(spec.confirmBody.length).toBeGreaterThan(0);
      } else {
        expect(spec.confirmTitle).toBe("");
      }
    }
  });

  /**
   * ONLY SUSPEND BANS, and this is the guard on that.
   *
   * `docs/gsd/devtask-pro-v1.md` decided the Supabase ban for *suspension*.
   * Extending it to `reject` reads like symmetry and breaks criterion 2: a
   * banned account cannot sign in at all — measured, `signInWithPassword`
   * returns `user_banned` — so a rejected user could never reach the
   * `/no-access` screen they are supposed to **see**. They would get a generic
   * sign-in failure instead, which is exactly what the (gate) route group exists
   * to avoid. This spec failed the day that was tried.
   */
  it("bans on suspend and on nothing else", () => {
    const banning = ADMIN_ACTIONS.filter(
      (action) => ADMIN_ACTION_SPECS[action].bans,
    );
    expect(banning).toEqual(["suspend"]);
  });

  /**
   * The other three lift it, so the auth ban is a pure function of the last
   * action rather than of the order actions arrived in. Reinstate is the one
   * that lifts a ban which really exists; approve and reject are no-ops in
   * practice and are written the same way so there is a single code path.
   */
  it("lifts the ban on every action that leaves the account usable", () => {
    for (const action of ADMIN_ACTIONS) {
      if (action === "suspend") continue;
      expect(ADMIN_ACTION_SPECS[action].bans).toBe(false);
    }
  });

  it("stamps approval exactly when the account ends up active", () => {
    for (const action of ADMIN_ACTIONS) {
      expect(stampsApproval(action)).toBe(resultOf(action) === "active");
    }
  });
});

describe("isAdminAction", () => {
  it.each([...ADMIN_ACTIONS])("accepts %s", (value) => {
    expect(isAdminAction(value)).toBe(true);
  });

  it.each([undefined, null, "", "Approve", "delete", "promote", 1, {}, []])(
    "rejects %s",
    (value) => {
      expect(isAdminAction(value)).toBe(false);
    },
  );
});
