import * as React from "react";
import { LoaderCircleIcon } from "lucide-react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  // Base: rounded-md (NOT rounded-lg), h-11 default (NOT h-8/h-9), font-medium,
  // crisp focus ring, gentle active translate, disabled state, icon sizing.
  "group/button inline-flex shrink-0 items-center justify-center gap-2 rounded-md border border-transparent text-sm font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background active:translate-y-px disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        // Default = filled ink (charcoal) → high contrast primary CTA.
        default: "bg-ink text-paper hover:bg-ink/90",
        // Primary = accent fill, paper text. Use when the brand accent should lead.
        primary: "bg-accent text-paper hover:bg-accent-deep",
        // Outline = transparent + line border. Secondary CTAs (e.g. "View pricing").
        outline: "border-line bg-transparent text-ink hover:bg-paper-2",
        // Ghost = transparent, no border. Nav links, icon buttons.
        ghost: "text-ink hover:bg-paper-2",
        // Link = inline text underline. Footnotes, in-paragraph CTAs.
        link: "text-accent underline-offset-4 hover:underline h-auto px-0",
        // Destructive = trip-coloured. Irreversible actions.
        destructive: "bg-trip-soft text-trip border-trip/40 hover:bg-trip/15",
      },
      size: {
        sm: "h-9 px-3 text-[13px]",
        // Default = h-11 (44px) — comfortable touch target.
        default: "h-11 px-5",
        lg: "h-12 px-6 text-[15px]",
        icon: "size-11",
        "icon-sm": "size-9",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export type ButtonVariant = NonNullable<
  VariantProps<typeof buttonVariants>["variant"]
>;
export type ButtonSize = NonNullable<
  VariantProps<typeof buttonVariants>["size"]
>;

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /**
   * Render the single child element in place of the native <button>, keeping
   * the button styling. Lets you wrap a Next.js <Link> without nesting an
   * <a> inside a <button>. `loading` is ignored in this mode — a link has no
   * in-flight state.
   */
  asChild?: boolean;
  /**
   * In-flight state. Shows a leading spinner and disables the button while
   * keeping the label mounted, so the button does not resize mid-action.
   */
  loading?: boolean;
}

/**
 * Button.
 *
 * `type` defaults to "button" so a Button dropped into a form never submits
 * by accident — forms must opt in with an explicit `type="submit"`.
 */
const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    className,
    variant,
    size,
    asChild = false,
    loading = false,
    disabled,
    type = "button",
    children,
    ...props
  },
  ref,
) {
  const classes = cn(buttonVariants({ variant, size, className }));

  // Lightweight Slot: merge our styling onto the child rather than wrapping it.
  if (asChild && React.isValidElement(children)) {
    const child = children as React.ReactElement<{
      className?: string;
      ref?: React.Ref<unknown>;
    }>;
    return React.cloneElement(child, {
      ...props,
      ref,
      className: cn(classes, child.props.className),
    } as Record<string, unknown>);
  }

  return (
    <button
      ref={ref}
      type={type}
      data-slot="button"
      data-loading={loading ? "true" : undefined}
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      className={classes}
      {...props}
    >
      {loading && (
        <LoaderCircleIcon aria-hidden="true" className="animate-spin" />
      )}
      {children}
    </button>
  );
});

export { Button, buttonVariants };
