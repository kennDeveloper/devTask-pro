"use client";

import { useState } from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { authCallbackUrl } from "@/lib/auth/redirect";
import {
  authErrorCode,
  describeAuthError,
  validateForgotPassword,
  type FieldErrors,
  type ForgotPasswordInput,
} from "@/lib/auth/validators";
import { createClient } from "@/lib/supabase/client";

/**
 * The reset link lands on the PKCE callback, which exchanges the code for a
 * recovery session and then forwards to /reset-password with that session in
 * place. Without the `next` hop the user would arrive signed in at /today with
 * no way to set a password.
 */
const RESET_REDIRECT_PATH = "/reset-password";

export default function ForgotPasswordPage() {
  const [supabase] = useState(createClient);

  const [email, setEmail] = useState("");
  const [errors, setErrors] = useState<FieldErrors<ForgotPasswordInput>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    const result = validateForgotPassword({ email });
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }

    setErrors({});
    setPending(true);

    const { error } = await supabase.auth.resetPasswordForEmail(
      result.data.email,
      { redirectTo: authCallbackUrl(RESET_REDIRECT_PATH) },
    );

    // Account enumeration: the confirmation is identical whether or not the
    // address exists, so a failure here must not become a distinguishing
    // signal. The single exception is a rate limit — it is a property of the
    // sender, not of the address, and swallowing it would leave the user
    // waiting for mail that was never sent.
    const code = authErrorCode(error);
    if (code === "over_email_send_rate_limit" || code === "over_request_rate_limit") {
      setFormError(describeAuthError(error));
      setPending(false);
      return;
    }

    setSentTo(result.data.email);
    setPending(false);
  }

  if (sentTo) {
    return (
      <div className="space-y-6">
        <header className="space-y-2">
          <Text variant="h1">Check your inbox</Text>
          <Text variant="body-sm" tone="secondary">
            If <span className="font-medium text-ink">{sentTo}</span> has an
            account, we’ve sent it a link for setting a new password.
          </Text>
        </header>

        <Text variant="helper">
          The link works once and expires after an hour. Nothing arrived? Check
          the spam folder, then try again.
        </Text>

        <Button variant="outline" className="w-full" asChild>
          <Link href="/sign-in">Back to sign in</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <Text variant="h1">Reset your password</Text>
        <Text variant="body-sm" tone="secondary">
          Enter your email address and we’ll send you a link for setting a new
          one.
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
        <Field label="Email" htmlFor="email" error={errors.email}>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            autoFocus
            placeholder="you@example.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            aria-invalid={errors.email ? true : undefined}
            aria-describedby={errors.email ? "email-error" : undefined}
          />
        </Field>

        <Button type="submit" className="w-full" loading={pending}>
          Send reset link
        </Button>
      </form>

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
