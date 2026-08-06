"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Tabs — underline style, no Radix dependency. A lightweight
 * controlled/uncontrolled implementation built on React state + context.
 * Active trigger: ink text with an accent underline indicator.
 * Inactive: fg-3.
 *
 * Usage:
 *   <Tabs defaultValue="overview">
 *     <TabsList>
 *       <TabsTrigger value="overview">Overview</TabsTrigger>
 *       <TabsTrigger value="activity">Activity</TabsTrigger>
 *     </TabsList>
 *     <TabsContent value="overview">…</TabsContent>
 *     <TabsContent value="activity">…</TabsContent>
 *   </Tabs>
 */

export interface TabsContextValue {
  value: string;
  setValue: (value: string) => void;
}

const TabsContext = React.createContext<TabsContextValue | null>(null);

function useTabsContext(component: string): TabsContextValue {
  const ctx = React.useContext(TabsContext);
  if (!ctx) {
    throw new Error(`<${component}> must be used within <Tabs>`);
  }
  return ctx;
}

export interface TabsProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "onChange"> {
  /** Controlled active value. */
  value?: string;
  /** Initial value when uncontrolled. */
  defaultValue?: string;
  /** Fires with the new value when the active tab changes. */
  onValueChange?: (value: string) => void;
}

const Tabs = React.forwardRef<HTMLDivElement, TabsProps>(function Tabs(
  { value, defaultValue, onValueChange, className, children, ...props },
  ref,
) {
  const [internal, setInternal] = React.useState(defaultValue ?? "");
  const isControlled = value !== undefined;
  const current = isControlled ? value : internal;

  const setValue = React.useCallback(
    (next: string) => {
      if (!isControlled) setInternal(next);
      onValueChange?.(next);
    },
    [isControlled, onValueChange],
  );

  const ctx = React.useMemo<TabsContextValue>(
    () => ({ value: current, setValue }),
    [current, setValue],
  );

  return (
    <TabsContext.Provider value={ctx}>
      <div ref={ref} className={className} {...props}>
        {children}
      </div>
    </TabsContext.Provider>
  );
});

const TabsList = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(function TabsList({ className, ...props }, ref) {
  return (
    <div
      ref={ref}
      role="tablist"
      className={cn(
        "inline-flex items-center gap-0 border-b border-line",
        className,
      )}
      {...props}
    />
  );
});

export interface TabsTriggerProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  value: string;
}

const TabsTrigger = React.forwardRef<HTMLButtonElement, TabsTriggerProps>(
  function TabsTrigger({ value, className, onClick, ...props }, ref) {
    const ctx = useTabsContext("TabsTrigger");
    const active = ctx.value === value;
    return (
      <button
        ref={ref}
        type="button"
        role="tab"
        aria-selected={active}
        data-state={active ? "active" : "inactive"}
        onClick={(event) => {
          ctx.setValue(value);
          onClick?.(event);
        }}
        className={cn(
          "-mb-px border-b-[3px] border-b-transparent px-3.5 py-2.5 text-sm font-semibold text-fg-3 transition-colors duration-150 hover:text-ink focus-visible:outline-none data-[state=active]:border-b-accent data-[state=active]:text-ink",
          className,
        )}
        {...props}
      />
    );
  },
);

export interface TabsContentProps extends React.HTMLAttributes<HTMLDivElement> {
  value: string;
}

const TabsContent = React.forwardRef<HTMLDivElement, TabsContentProps>(
  function TabsContent({ value, className, ...props }, ref) {
    const ctx = useTabsContext("TabsContent");
    if (ctx.value !== value) return null;
    return (
      <div
        ref={ref}
        role="tabpanel"
        className={cn("mt-4 focus-visible:outline-none", className)}
        {...props}
      />
    );
  },
);

export { Tabs, TabsList, TabsTrigger, TabsContent };
