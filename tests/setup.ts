import "@testing-library/jest-dom/vitest";

/**
 * `HTMLDialogElement.showModal()` / `.close()` shim for jsdom.
 *
 * jsdom 30 still ships no implementation of either — `showModal` is literally
 * `undefined` — so any component test that renders `src/components/ui/dialog.tsx`
 * throws "el.showModal is not a function" the moment its open effect runs. That is
 * an environment gap, not a defect in the component, and the fix belongs here
 * rather than in production code: making the Dialog feature-detect its way around
 * a missing browser API would weaken the real thing to satisfy a fake one.
 *
 * The shim reproduces only the parts the component actually depends on:
 *
 *   - `showModal()` sets `open` and throws on an already-open dialog, because the
 *     component's effect is written to guard against exactly that and the guard
 *     should be exercised, not papered over.
 *   - `close()` clears `open` and dispatches a `close` event, which is how
 *     `onClose` is delivered. Escape and backdrop clicks both route through
 *     `close()` in the real element, so a test can simulate either by calling it.
 *
 * Not emulated, deliberately: the top layer, focus trapping, and inertness of the
 * background. Those are the browser behaviours we chose the native element *for*,
 * and asserting them against a shim would prove nothing about the real thing —
 * `e2e/` is where they are actually exercised.
 */
if (typeof HTMLDialogElement !== "undefined") {
  const proto = HTMLDialogElement.prototype as HTMLDialogElement & {
    showModal?: () => void;
    close?: (returnValue?: string) => void;
  };

  if (!proto.showModal) {
    proto.showModal = function showModal(this: HTMLDialogElement) {
      if (this.open) {
        throw new DOMException(
          "The element already has an 'open' attribute, and therefore cannot be opened modally.",
          "InvalidStateError",
        );
      }
      this.setAttribute("open", "");
    };
  }

  if (!proto.close) {
    proto.close = function close(this: HTMLDialogElement, returnValue?: string) {
      if (!this.open) return;
      this.removeAttribute("open");
      if (returnValue !== undefined) this.returnValue = returnValue;
      this.dispatchEvent(new Event("close"));
    };
  }
}
