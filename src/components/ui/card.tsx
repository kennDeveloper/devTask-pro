import * as React from "react";
import { cn } from "@/lib/utils";
import { Text } from "./text";

/**
 * Card — flat, border-based depth. No drop shadow.
 * For an interactive hover affordance, shift the border colour
 * (e.g. `className="hover:border-accent/40"`), not a shadow.
 *
 * A card holds ONE flat piece of content. Do not nest bordered boxes or
 * labelled sub-sections inside it — if you need two groupings, use two cards.
 */
export type CardProps = React.HTMLAttributes<HTMLDivElement>;

const Card = React.forwardRef<HTMLDivElement, CardProps>(function Card(
  { className, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      data-slot="card"
      className={cn("rounded-xl border border-line bg-paper text-ink", className)}
      {...props}
    />
  );
});

const CardHeader = React.forwardRef<HTMLDivElement, CardProps>(
  function CardHeader({ className, ...props }, ref) {
    return (
      <div
        ref={ref}
        className={cn("flex flex-col gap-1.5 p-6", className)}
        {...props}
      />
    );
  },
);

const CardTitle = React.forwardRef<
  HTMLHeadingElement,
  React.HTMLAttributes<HTMLHeadingElement>
>(function CardTitle({ className, ...props }, ref) {
  return (
    <Text
      ref={ref as React.Ref<HTMLElement>}
      variant="h4"
      asChild
      className={className}
    >
      <h3 {...props} />
    </Text>
  );
});

const CardDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(function CardDescription({ className, ...props }, ref) {
  return (
    <Text
      ref={ref as React.Ref<HTMLElement>}
      variant="body-sm"
      tone="muted"
      asChild
      className={className}
    >
      <p {...props} />
    </Text>
  );
});

const CardContent = React.forwardRef<HTMLDivElement, CardProps>(
  function CardContent({ className, ...props }, ref) {
    return <div ref={ref} className={cn("p-6 pt-0", className)} {...props} />;
  },
);

const CardFooter = React.forwardRef<HTMLDivElement, CardProps>(
  function CardFooter({ className, ...props }, ref) {
    return (
      <div
        ref={ref}
        className={cn("flex items-center p-6 pt-0", className)}
        {...props}
      />
    );
  },
);

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardDescription,
  CardContent,
};
