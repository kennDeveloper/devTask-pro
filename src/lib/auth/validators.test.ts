import { describe, expect, it } from "vitest";

import { DEFAULT_POST_AUTH_PATH, safeNextPath } from "./redirect";
import {
  AUTH_ERROR_FALLBACK,
  AUTH_ERROR_MESSAGES,
  AUTH_MESSAGES,
  PASSWORD_MIN_LENGTH,
  authErrorCode,
  describeAuthError,
  isEmailNotConfirmed,
  validateForgotPassword,
  validateResetPassword,
  validateSignIn,
  validateSignUp,
} from "./validators";

/**
 * These are the rules the four auth screens enforce. The screens hold no
 * validation logic of their own — they render `AUTH_MESSAGES` verbatim through
 * `<Field error>` — so asserting on the exact strings here is asserting on
 * what the user reads.
 */

const VALID_PASSWORD = "correct-horse";

describe("password rule", () => {
  it("is length-only, at 8 characters", () => {
    expect(PASSWORD_MIN_LENGTH).toBe(8);
    // A long, all-lowercase, symbol-free password is fine. Composition rules
    // would reject this and wave through "Pa$$w0rd" — deliberately not done.
    expect(validateSignUp({
      email: "dev@example.com",
      password: "correcthorsebattery",
      confirmPassword: "correcthorsebattery",
    }).ok).toBe(true);
  });
});

describe("validateSignUp", () => {
  const valid = {
    email: "dev@example.com",
    password: VALID_PASSWORD,
    confirmPassword: VALID_PASSWORD,
  };

  it("accepts a valid payload and returns the parsed data", () => {
    const result = validateSignUp(valid);
    expect(result).toEqual({ ok: true, data: valid });
  });

  it("trims the email before handing it to Supabase", () => {
    const result = validateSignUp({ ...valid, email: "  dev@example.com  " });
    expect(result.ok && result.data.email).toBe("dev@example.com");
  });

  it("rejects an invalid email with the message the form shows", () => {
    const result = validateSignUp({ ...valid, email: "dev@example" });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors.email).toBe(AUTH_MESSAGES.emailInvalid);
  });

  it("rejects a blank email with a different message than a malformed one", () => {
    const result = validateSignUp({ ...valid, email: "   " });
    expect(!result.ok && result.errors.email).toBe(AUTH_MESSAGES.emailRequired);
  });

  it.each(["", "a", "1234567"])(
    "rejects a password under 8 characters (%j)",
    (password) => {
      const result = validateSignUp({
        ...valid,
        password,
        confirmPassword: password,
      });
      expect(result.ok).toBe(false);
      expect(!result.ok && result.errors.password).toBe(
        password === ""
          ? AUTH_MESSAGES.passwordRequired
          : AUTH_MESSAGES.passwordTooShort,
      );
    },
  );

  it("accepts a password of exactly 8 characters", () => {
    const eight = "12345678";
    expect(eight).toHaveLength(PASSWORD_MIN_LENGTH);
    expect(
      validateSignUp({ ...valid, password: eight, confirmPassword: eight }).ok,
    ).toBe(true);
  });

  it("rejects a mismatched confirmation, reported on the confirm field", () => {
    const result = validateSignUp({
      ...valid,
      confirmPassword: `${VALID_PASSWORD}x`,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.confirmPassword).toBe(AUTH_MESSAGES.passwordMismatch);
    // The mismatch must not be blamed on the field the user typed first.
    expect(result.errors.password).toBeUndefined();
  });

  it("rejects an empty confirmation with its own message", () => {
    const result = validateSignUp({ ...valid, confirmPassword: "" });
    expect(!result.ok && result.errors.confirmPassword).toBe(
      AUTH_MESSAGES.confirmRequired,
    );
  });

  it("reports every bad field at once, one message each", () => {
    const result = validateSignUp({
      email: "nope",
      password: "short",
      confirmPassword: "",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual({
      email: AUTH_MESSAGES.emailInvalid,
      password: AUTH_MESSAGES.passwordTooShort,
      confirmPassword: AUTH_MESSAGES.confirmRequired,
    });
  });

  it("rejects non-string input without throwing", () => {
    expect(validateSignUp(undefined).ok).toBe(false);
    expect(validateSignUp({ email: 42, password: null }).ok).toBe(false);
  });
});

describe("validateSignIn", () => {
  it("accepts an email and any non-empty password", () => {
    // No length check on sign-in: an account may predate the rule, and
    // rejecting locally would say which half of the pair was wrong.
    const result = validateSignIn({ email: "dev@example.com", password: "x" });
    expect(result).toEqual({
      ok: true,
      data: { email: "dev@example.com", password: "x" },
    });
  });

  it("rejects an invalid email", () => {
    const result = validateSignIn({ email: "dev@", password: VALID_PASSWORD });
    expect(!result.ok && result.errors.email).toBe(AUTH_MESSAGES.emailInvalid);
  });

  it("rejects an empty password", () => {
    const result = validateSignIn({ email: "dev@example.com", password: "" });
    expect(!result.ok && result.errors.password).toBe(
      AUTH_MESSAGES.passwordRequired,
    );
  });
});

describe("validateForgotPassword", () => {
  it("accepts a valid email", () => {
    expect(validateForgotPassword({ email: "dev@example.com" })).toEqual({
      ok: true,
      data: { email: "dev@example.com" },
    });
  });

  it("rejects an invalid email", () => {
    const result = validateForgotPassword({ email: "not-an-email" });
    expect(!result.ok && result.errors.email).toBe(AUTH_MESSAGES.emailInvalid);
  });
});

describe("validateResetPassword", () => {
  it("accepts a matching pair of at least 8 characters", () => {
    expect(
      validateResetPassword({
        password: VALID_PASSWORD,
        confirmPassword: VALID_PASSWORD,
      }).ok,
    ).toBe(true);
  });

  it("rejects a short password", () => {
    const result = validateResetPassword({
      password: "short",
      confirmPassword: "short",
    });
    expect(!result.ok && result.errors.password).toBe(
      AUTH_MESSAGES.passwordTooShort,
    );
  });

  it("rejects a mismatched confirmation", () => {
    const result = validateResetPassword({
      password: VALID_PASSWORD,
      confirmPassword: "something-else",
    });
    expect(!result.ok && result.errors.confirmPassword).toBe(
      AUTH_MESSAGES.passwordMismatch,
    );
  });
});

describe("describeAuthError", () => {
  it("gives bad credentials a plain sentence", () => {
    expect(describeAuthError({ code: "invalid_credentials" })).toBe(
      AUTH_ERROR_MESSAGES.invalid_credentials,
    );
  });

  it("gives an unconfirmed account its own message pointing at the inbox", () => {
    const message = describeAuthError({ code: "email_not_confirmed" });
    expect(message).toBe(AUTH_ERROR_MESSAGES.email_not_confirmed);
    expect(message).not.toBe(AUTH_ERROR_MESSAGES.invalid_credentials);
    expect(message).toMatch(/confirm/i);
  });

  it("recovers the code from the message when Supabase omits it", () => {
    expect(authErrorCode({ message: "Invalid login credentials" })).toBe(
      "invalid_credentials",
    );
    expect(authErrorCode({ message: "Email not confirmed" })).toBe(
      "email_not_confirmed",
    );
    expect(describeAuthError({ message: "Email not confirmed" })).toBe(
      AUTH_ERROR_MESSAGES.email_not_confirmed,
    );
  });

  it("points an already-registered address at sign-in", () => {
    expect(describeAuthError({ code: "user_already_exists" })).toBe(
      AUTH_ERROR_MESSAGES.user_already_exists,
    );
    expect(describeAuthError({ message: "User already registered" })).toMatch(
      /already registered/i,
    );
  });

  it("passes through an unmapped Supabase message rather than swallowing it", () => {
    expect(
      describeAuthError({ code: "unexpected_failure", message: "Boom" }),
    ).toBe("Boom");
  });

  it("falls back when there is nothing usable to show", () => {
    expect(describeAuthError(null)).toBe(AUTH_ERROR_FALLBACK);
    expect(describeAuthError({})).toBe(AUTH_ERROR_FALLBACK);
    expect(describeAuthError({ message: "   " })).toBe(AUTH_ERROR_FALLBACK);
  });

  it("identifies the unconfirmed case for the sign-in screen", () => {
    expect(isEmailNotConfirmed({ code: "email_not_confirmed" })).toBe(true);
    expect(isEmailNotConfirmed({ code: "invalid_credentials" })).toBe(false);
    expect(isEmailNotConfirmed(null)).toBe(false);
  });
});

/**
 * `safeNextPath` validates the one piece of attacker-controllable input in the
 * auth flow — the callback's `?next=` — so it is tested alongside the form
 * validators rather than left to an integration test.
 */
describe("safeNextPath", () => {
  it("allows an in-app absolute path", () => {
    expect(safeNextPath("/reset-password")).toBe("/reset-password");
    expect(safeNextPath("/settings?tab=account")).toBe("/settings?tab=account");
  });

  it("falls back when there is no next", () => {
    expect(safeNextPath(null)).toBe(DEFAULT_POST_AUTH_PATH);
    expect(safeNextPath(undefined)).toBe(DEFAULT_POST_AUTH_PATH);
    expect(safeNextPath("")).toBe(DEFAULT_POST_AUTH_PATH);
  });

  it("rejects absolute and relative URLs", () => {
    expect(safeNextPath("https://evil.example/steal")).toBe(
      DEFAULT_POST_AUTH_PATH,
    );
    expect(safeNextPath("today")).toBe(DEFAULT_POST_AUTH_PATH);
  });

  it("rejects protocol-relative URLs, which start with a slash but leave the origin", () => {
    // new URL("//evil.example", origin) resolves to http://evil.example —
    // a startsWith("/") check alone is an open redirect.
    expect(safeNextPath("//evil.example")).toBe(DEFAULT_POST_AUTH_PATH);
    expect(safeNextPath("/\\evil.example")).toBe(DEFAULT_POST_AUTH_PATH);
  });

  it("honours an explicit fallback", () => {
    expect(safeNextPath(null, "/pending")).toBe("/pending");
  });
});
