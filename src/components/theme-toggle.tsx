"use client";

import { useSyncExternalStore } from "react";
import { useTheme } from "next-themes";
import { Monitor, Moon, Sun } from "lucide-react";

import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";

/**
 * System / Light / Dark, as three plain toggle buttons.
 *
 * Not a cycling icon button: with three states, a single button that advances
 * to the next one gives no way to see where you are without clicking, and no
 * way to go back without clicking twice. Three buttons say the whole state at
 * a glance and cost one row of chrome.
 *
 * `role="group"` + `aria-pressed`, deliberately not a radiogroup — a
 * radiogroup promises arrow-key roving focus that this does not implement, and
 * announcing a contract you have not built is worse than the plainer one.
 */
const THEME_OPTIONS = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
] as const;

/**
 * "Has this hydrated yet?" without a setState-in-an-effect.
 *
 * The stored preference is only knowable in the browser, so the first client
 * render must match the server's — which knew nothing. `useSyncExternalStore`
 * is the sanctioned way to say that: a server snapshot of `false`, a client
 * snapshot of `true`, and a subscription that never fires because the answer
 * changes exactly once, at hydration.
 */
const noopSubscribe = () => () => {};

function useHydrated(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

export interface ThemeToggleProps {
  /**
   * `compact` — icon-only, for a topbar or a marketing header.
   * `full` — icon plus label, for a settings row.
   */
  variant?: "compact" | "full";
  className?: string;
}

export function ThemeToggle({
  variant = "compact",
  className,
}: ThemeToggleProps) {
  const { theme, setTheme } = useTheme();

  // Before hydration nothing is pressed. The buttons keep their size
  // throughout, so the preference resolving causes no layout shift — only the
  // highlight appears.
  const hydrated = useHydrated();

  return (
    <div
      role="group"
      aria-label="Theme"
      className={cn(
        "inline-flex items-center gap-0.5 rounded-md border border-line bg-paper-2 p-0.5",
        variant === "full" && "w-full",
        className,
      )}
    >
      {THEME_OPTIONS.map(({ value, label, icon: Icon }) => {
        const pressed = hydrated && theme === value;
        return (
          <button
            key={value}
            type="button"
            aria-pressed={pressed}
            aria-label={variant === "compact" ? label : undefined}
            onClick={() => setTheme(value)}
            className={cn(
              "inline-flex items-center justify-center gap-2 rounded-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
              variant === "compact" ? "size-8" : "h-9 flex-1 px-3",
              pressed
                ? "bg-paper text-ink"
                : "text-fg-3 hover:bg-paper-3/60 hover:text-ink",
            )}
          >
            <Icon className="size-4" strokeWidth={1.75} aria-hidden />
            {variant === "full" && (
              <Text variant="label" tone="inherit" asChild>
                <span>{label}</span>
              </Text>
            )}
          </button>
        );
      })}
    </div>
  );
}
