import { describe, expect, it } from "vitest";

import { ADMIN_ACTIONS } from "@/lib/admin/transitions";
import { PROFILE_STATUSES } from "@/lib/db/schema";

import {
  ACCOUNT_COLUMNS,
  NEVER_SIGNED_IN,
  accountSecondaryLine,
  accountStatusLabel,
  accountStatusTone,
  actionControlName,
  formatLastSignIn,
  formatSignupDate,
  resetControlName,
} from "./account-presentation";

/**
 * The presentation rules, as pure assertions.
 *
 * The date tests are the reason this file exists as a unit test rather than
 * being left to the component specs: a formatter that reads the ambient zone
 * passes in one environment and produces a hydration mismatch in another, and
 * the only way to catch that is to assert the exact string against a fixed
 * input.
 */

describe("columns", () => {
  it("names five columns, and none of them is task-shaped", () => {
    const keys = ACCOUNT_COLUMNS.map((column) => column.key);
    expect(keys).toEqual([
      "account",
      "status",
      "signedUp",
      "lastSignIn",
      "actions",
    ]);
  });

  it("hides only the actions header, and gives every column a skeleton width", () => {
    for (const column of ACCOUNT_COLUMNS) {
      expect(column.skeletonWidth).toMatch(/^w-/);
      expect(Boolean(column.labelHidden)).toBe(column.key === "actions");
    }
  });
});

describe("status presentation", () => {
  it("gives every status a tone and a label", () => {
    for (const status of PROFILE_STATUSES) {
      expect(accountStatusTone(status)).toBeTruthy();
      expect(accountStatusLabel(status)).toBeTruthy();
    }
  });

  /**
   * The two refusals look different to the admin and identical to the user.
   * `/no-access` explains neither; this screen has to distinguish them, because
   * "was this person ever let in?" changes what reinstating them means.
   */
  it("distinguishes rejected from suspended", () => {
    expect(accountStatusTone("rejected")).not.toBe(
      accountStatusTone("suspended"),
    );
    expect(accountStatusLabel("rejected")).not.toBe(
      accountStatusLabel("suspended"),
    );
  });

  /**
   * `profile-form.ts` says "Awaiting approval", which is written for the account
   * holder reading their own settings page. The admin is the person being
   * awaited, so from their side it is just the queue.
   */
  it("says Pending rather than the account holder's wording", () => {
    expect(accountStatusLabel("pending")).toBe("Pending");
  });

  it("passes an unrecognised status straight through rather than rendering undefined", () => {
    expect(accountStatusLabel("archived")).toBe("archived");
  });
});

describe("control names", () => {
  it("names every action against the account's email", () => {
    for (const action of ADMIN_ACTIONS) {
      const name = actionControlName(action, "ada@example.com");
      expect(name).toMatch(/ada@example\.com$/);
      expect(name.length).toBeGreaterThan("ada@example.com".length);
    }
  });

  /**
   * Playwright's strict mode fails on an ambiguous locator, so two rows must
   * never produce the same control name. The email is the only field guaranteed
   * unique — a display name is optional and shareable.
   */
  it("produces a distinct name per account", () => {
    expect(actionControlName("approve", "a@example.com")).not.toBe(
      actionControlName("approve", "b@example.com"),
    );
  });

  it("produces a distinct name per action", () => {
    const names = ADMIN_ACTIONS.map((a) => actionControlName(a, "x@y.com"));
    expect(new Set(names).size).toBe(names.length);
  });

  it("does not collide with the reset control", () => {
    const reset = resetControlName("ada@example.com");
    for (const action of ADMIN_ACTIONS) {
      expect(actionControlName(action, "ada@example.com")).not.toBe(reset);
    }
  });
});

describe("dates are rendered in a fixed zone and locale", () => {
  /**
   * The suffix is not decoration. Everywhere else in devtask-pro a date is the
   * account holder's, rendered in their zone; these are audit facts read by an
   * administrator who may share a zone with nobody on the list, so the column is
   * pinned to UTC and says so.
   */
  it("formats a signup date without a time", () => {
    expect(formatSignupDate("2026-08-01T23:30:00.000Z")).toBe("1 Aug 2026");
  });

  it("formats a last sign-in with the time and names the zone", () => {
    expect(formatLastSignIn("2026-08-05T09:30:00.000Z")).toBe(
      "5 Aug 2026, 09:30 UTC",
    );
  });

  it("renders midnight as 00:00, never 24:00", () => {
    expect(formatLastSignIn("2026-08-05T00:00:00.000Z")).toBe(
      "5 Aug 2026, 00:00 UTC",
    );
  });

  /**
   * "Never" is a real answer. An account approved but never used is a different
   * thing from one used last week, and an em dash would leave the admin
   * guessing which.
   */
  it("says Never rather than a dash for an account that has not signed in", () => {
    expect(formatLastSignIn(null)).toBe(NEVER_SIGNED_IN);
    expect(NEVER_SIGNED_IN).toBe("Never");
  });

  it("passes unparseable input through rather than rendering Invalid Date", () => {
    expect(formatSignupDate("not a date")).toBe("not a date");
    expect(formatLastSignIn("not a date")).toBe("not a date");
  });
});

describe("accountSecondaryLine", () => {
  it.each([
    [null, null],
    [undefined, null],
    ["", null],
    ["   ", null],
    ["Ada Lovelace", "Ada Lovelace"],
  ])("%s -> %s", (input, expected) => {
    expect(accountSecondaryLine(input as string | null)).toBe(expected);
  });
});
