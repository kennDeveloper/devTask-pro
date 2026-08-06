"use client";

import { useMemo, useState } from "react";
import type { inferRouterOutputs } from "@trpc/server";

import { ThemeToggle } from "@/components/theme-toggle";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Text } from "@/components/ui/text";
import {
  accountRoleLabel,
  accountStatusLabel,
  profileDisplayName,
  resolveInitialTimeZone,
  timeZoneOptions,
  validateProfileForm,
  type ProfileFormErrors,
} from "@/lib/profile-form";
import { trpc } from "@/lib/trpc/client";
import type { AppRouter } from "@/lib/trpc/routers/_app";

import { SignOutButton } from "./sign-out-button";

/**
 * Inferred from the router rather than imported from it: importing
 * `PublicProfile` would pull `routers/profile.ts` — and behind it `withUser`
 * and the `postgres` driver — into the browser bundle.
 */
type Profile = NonNullable<inferRouterOutputs<AppRouter>["profile"]["get"]>;

/** Which pill an account status gets. Presentation only; no rules live here. */
const STATUS_TONE: Record<string, BadgeTone> = {
  active: "success",
  pending: "warning",
  rejected: "danger",
  suspended: "danger",
};

/**
 * Four sibling cards, one concern each.
 *
 * Appearance and Session do not depend on the profile query, so they render
 * immediately; only the two cards that do are skeletoned, and their headers
 * render real text throughout — a card title is not data.
 */
export function SettingsScreen() {
  const profileQuery = trpc.profile.get.useQuery();

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6">
      <header className="space-y-2">
        <Text variant="h1">Settings</Text>
        <Text variant="body-sm" tone="secondary">
          Your profile and how DevTask Pro looks on this device.
        </Text>
      </header>

      {profileQuery.isPending ? (
        <>
          <ProfileCardSkeleton />
          <AccountCardSkeleton />
        </>
      ) : profileQuery.data ? (
        <>
          {/* Deliberately not keyed on the row's `updatedAt`: a save
              invalidates `profile.get`, and remounting on the refetched row
              would throw away both the user's cursor and the "Saved."
              confirmation the save just produced. The form seeds once and
              already holds exactly what was written. */}
          <ProfileCard profile={profileQuery.data} />
          <AccountCard profile={profileQuery.data} />
        </>
      ) : (
        // Either the query failed, or it succeeded and there is no profile row
        // — which the (app) layout already redirects on, so it means the row
        // vanished mid-session. Both are "we cannot show you this", not "still
        // loading", and a permanent skeleton would claim otherwise.
        <Card>
          <CardHeader>
            <CardTitle>Your profile could not be loaded</CardTitle>
            <CardDescription>
              {profileQuery.error?.message ??
                "No profile is attached to this account."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              variant="outline"
              loading={profileQuery.isFetching}
              onClick={() => void profileQuery.refetch()}
            >
              Try again
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Appearance</CardTitle>
          <CardDescription>
            Stored in this browser, not on your account, so each device can
            differ. System follows your operating system.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ThemeToggle variant="full" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Session</CardTitle>
          <CardDescription>
            Signing out clears the session on this device only.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SignOutButton />
        </CardContent>
      </Card>
    </div>
  );
}

function ProfileCard({ profile }: { profile: Profile }) {
  const utils = trpc.useUtils();
  const update = trpc.profile.update.useMutation();

  const initialTimezone = useMemo(
    () => resolveInitialTimeZone(profile.timezone),
    [profile.timezone],
  );
  // The stored value and the prefilled one are both forced into the option
  // list. Without that, an account still on the schema default renders a
  // <select> with nothing selected — `Intl.supportedValuesOf("timeZone")`
  // returns canonical zones only and does not include "UTC".
  const zones = useMemo(
    () => timeZoneOptions(profile.timezone, initialTimezone),
    [profile.timezone, initialTimezone],
  );

  const [displayName, setDisplayName] = useState(() =>
    profileDisplayName(profile.displayName, profile.email),
  );
  const [timezone, setTimezone] = useState(initialTimezone);
  const [errors, setErrors] = useState<ProfileFormErrors>({});

  const prefilledFromBrowser = initialTimezone !== profile.timezone;

  /** Editing retracts the previous verdict — "Saved." must not outlive it. */
  function handleChange() {
    if (update.status !== "idle") update.reset();
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const result = validateProfileForm({ displayName, timezone });
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }

    setErrors({});
    update.mutate(result.data, {
      onSuccess: () => void utils.profile.get.invalidate(),
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Profile</CardTitle>
        <CardDescription>
          How you are named in the app, and the time zone your day is measured
          in.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {update.isError && (
          <div
            role="alert"
            className="mb-5 rounded-md border border-trip/40 bg-trip-soft px-3.5 py-3"
          >
            <Text variant="body-sm" tone="destructive">
              {update.error.message}
            </Text>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-5" noValidate>
          <Field
            label="Display name"
            htmlFor="displayName"
            error={errors.displayName}
            hint="Shown in the sidebar. Only you see it."
          >
            <Input
              id="displayName"
              name="displayName"
              value={displayName}
              maxLength={120}
              autoComplete="name"
              onChange={(event) => {
                setDisplayName(event.target.value);
                handleChange();
              }}
              aria-invalid={errors.displayName ? true : undefined}
              aria-describedby={
                errors.displayName ? "displayName-error" : "displayName-hint"
              }
            />
          </Field>

          <Field
            label="Time zone"
            htmlFor="timezone"
            error={errors.timezone}
            hint={
              prefilledFromBrowser
                ? "Detected from this browser. Save to store it on your account."
                : "Decides when your day starts and ends."
            }
          >
            {/* There is no Select primitive in src/components/ui, and this task
                does not own that directory. The classes below mirror
                `Input`'s so the two controls line up exactly. */}
            <select
              id="timezone"
              name="timezone"
              value={timezone}
              onChange={(event) => {
                setTimezone(event.target.value);
                handleChange();
              }}
              aria-invalid={errors.timezone ? true : undefined}
              aria-describedby={
                errors.timezone ? "timezone-error" : "timezone-hint"
              }
              className="flex h-11 w-full rounded-md border border-line bg-paper px-3.5 py-2 text-base text-ink transition-[border-color,box-shadow] duration-150 focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25 disabled:cursor-not-allowed disabled:opacity-50 sm:text-sm"
            >
              {zones.map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </select>
          </Field>

          <div className="flex items-center gap-3">
            <Button type="submit" loading={update.isPending}>
              Save changes
            </Button>
            {update.isSuccess && (
              <Text variant="body-sm" tone="success" role="status">
                Saved.
              </Text>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function AccountCard({ profile }: { profile: Profile }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Account</CardTitle>
        <CardDescription>
          Set when your account was created and changed only by an
          administrator. There are no controls here because the database
          rejects the change, not just the form.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Text variant="label" tone="muted" asChild>
              <dt>Email</dt>
            </Text>
            <Text variant="body-sm" truncate asChild>
              <dd>{profile.email}</dd>
            </Text>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Text variant="label" tone="muted" asChild>
              <dt>Status</dt>
            </Text>
            <dd>
              <Badge tone={STATUS_TONE[profile.status] ?? "neutral"} dot>
                {accountStatusLabel(profile.status)}
              </Badge>
            </dd>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Text variant="label" tone="muted" asChild>
              <dt>Role</dt>
            </Text>
            <dd>
              <Badge tone={profile.role === "admin" ? "info" : "neutral"}>
                {accountRoleLabel(profile.role)}
              </Badge>
            </dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  );
}

/**
 * Mirrors ProfileCard row for row: two Fields (label 20px, control 44px, hint
 * 16px) and the save button, at the same gaps. Resolving the query swaps
 * shimmer for content without moving anything.
 */
function ProfileCardSkeleton() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Profile</CardTitle>
        <CardDescription>
          How you are named in the app, and the time zone your day is measured
          in.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-5">
          <FieldSkeleton labelWidth="w-28" hintWidth="w-56" />
          <FieldSkeleton labelWidth="w-24" hintWidth="w-64" />
          <Skeleton className="h-11 w-36 rounded-md" />
        </div>
      </CardContent>
    </Card>
  );
}

function FieldSkeleton({
  labelWidth,
  hintWidth,
}: {
  labelWidth: string;
  hintWidth: string;
}) {
  return (
    <div className="space-y-2">
      <div className="space-y-1.5">
        <Skeleton className={`h-5 ${labelWidth}`} />
        <Skeleton className="h-11 w-full rounded-md" />
      </div>
      <Skeleton className={`h-4 ${hintWidth}`} />
    </div>
  );
}

function AccountCardSkeleton() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Account</CardTitle>
        <CardDescription>
          Set when your account was created and changed only by an
          administrator. There are no controls here because the database
          rejects the change, not just the form.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {["w-40", "w-24", "w-28"].map((width) => (
            <div key={width} className="flex items-center justify-between gap-2">
              <Skeleton className="h-5 w-16" />
              <Skeleton className={`h-5 ${width}`} />
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
