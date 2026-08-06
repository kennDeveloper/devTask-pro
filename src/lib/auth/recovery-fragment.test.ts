import { describe, expect, it } from "vitest";

import {
  hasRecoveryFragment,
  parseRecoveryFragment,
} from "./recovery-fragment";

/**
 * The recovery-fragment parser.
 *
 * These cases are the shapes GoTrue actually emits, taken from links captured
 * off the local stack rather than invented — including the empty `sb=` parameter
 * it appends, which is the kind of thing a hand-written parser trips on.
 */

const ACCESS = "eyJhbGciOiJFUzI1NiJ9.payload.signature";
const REFRESH = "r4p4n3zzqug7";

/** A real link's fragment, parameter order and all. */
const RECOVERY = `#access_token=${ACCESS}&expires_at=1786012026&expires_in=3600&refresh_token=${REFRESH}&sb=&token_type=bearer&type=recovery`;

describe("parseRecoveryFragment", () => {
  it("reads both tokens out of a real recovery fragment", () => {
    expect(parseRecoveryFragment(RECOVERY)).toEqual({
      accessToken: ACCESS,
      refreshToken: REFRESH,
    });
  });

  it("works with or without the leading hash", () => {
    expect(parseRecoveryFragment(RECOVERY.slice(1))).toEqual(
      parseRecoveryFragment(RECOVERY),
    );
  });

  it.each([
    ["an empty string", ""],
    ["a bare hash", "#"],
    ["a PKCE callback's empty fragment", "#"],
  ])("returns null for %s", (_label, hash) => {
    expect(parseRecoveryFragment(hash)).toBeNull();
  });

  /**
   * GoTrue uses this same fragment shape for magic links, invites and
   * email-change confirmations. This page exists to set a password; adopting a
   * session that arrived for another reason would be a different feature
   * happening by accident.
   */
  it.each(["magiclink", "invite", "signup", "email_change"])(
    "refuses a %s grant",
    (type) => {
      expect(
        parseRecoveryFragment(
          `#access_token=${ACCESS}&refresh_token=${REFRESH}&type=${type}`,
        ),
      ).toBeNull();
    },
  );

  it("refuses a grant with no type at all", () => {
    expect(
      parseRecoveryFragment(
        `#access_token=${ACCESS}&refresh_token=${REFRESH}`,
      ),
    ).toBeNull();
  });

  /** An access token with no refresh token dies in an hour, mid-form. */
  it("refuses a half grant", () => {
    expect(
      parseRecoveryFragment(`#access_token=${ACCESS}&type=recovery`),
    ).toBeNull();
    expect(
      parseRecoveryFragment(`#refresh_token=${REFRESH}&type=recovery`),
    ).toBeNull();
  });

  /**
   * An expired or already-spent link comes back this way. It must reach the
   * page's honest "no longer valid" screen rather than a form that cannot
   * possibly submit.
   */
  it.each([
    "#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired",
    `#access_token=${ACCESS}&refresh_token=${REFRESH}&type=recovery&error=access_denied`,
    `#access_token=${ACCESS}&refresh_token=${REFRESH}&type=recovery&error_code=otp_expired`,
  ])("returns null when the fragment carries an error", (hash) => {
    expect(parseRecoveryFragment(hash)).toBeNull();
  });
});

describe("hasRecoveryFragment", () => {
  it("agrees with the parser on every input", () => {
    for (const hash of [
      RECOVERY,
      "",
      "#",
      `#access_token=${ACCESS}&type=recovery`,
      "#error=access_denied",
    ]) {
      expect(hasRecoveryFragment(hash)).toBe(
        parseRecoveryFragment(hash) !== null,
      );
    }
  });
});
