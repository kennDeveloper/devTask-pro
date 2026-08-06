import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Separator — a thin hairline rule in `border-line`.
 * Horizontal by default; pass `orientation="vertical"` for an inline divider
 * (give it a height via className, e.g. `className="h-5"`).
 */
export interface SeparatorProps extends React.HTMLAttributes<HTMLDivElement> {
  orientation?: "horizontal" | "vertical";
  /** Purely visual (no semantic boundary). Hidden from the a11y tree. */
  decorative?: boolean;
}

const Separator = React.forwardRef<HTMLDivElement, SeparatorProps>(
  function Separator(
    { className, orientation = "horizontal", decorative = true, ...props },
    ref,
  ) {
    return (
      <div
        ref={ref}
        data-slot="separator"
        role={decorative ? "none" : "separator"}
        aria-orientation={
          decorative
            ? undefined
            : orientation === "vertical"
              ? "vertical"
              : "horizontal"
        }
        className={cn(
          "shrink-0 bg-line",
          orientation === "vertical" ? "h-full w-px" : "h-px w-full",
          className,
        )}
        {...props}
      />
    );
  },
);

export { Separator };
