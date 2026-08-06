import * as React from "react";
import { cn } from "@/lib/utils";

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

/**
 * Input — 44px (h-11) to match the Button touch target, rounded-md,
 * hairline `line` border on paper, accent focus ring.
 */
const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, type, ...props },
  ref,
) {
  return (
    <input
      type={type}
      ref={ref}
      data-slot="input"
      className={cn(
        "flex h-11 w-full rounded-md border border-line bg-paper px-3.5 py-2 text-base text-ink transition-[border-color,box-shadow] duration-150 placeholder:text-fg-4 focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25 disabled:cursor-not-allowed disabled:opacity-50 sm:text-sm",
        className,
      )}
      {...props}
    />
  );
});

export { Input };
