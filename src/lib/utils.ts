import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge Tailwind class names.
 *
 * `clsx` flattens conditionals/arrays; `twMerge` then resolves *conflicting*
 * Tailwind utilities by keeping the last one. The second half is the point:
 * without it, a caller-supplied `className` cannot reliably override a
 * variant's class, because both rules live in the same cascade layer and
 * Tailwind orders them by generation order, not by string position.
 *
 * Every primitive composes its classes through this, so
 * `<Button className="bg-accent">` beats the variant's fill as expected.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
