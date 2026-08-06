"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight } from "lucide-react";

import { Text } from "@/components/ui/text";

/**
 * Path-derived breadcrumbs.
 *
 * devtask-pro's signed-in routes are one level deep, so in practice this
 * renders a single crumb naming the current page — which is exactly what the
 * topbar needs, and it keeps working unchanged when phase 2 adds /tasks/[id].
 * Unknown segments fall back to the raw segment; the template's commented
 * "resolve a dynamic id via tRPC" scaffolding is dropped rather than carried
 * as dead advice for a route tree that has no ids in it yet.
 */
const SEGMENT_LABELS: Record<string, string> = {
  today: "Today",
  tasks: "Tasks",
  overdue: "Overdue",
  settings: "Settings",
};

export function Breadcrumbs() {
  const pathname = usePathname() ?? "/";
  const segments = pathname.split("/").filter(Boolean);

  if (segments.length === 0) return null;

  const crumbs = segments.map((segment, index) => ({
    href: "/" + segments.slice(0, index + 1).join("/"),
    label: SEGMENT_LABELS[segment] ?? segment,
    last: index === segments.length - 1,
  }));

  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5">
      {crumbs.map((crumb, index) => (
        <span key={crumb.href} className="flex min-w-0 items-center gap-1.5">
          {index > 0 && (
            <ChevronRight className="size-3.5 shrink-0 text-fg-4" aria-hidden />
          )}
          {crumb.last ? (
            <Text variant="label" truncate asChild>
              <span aria-current="page">{crumb.label}</span>
            </Text>
          ) : (
            <Text variant="body-sm" tone="secondary" truncate asChild>
              <Link href={crumb.href} className="transition-colors hover:text-ink">
                {crumb.label}
              </Link>
            </Text>
          )}
        </span>
      ))}
    </nav>
  );
}
