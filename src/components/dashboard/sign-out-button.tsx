"use client";

import { useFormStatus } from "react-dom";
import { LogOut } from "lucide-react";

import { Button, type ButtonSize, type ButtonVariant } from "@/components/ui/button";
import { useShell } from "./shell-context";

export interface SignOutButtonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Icon only, with the label moved to `aria-label`. For tight chrome. */
  iconOnly?: boolean;
  className?: string;
}

/**
 * Sign out, as a form posting to the shell's Server Action.
 *
 * A form rather than an onClick fetch so the browser owns the pending state:
 * `useFormStatus` reports it without a second piece of component state, and
 * the action redirects server-side, which means the session cookie is already
 * gone by the time the next page renders. A client-side `signOut()` followed
 * by `router.replace` — the template's approach — races the middleware.
 */
export function SignOutButton({
  variant = "outline",
  size,
  iconOnly = false,
  className,
}: SignOutButtonProps) {
  const { signOut } = useShell();

  return (
    <form action={signOut} className={className}>
      <SignOutSubmit variant={variant} size={size} iconOnly={iconOnly} />
    </form>
  );
}

/**
 * Must be a child of the <form>: `useFormStatus` reports the status of the
 * nearest enclosing form, and returns a permanently idle status if it is
 * called in the component that renders that form.
 */
function SignOutSubmit({
  variant,
  size,
  iconOnly,
}: Pick<SignOutButtonProps, "variant" | "size" | "iconOnly">) {
  const { pending } = useFormStatus();

  return (
    <Button
      type="submit"
      variant={variant}
      size={iconOnly ? size ?? "icon-sm" : size}
      loading={pending}
      aria-label={iconOnly ? "Sign out" : undefined}
    >
      {/* `loading` already renders a spinner in the leading slot — showing the
          door icon as well would put two icons on one button. */}
      {!pending && <LogOut className="size-4" strokeWidth={1.75} aria-hidden />}
      {!iconOnly && "Sign out"}
    </Button>
  );
}
