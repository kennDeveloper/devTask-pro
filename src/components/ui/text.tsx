import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * Text — the single primitive for every rendered string.
 *
 * Pick `variant` first (it bakes size/weight/tracking/casing/default colour).
 * Pick `tone` only when you need to override the colour. If no variant fits,
 * add one here — do NOT pass `text-*` / `font-*` utilities at the call site.
 * `className` is for layout only (margin, flex, etc.).
 *
 * Headings use `font-display`; body/captions use the inherited `font-sans`.
 * Colours map to theme tokens: ink (primary), fg-2/fg-3 (secondary),
 * accent (brand indigo), trip (destructive), live (success).
 */
const textVariants = cva("", {
  variants: {
    variant: {
      display:
        "font-display font-extrabold tracking-tight text-pretty text-ink text-4xl md:text-5xl lg:text-6xl",
      h1: "font-display font-extrabold tracking-tight text-pretty text-ink text-3xl md:text-[34px]",
      h2: "font-display font-bold tracking-tight text-pretty text-ink text-2xl md:text-3xl",
      h3: "font-display font-bold tracking-tight text-pretty text-ink text-xl md:text-2xl",
      h4: "font-display font-semibold tracking-tight text-pretty text-ink text-lg md:text-xl",
      eyebrow:
        "text-[11px] font-semibold uppercase tracking-[0.12em] text-fg-3",
      lead: "text-lg leading-relaxed text-fg-2",
      body: "text-base leading-relaxed text-ink",
      "body-sm": "text-sm leading-normal text-ink",
      caption: "text-xs leading-normal text-fg-3",
      label: "text-sm font-medium text-ink",
      helper: "text-xs text-fg-3",
      "table-header":
        "text-[11px] font-semibold uppercase tracking-[0.08em] text-fg-3",
      "table-cell": "text-sm text-ink",
      metric:
        "font-display font-extrabold tracking-tight tabular-nums text-ink text-4xl md:text-5xl",
    },
    tone: {
      default: "",
      secondary: "text-fg-2",
      muted: "text-fg-3",
      faint: "text-fg-4",
      accent: "text-accent",
      destructive: "text-trip",
      success: "text-live",
      inherit: "text-inherit",
    },
    weight: {
      light: "font-light",
      normal: "font-normal",
      medium: "font-medium",
      semibold: "font-semibold",
      bold: "font-bold",
      extrabold: "font-extrabold",
    },
    align: {
      left: "text-left",
      center: "text-center",
      right: "text-right",
    },
    truncate: { true: "truncate" },
    balance: { true: "text-balance" },
  },
  defaultVariants: { variant: "body", tone: "default" },
});

export type TextVariant = NonNullable<
  VariantProps<typeof textVariants>["variant"]
>;
export type TextTone = NonNullable<VariantProps<typeof textVariants>["tone"]>;

/** Semantic element each variant renders when `as` is not supplied. */
export const TEXT_DEFAULT_TAG: Record<TextVariant, React.ElementType> = {
  display: "h1",
  h1: "h1",
  h2: "h2",
  h3: "h3",
  h4: "h4",
  metric: "p",
  eyebrow: "span",
  lead: "p",
  body: "p",
  "body-sm": "p",
  caption: "span",
  label: "label",
  helper: "span",
  "table-header": "span",
  "table-cell": "span",
};

export interface TextProps
  extends Omit<React.HTMLAttributes<HTMLElement>, "color">,
    VariantProps<typeof textVariants> {
  /** Override the rendered tag (e.g. render an `h2`-styled `<p>`). */
  as?: React.ElementType;
  /** Merge styling onto the single child element instead of wrapping it. */
  asChild?: boolean;
}

const Text = React.forwardRef<HTMLElement, TextProps>(function Text(
  {
    as,
    asChild,
    variant,
    tone,
    weight,
    align,
    truncate,
    balance,
    className,
    children,
    ...rest
  },
  ref,
) {
  const classes = cn(
    textVariants({ variant, tone, weight, align, truncate, balance }),
    className,
  );

  // asChild: merge our className/props onto the single child element so we
  // don't introduce an extra DOM node (lightweight Slot — no Radix dep).
  if (asChild && React.isValidElement(children)) {
    const child = children as React.ReactElement<{
      className?: string;
      ref?: React.Ref<unknown>;
    }>;
    return React.cloneElement(child, {
      ...rest,
      ref,
      className: cn(classes, child.props.className),
    } as Record<string, unknown>);
  }

  const Comp: React.ElementType =
    as ?? TEXT_DEFAULT_TAG[(variant ?? "body") as TextVariant] ?? "span";

  return (
    <Comp ref={ref} className={classes} {...rest}>
      {children}
    </Comp>
  );
});

export { Text, textVariants };
