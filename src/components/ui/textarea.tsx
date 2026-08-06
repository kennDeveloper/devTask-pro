import * as React from "react";

import { cn } from "@/lib/utils";

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

/**
 * Textarea — `Input`'s styling, minus the fixed height.
 *
 * Deliberately mirrors `input.tsx` line for line on border, background, focus ring
 * and disabled treatment: the two sit next to each other in every form, and a
 * mismatched focus ring between a text field and a notes field is the sort of
 * detail that reads as unfinished. `min-h-24` rather than `h-11` because notes are
 * multi-line by definition, and `resize-y` so the user can grow it without being
 * able to break the layout sideways.
 */
const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  function Textarea({ className, ...props }, ref) {
    return (
      <textarea
        ref={ref}
        data-slot="textarea"
        className={cn(
          "flex min-h-24 w-full resize-y rounded-md border border-line bg-paper px-3.5 py-2.5 text-base text-ink transition-[border-color,box-shadow] duration-150 placeholder:text-fg-4 focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25 disabled:cursor-not-allowed disabled:opacity-50 sm:text-sm",
          className,
        )}
        {...props}
      />
    );
  },
);

export { Textarea };
