import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * Badge / status pill — fully rounded, tint background + deeper
 * foreground. Pass `dot` for a leading status dot in the current colour.
 *
 * The upstream template baked fixed hex tints into `success` and `warning`.
 * Those are tokenised here (`live-soft`, `warn`, `warn-soft`) — components
 * never carry colour literals, and a light mint/cream tint would be unusable
 * against the dark theme's paper.
 */
const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold",
  {
    variants: {
      tone: {
        default: "bg-paper-2 text-ink",
        neutral: "bg-paper-2 text-fg-2",
        success: "bg-live-soft text-live",
        warning: "bg-warn-soft text-warn",
        danger: "bg-trip-soft text-trip",
        info: "bg-accent-soft text-accent-deep",
      },
    },
    defaultVariants: { tone: "default" },
  },
);

export type BadgeTone = NonNullable<
  VariantProps<typeof badgeVariants>["tone"]
>;

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {
  /** Render a leading status dot in the current text colour. */
  dot?: boolean;
}

function Badge({ className, tone, dot, children, ...props }: BadgeProps) {
  return (
    <span
      data-slot="badge"
      className={cn(badgeVariants({ tone }), className)}
      {...props}
    >
      {dot && <span className="size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

export { Badge, badgeVariants };
