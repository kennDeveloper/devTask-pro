"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { DEFAULT_POST_AUTH_PATH } from "@/lib/auth/redirect";
import {
  describeAuthError,
  validateSignIn,
  type FieldErrors,
  type SignInInput,
} from "@/lib/auth/validators";
import { createClient } from "@/lib/supabase/client";

/** Shown when the callback route bounced back with `?error=auth`. */
const CALLBACK_FAILED =
  "That link didn’t work — it may already have been used, or expired. Sign in with your password below.";

export default function SignInPage() {
  // `useSearchParams` forces a client-side bailout unless a Suspense boundary
  // sits above it, which `next build` enforces at prerender time.
  return (
    <Suspense fallback={<SignInHeader />}>
      <SignInForm />
    </Suspense>
  );
}

function SignInHeader() {
  return (
    <header className="space-y-2">
      <Text variant="h1">Sign in</Text>
      <Text variant="body-sm" tone="secondary">
        Use the email and password you signed up with.
      </Text>
    </header>
  );
}

function SignInForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [supabase] = useState(createClient);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<FieldErrors<SignInInput>>({});
  const [formError, setFormError] = useState<string | null>(() =>
    searchParams.get("error") === "auth" ? CALLBACK_FAILED : null,
  );
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    const result = validateSignIn({ email, password });
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }

    setErrors({});
    setPending(true);

    const { error } = await supabase.auth.signInWithPassword(result.data);
    if (error) {
      // Bad credentials and an unconfirmed account get distinct sentences —
      // see AUTH_ERROR_MESSAGES.
      setFormError(describeAuthError(error));
      setPending(false);
      return;
    }

    // `pending` deliberately stays true: navigation is still in flight.
    // `refresh()` re-runs the middleware with the session cookie now set, so
    // it can route by account status instead of serving a stale RSC payload.
    router.push(DEFAULT_POST_AUTH_PATH);
    router.refresh();
  }

  return (
    <div className="space-y-8">
      <SignInHeader />

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

        <Field label="Password" htmlFor="password" error={errors.password}>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-invalid={errors.password ? true : undefined}
            aria-describedby={errors.password ? "password-error" : undefined}
          />
        </Field>

        <Button type="submit" className="w-full" loading={pending}>
          Sign in
        </Button>
      </form>

      <div className="space-y-2 text-center">
        <Text variant="body-sm" tone="secondary">
          <Link
            href="/forgot-password"
            className="text-accent underline-offset-4 hover:underline"
          >
            Forgot your password?
          </Link>
        </Text>
        <Text variant="body-sm" tone="secondary">
          No account?{" "}
          <Link
            href="/sign-up"
            className="text-accent underline-offset-4 hover:underline"
          >
            Create one
          </Link>
        </Text>
      </div>
    </div>
  );
}
