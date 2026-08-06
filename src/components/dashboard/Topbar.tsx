"use client";

import { Menu } from "lucide-react";

import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";

import { Breadcrumbs } from "./breadcrumbs";
import { useSidebar } from "./sidebar-context";

/**
 * Sticky header: the drawer handle on mobile, where-you-are in the middle,
 * theme on the right.
 *
 * The template's notifications bell is deliberately not ported. There are no
 * notifications in this build, so it would have been a permanently unread dot
 * over an empty popover — a control that lies about the product having a
 * feature it does not.
 */
export function Topbar() {
  const { openMobile } = useSidebar();

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-line bg-paper px-4 sm:px-6">
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={openMobile}
        aria-label="Open menu"
        className="md:hidden"
      >
        <Menu className="size-5" />
      </Button>

      <Breadcrumbs />

      <div className="ml-auto flex shrink-0 items-center gap-2">
        <ThemeToggle />
      </div>
    </header>
  );
}
