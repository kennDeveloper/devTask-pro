import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Text } from "./text";

export interface FieldProps {
  label: string;
  /** id of the control this label points at. */
  htmlFor: string;
  /** Static help text shown under the control. Hidden while `error` is set. */
  hint?: string;
  /** Validation message. Replaces `hint` and is announced to screen readers. */
  error?: string;
  optional?: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * Field — canonical label / control / hint wrapper.
 * Spacing: 6px label↔control (tight bond), 8px control↔hint.
 * Use for every form field. If you find yourself writing a bare `<label>`
 * inline, stop and use this instead.
 */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  optional,
  className,
  children,
}: FieldProps) {
  return (
    <div className={cn("space-y-2", className)}>
      <div className="space-y-1.5">
        <Text variant="label" className="block" asChild>
          <label htmlFor={htmlFor}>
            {label}
            {optional && (
              <Text weight="normal" tone="muted" className="ml-1" asChild>
                <span>· optional</span>
              </Text>
            )}
          </label>
        </Text>
        {children}
      </div>
      {error ? (
        <Text variant="helper" tone="destructive" id={`${htmlFor}-error`} role="alert">
          {error}
        </Text>
      ) : (
        hint && (
          <Text variant="helper" id={`${htmlFor}-hint`}>
            {hint}
          </Text>
        )
      )}
    </div>
  );
}
