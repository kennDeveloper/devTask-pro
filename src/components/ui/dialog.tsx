"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Dialog — a thin wrapper over the **native `<dialog>` element**.
 *
 * WHY NATIVE RATHER THAN A LIBRARY OR A HAND-ROLLED OVERLAY
 * A modal has to do five things that are tedious to get right and invisible when
 * wrong: trap focus, restore focus to the trigger on close, close on Escape, mark
 * everything behind it inert, and render above every stacking context on the page.
 * `showModal()` does all five in the browser, correctly, for free. The alternatives
 * were adding Radix — this repo has no Radix packages and every other primitive is
 * hand-rolled — or writing ~150 lines of focus-trap plumbing that the platform
 * already ships. A subtly broken focus trap is an accessibility defect nobody
 * notices, which is exactly the kind of bug not to hand-write.
 *
 * WHAT YOU STILL HAVE TO DO YOURSELF
 * 1. `showModal()`/`close()` are imperative, so an `open` prop has to be reflected
 *    onto the element through a ref rather than rendered.
 * 2. Escape does not go through your handler — it closes the element directly and
 *    fires its `close` event. So `onClose` is wired to that event and NOT to the
 *    close button, or Escape would silently desync the parent's state.
 * 3. Backdrop clicks do nothing natively. The handler below adds them.
 * 4. The page behind still scrolls. `globals.css` handles that with
 *    `body:has(dialog[open])`, which needs no JavaScript at all.
 */

export interface DialogProps {
  open: boolean;
  /**
   * Called whenever the dialog closes — button, Escape, or backdrop click alike.
   * The parent owns `open`; this is the only way it learns the dialog went away.
   */
  onClose: () => void;
  /** Rendered as the heading and wired up as the dialog's accessible name. */
  title: string;
  /** Optional supporting line under the title. */
  description?: string;
  children: React.ReactNode;
  /** Footer actions. Kept separate so every dialog puts them in the same place. */
  footer?: React.ReactNode;
  className?: string;
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  className,
}: DialogProps) {
  const ref = React.useRef<HTMLDialogElement>(null);
  const headingId = React.useId();
  const descriptionId = React.useId();

  /**
   * Reflect the `open` prop onto the element.
   *
   * Guarded both ways: calling `showModal()` on an already-open dialog throws an
   * InvalidStateError, and calling `close()` on a closed one fires a spurious
   * `close` event that would call `onClose` in a loop.
   */
  React.useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  /**
   * One listener for every close route. Escape and the form's close button both
   * end here, so the parent cannot get out of step with the element.
   */
  React.useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;

    const handleClose = () => onClose();
    dialog.addEventListener("close", handleClose);
    return () => dialog.removeEventListener("close", handleClose);
  }, [onClose]);

  /**
   * Backdrop click. A click on the backdrop has the dialog element itself as its
   * target — the panel inside is a child, so a click on the content stops here
   * without matching. Comparing against `event.target` rather than using
   * `closest()` is what makes that distinction.
   */
  function handleClick(event: React.MouseEvent<HTMLDialogElement>) {
    if (event.target === ref.current) {
      ref.current?.close();
    }
  }

  return (
    <dialog
      ref={ref}
      onClick={handleClick}
      aria-labelledby={headingId}
      aria-describedby={description ? descriptionId : undefined}
      className={cn(
        // `open:` is needed because a closed <dialog> is display:none and the
        // flex layout would otherwise fight it.
        "m-auto w-[calc(100vw-2rem)] max-w-lg rounded-xl border border-line bg-paper p-0 text-ink",
        "backdrop:bg-transparent", // the real backdrop colour lives in globals.css
        className,
      )}
    >
      <div className="flex flex-col gap-5 p-5 sm:p-6">
        <header className="flex flex-col gap-1.5">
          <h2 id={headingId} className="text-lg font-medium tracking-tight">
            {title}
          </h2>
          {description && (
            <p id={descriptionId} className="text-sm text-fg-3">
              {description}
            </p>
          )}
        </header>

        {children}

        {footer && (
          <footer className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            {footer}
          </footer>
        )}
      </div>
    </dialog>
  );
}
