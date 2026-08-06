import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn() }));

import { createClient } from "@supabase/supabase-js";

import {
  BAN_DURATION,
  RECOVERY_REDIRECT_PATH,
  UNBAN_DURATION,
  resetAdminAuthClientForTests,
  sendRecoveryEmail,
  setAccountBanned,
} from "./admin";

/**
 * Unit tests for the auth-side admin operations. **No network is touched.**
 *
 * What is worth pinning here is the exact argument shape, because these are the
 * two calls whose semantics were measured against the running stack rather than
 * read off a type: `"none"` is what lifts a ban (not a zero duration, which
 * GoTrue rejects), and the recovery link must aim at the PKCE callback with a
 * `next` hop or the user lands signed-in with no way to set a password.
 */

const USER_ID = "11111111-1111-4111-8111-111111111111";

const updateUserById = vi.fn();
const resetPasswordForEmail = vi.fn();

function stubClient() {
  return {
    auth: {
      admin: { updateUserById },
      resetPasswordForEmail,
    },
  };
}

beforeEach(() => {
  resetAdminAuthClientForTests();
  updateUserById.mockReset().mockResolvedValue({ error: null });
  resetPasswordForEmail.mockReset().mockResolvedValue({ error: null });
  vi.mocked(createClient).mockReset();
  vi.mocked(createClient).mockReturnValue(
    stubClient() as unknown as ReturnType<typeof createClient>,
  );

  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54441");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-key");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "http://localhost:3002");
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetAdminAuthClientForTests();
});

describe("the client itself", () => {
  it("is built with the service-role key and no session persistence", async () => {
    await setAccountBanned(USER_ID, true);

    const [url, key, options] = vi.mocked(createClient).mock.calls[0];
    expect(url).toBe("http://127.0.0.1:54441");
    expect(key).toBe("service-role-key");
    expect(options?.auth).toMatchObject({
      autoRefreshToken: false,
      persistSession: false,
    });
  });

  it("is built once and reused", async () => {
    await setAccountBanned(USER_ID, true);
    await setAccountBanned(USER_ID, false);

    expect(vi.mocked(createClient)).toHaveBeenCalledTimes(1);
  });

  /**
   * Lazily, so `next build` — which imports the route graph for static analysis
   * — does not need the key. The failure has to be a clear message rather than
   * an undefined-key request that 401s somewhere far away.
   */
  it("says which variable is missing rather than failing at the network", async () => {
    resetAdminAuthClientForTests();
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");

    await expect(setAccountBanned(USER_ID, true)).rejects.toThrow(
      /SUPABASE_SERVICE_ROLE_KEY/,
    );
  });
});

describe("setAccountBanned", () => {
  it("bans for a hundred years", async () => {
    await setAccountBanned(USER_ID, true);

    expect(updateUserById).toHaveBeenCalledWith(USER_ID, {
      ban_duration: BAN_DURATION,
    });
  });

  /**
   * `"none"` is the value that lifts a ban. Measured: after it, `banned_until`
   * is unset and the refresh grant returns 200 again. A zero duration is not the
   * same thing and GoTrue does not accept it.
   */
  it("lifts a ban with the literal string 'none'", async () => {
    await setAccountBanned(USER_ID, false);

    expect(updateUserById).toHaveBeenCalledWith(USER_ID, {
      ban_duration: "none",
    });
    expect(UNBAN_DURATION).toBe("none");
  });

  /**
   * The caller has already moved the status column by this point. An auth call
   * that failed quietly would leave a suspended account whose session still
   * refreshes — a state the admin has to be told about.
   */
  it("throws when the auth service refuses", async () => {
    updateUserById.mockResolvedValue({ error: { message: "nope" } });

    await expect(setAccountBanned(USER_ID, true)).rejects.toThrow(/nope/);
  });
});

describe("sendRecoveryEmail", () => {
  it("aims the link at the PKCE callback with a next hop to /reset-password", async () => {
    await sendRecoveryEmail("member@example.com");

    const [email, options] = resetPasswordForEmail.mock.calls[0];
    expect(email).toBe("member@example.com");
    expect(options.redirectTo).toBe(
      `http://localhost:3002/auth/callback?next=${encodeURIComponent(
        RECOVERY_REDIRECT_PATH,
      )}`,
    );
  });

  it("surfaces a rate limit rather than reporting a send that never happened", async () => {
    resetPasswordForEmail.mockResolvedValue({
      error: { message: "over_email_send_rate_limit" },
    });

    await expect(sendRecoveryEmail("member@example.com")).rejects.toThrow(
      /rate_limit/,
    );
  });

  /**
   * The module must not offer `generateLink`. It hands a credential-bearing URL
   * to the admin's own browser, which is an account takeover with a button — see
   * the long note in `admin.ts`.
   */
  it("exposes no way to mint a link the admin could follow themselves", async () => {
    const exports = Object.keys(await import("./admin"));
    expect(exports).not.toContain("generateLink");
    expect(exports).not.toContain("adminAuthClient");
  });
});
