"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ComponentProps } from "react";

/**
 * Thin client wrapper so the root layout — a Server Component — can mount
 * next-themes without becoming a client component itself.
 *
 * Configured at the mount site (`src/app/layout.tsx`) with
 * `attribute="class"`, which is what `@custom-variant dark (&:is(.dark *))` in
 * globals.css is waiting for: next-themes writes `class="dark"` onto <html>
 * before hydration and every `dark:` utility plus the `.dark` token block
 * resolve against it.
 *
 * That pre-hydration write is also why <html> carries
 * `suppressHydrationWarning`. The server renders no class; the inline script
 * adds one before React attaches; without the suppression every page load logs
 * a hydration mismatch on <html>.
 */
export function ThemeProvider({
  children,
  ...props
}: ComponentProps<typeof NextThemesProvider>) {
  return <NextThemesProvider {...props}>{children}</NextThemesProvider>;
}
