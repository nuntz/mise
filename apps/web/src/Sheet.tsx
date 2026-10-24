import type { JSX } from "solid-js";

/**
 * A sheet over the page that holds the focus until it closes: a modal dialog, labelled by the
 * element with id `labelledBy`, that focuses its first field on opening. Escape calls `onEscape`;
 * Tab and Shift+Tab go round its controls, not out to the page under it.
 */
export function Sheet(props: { labelledBy: string; onEscape: () => void; class?: string; children: JSX.Element }) {
  const focusFirst = (sheet: HTMLElement) =>
    queueMicrotask(() => sheet.querySelector<HTMLElement>("input, textarea")?.focus());

  return (
    <div class="sheet-backdrop">
      <div
        class={props.class ? `sheet ${props.class}` : "sheet"}
        role="dialog"
        aria-modal="true"
        aria-labelledby={props.labelledBy}
        ref={focusFirst}
        onKeyDown={(event) => {
          if (event.key === "Escape") props.onEscape();
          if (event.key === "Tab") keepFocusIn(event.currentTarget, event);
        }}
      >
        {props.children}
      </div>
    </div>
  );
}

function keepFocusIn(sheet: HTMLElement, event: KeyboardEvent) {
  const controls = [...sheet.querySelectorAll<HTMLElement>("input, textarea, button:not(:disabled)")];
  const [first, last] = [controls[0], controls.at(-1)];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
}
