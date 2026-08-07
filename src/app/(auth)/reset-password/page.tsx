"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Text } from "@/components/ui/text";
import { parseRecoveryFragment } from "@/lib/auth/recovery-fragment";
import { DEFAULT_POST_AUTH_PATH } from "@/lib/auth/redirect";
import {
  AUTH_MESSAGES,
  describeAuthError,
  validateResetPassword,
  type FieldErrors,
  type ResetPasswordInput,
} from "@/lib/auth/validators";
import { createClient } from "@/lib/supabase/client";

/**
 * Whether a recovery session actually exists. Arriving without one is normal —
 * the link is single-use and hour-limited — and must not render a form that
 * cannot possibly work.
 *
 * ## Two ways a session gets here, and the page has to handle both
 *
 * 1. **PKCE**, when the user asked from `/forgot-password` in this browser. The
 *    verifier is in a cookie, `/auth/callback` exchanges the code, and the
 *    session is already in place before this page renders. `getSession()` finds
 *    it and there is nothing else to do.
 *
 * 2. **Implicit**, when an *admin* sent the reset (phase 5). PKCE is impossible
 *    there by construction — the verifier would have to travel from the server
 *    to somebody else's browser — so GoTrue puts the whole session in the URL
 *    fragment and points it straight here. The fragment never reaches a server,
 *    and the browser client will not adopt it either: `createBrowserClient`
 *    hard-sets `flowType: "pkce"` and supabase-js refuses an implicit URL in
 *    that mode. So this page adopts it explicitly, with `setSession()`.
 *
 * Without case 2, an admin-triggered reset lands on "this link is no longer
 * valid" while holding a perfectly good session in the address bar.
 */
type RecoveryState = "checking" | "ready" | "missing";

export default function ResetPasswordPage() {
  const router = useRouter();
  const [supabase] = useState(createClient);

  const [recovery, setRecovery] = useState<RecoveryState>("checking");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [errors, setErrors] = useState<FieldErrors<ResetPasswordInput>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let active = true;

    async function establish() {
      // Case 2 first: an admin-sent link carries the session in the fragment.
      // `setSession` does not care which flow produced the tokens, which is the
      // whole reason it is used here instead of leaving it to the client's own
      // URL detection.
      const grant = parseRecoveryFragment(window.location.hash);
      if (grant) {
        const { error } = await supabase.auth.setSession({
          access_token: grant.accessToken,
          refresh_token: grant.refreshToken,
        });

        // Strip the fragment either way. It is a live credential: leaving it in
        // the address bar puts it in history and in any copied URL, and a reload
        // would re-submit a token that is now spent.
        window.history.replaceState(
          null,
          "",
          window.location.pathname + window.location.search,
        );

        if (!active) return;
        if (!error) {
          setRecovery("ready");
          return;
        }
        // A rejected grant is a spent or tampered link — fall through to the
        // ordinary check, which will find no session and say so honestly.
      }

      const { data } = await supabase.auth.getSession();
      if (!active) return;
      setRecovery(data.session ? "ready" : "missing");
    }

    void establish();

    return () => {
      active = false;
    };
  }, [supabase]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    const result = validateResetPassword({ password, confirmPassword });
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }

    setErrors({});
    setPending(true);

    const { error } = await supabase.auth.updateUser({
      password: result.data.password,
    });

    if (error) {
      setFormError(describeAuthError(error));
      setPending(false);
      return;
    }

    // `pending` stays true through navigation. `refresh()` re-runs the
    // middleware so it routes by account status rather than reusing the RSC
    // payload it cached before the password changed.
    router.push(DEFAULT_POST_AUTH_PATH);
    router.refresh();
  }

  if (recovery === "checking") {
    return (
      <div className="space-y-8">
        <header className="space-y-2">
          <Text variant="h1">Choose a new password</Text>
          <Skeleton className="h-4 w-64" />
        </header>
        <div className="space-y-5">
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-full" />
        </div>
      </div>
    );
  }

  if (recovery === "missing") {
    return (
      <div className="space-y-6">
        <header className="space-y-2">
          <Text variant="h1">This link is no longer valid</Text>
          <Text variant="body-sm" tone="secondary">
            Password reset links work once and expire after an hour. Request a
            new one and we’ll email it straight away.
          </Text>
        </header>

        <Button className="w-full" asChild>
          <Link href="/forgot-password">Request a new link</Link>
        </Button>

        <Text variant="body-sm" tone="secondary" align="center">
          Remembered it?{" "}
          <Link
            href="/sign-in"
            className="text-accent underline-offset-4 hover:underline"
          >
            Sign in
          </Link>
        </Text>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <Text variant="h1">Choose a new password</Text>
        <Text variant="body-sm" tone="secondary">
          Once it’s saved you’ll be signed in on this device. Any other sessions
          stay as they are.
        </Text>
      </header>

      {formError && (
        <div
          role="alert"
          className="rounded-md border border-trip/40 bg-trip-soft px-3.5 py-3"
        >
          <Text variant="body-sm" tone="destructive">
            {formError}
          </Text>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-5" noValidate>
        <Field
          label="New password"
          htmlFor="password"
          hint={AUTH_MESSAGES.passwordTooShort}
          error={errors.password}
        >
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            autoFocus
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-invalid={errors.password ? true : undefined}
            aria-describedby={
              errors.password ? "password-error" : "password-hint"
            }
          />
        </Field>

        <Field
          label="Confirm new password"
          htmlFor="confirm-password"
          error={errors.confirmPassword}
        >
          <Input
            id="confirm-password"
            name="confirmPassword"
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            aria-invalid={errors.confirmPassword ? true : undefined}
            aria-describedby={
              errors.confirmPassword ? "confirm-password-error" : undefined
            }
          />
        </Field>

        <Button type="submit" className="w-full" loading={pending}>
          Save password
        </Button>
      </form>
    </div>
  );
}
