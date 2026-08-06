"use client";

import { useState } from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { authCallbackUrl } from "@/lib/auth/redirect";
import {
  AUTH_MESSAGES,
  describeAuthError,
  validateSignUp,
  type FieldErrors,
  type SignUpInput,
} from "@/lib/auth/validators";
import { createClient } from "@/lib/supabase/client";

export default function SignUpPage() {
  const [supabase] = useState(createClient);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [errors, setErrors] = useState<FieldErrors<SignUpInput>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  /** Non-null once the confirmation mail has been requested, holding the address. */
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    const result = validateSignUp({ email, password, confirmPassword });
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }

    setErrors({});
    setPending(true);

    const { error } = await supabase.auth.signUp({
      email: result.data.email,
      password: result.data.password,
      options: { emailRedirectTo: authCallbackUrl() },
    });

    if (error) {
      // Supabase itself decides how much to reveal. With email confirmation on
      // it normally does NOT error for an address that already exists — it
      // returns a decoy user with an empty `identities` array and sends no
      // mail, so that the response is indistinguishable from a fresh signup.
      // We keep that property by not inspecting `identities` at all: every
      // non-error outcome renders the same "check your inbox" screen. When
      // Supabase *does* return `user_already_exists` (confirmations off, or a
      // provider that reports it), it has already disclosed the account, so
      // relaying that message leaks nothing further.
      setFormError(describeAuthError(error));
      setPending(false);
      return;
    }

    // Confirmation is on, so there is no session yet and nothing to redirect
    // to — the next step happens in the user's inbox.
    setSentTo(result.data.email);
    setPending(false);
  }

  function startOver() {
    setSentTo(null);
    setPassword("");
    setConfirmPassword("");
  }

  if (sentTo) {
    return (
      <div className="space-y-6">
        <header className="space-y-2">
          <Text variant="h1">Check your inbox</Text>
          <Text variant="body-sm" tone="secondary">
            We sent a confirmation link to{" "}
            <span className="font-medium text-ink">{sentTo}</span>. Open it to
            confirm the address.
          </Text>
        </header>

        <Text variant="body-sm" tone="secondary">
          After that, an admin has to approve the account before you can start
          adding tasks. You’ll be able to sign in either way — we’ll tell you
          where things stand.
        </Text>

        <Text variant="helper">
          Nothing arrived? Check the spam folder. If this address already had an
          account, no new mail was sent —{" "}
          <Link
            href="/sign-in"
            className="text-accent underline-offset-4 hover:underline"
          >
            sign in
          </Link>{" "}
          instead.
        </Text>

        <Button variant="outline" className="w-full" onClick={startOver}>
          Use a different address
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <Text variant="h1">Create an account</Text>
        <Text variant="body-sm" tone="secondary">
          DevTask Pro is a private daily task tracker — you keep your own list,
          nobody else sees it.
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

        <Field
          label="Password"
          htmlFor="password"
          hint={AUTH_MESSAGES.passwordTooShort}
          error={errors.password}
        >
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-invalid={errors.password ? true : undefined}
            aria-describedby={
              errors.password ? "password-error" : "password-hint"
            }
          />
        </Field>

        <Field
          label="Confirm password"
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
          Create account
        </Button>
      </form>

      <Text variant="body-sm" tone="secondary" align="center">
        Already have an account?{" "}
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
