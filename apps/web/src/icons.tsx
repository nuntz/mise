import type { JSX } from "solid-js";

/**
 * The Design System's icons: a 24px box, 2px stroke, round caps and joins, drawn in currentColor so
 * they take the text colour. Always decorative; a button that only has an icon carries an aria-label.
 */
const PATHS = {
  week: () => (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </>
  ),
  recipes: () => (
    <>
      <path d="M4 4h6a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4z" />
      <path d="M20 4h-6a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h7z" />
    </>
  ),
  basket: () => (
    <>
      <path d="M3 10h18l-2 10H5z" />
      <path d="M8 10l3-6M16 10l-3-6" />
    </>
  ),
  jar: () => (
    <>
      <rect x="6" y="7" width="12" height="14" rx="2" />
      <path d="M8 7V4h8v3M6 12h12" />
    </>
  ),
  people: () => (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <circle cx="17" cy="9" r="2.5" />
      <path d="M15.5 14.5a5 5 0 0 1 6 5" />
    </>
  ),
  refresh: () => (
    <>
      <path d="M20 12a8 8 0 1 1-2.3-5.7" />
      <path d="M20 4v5h-5" />
    </>
  ),
  lock: () => (
    <>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </>
  ),
  chevronDown: () => <path d="M7 10l5 5 5-5" />,
  chevronLeft: () => <path d="M15 6l-6 6 6 6" />,
  chevronRight: () => <path d="M9 6l6 6-6 6" />,
  arrowUp: () => <path d="M12 19V5M6 11l6-6 6 6" />,
  arrowDown: () => <path d="M12 5v14M6 13l6 6 6-6" />,
  eatOut: () => (
    <>
      <path d="M6 3v18M4 3v6a2 2 0 0 0 4 0V3" />
      <path d="M16 3c-1.8 0-3 2.7-3 6v3h3v9M16 3v9" />
    </>
  ),
  wifiOff: () => (
    <>
      <path d="M2 2l20 20" />
      <path d="M8.5 16.5a5 5 0 0 1 7 0" />
      <path d="M5 13a10 10 0 0 1 5.2-2.8M14 10.2A10 10 0 0 1 19 13" />
      <path d="M1.5 9a15 15 0 0 1 6-3.4M12 5c3.8 0 7.3 1.5 10.5 4" />
      <circle cx="12" cy="20" r="1" />
    </>
  ),
  check: () => <path d="M5 12.5l4.5 4.5L19 7" />,
  close: () => <path d="M6 6l12 12M18 6L6 18" />,
  plus: () => <path d="M12 5v14M5 12h14" />,
  low: () => (
    <>
      <rect x="5" y="4" width="14" height="16" rx="2" />
      <path d="M5 13h14" />
    </>
  ),
  clock: () => (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4l2.5 2" />
    </>
  ),
  warning: () => (
    <>
      <path d="M12 3l10 18H2z" />
      <path d="M12 10v4M12 18h.01" />
    </>
  ),
  sort: () => (
    <>
      <path d="M4 6h16M4 12h10M4 18h7" />
      <path d="M18 15l3 3-3 3" />
    </>
  ),
  pot: () => (
    <>
      <path d="M4 10h16v6a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z" />
      <path d="M2 10h20M9 6c0-1 1-2 1-3M14 6c0-1 1-2 1-3" />
    </>
  ),
  chat: () => <path d="M4 5h16v11H10l-6 4z" />,
  mic: () => (
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </>
  ),
  list: () => <path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01" />,
  calendarPlus: () => (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4M12 13v5M9.5 15.5h5" />
    </>
  ),
} satisfies Record<string, () => JSX.Element>;

export type IconName = keyof typeof PATHS;

export function Icon(props: { name: IconName; size?: number; class?: string }) {
  return (
    <svg
      class={props.class ? `icon ${props.class}` : "icon"}
      width={props.size ?? 24}
      height={props.size ?? 24}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {PATHS[props.name]()}
    </svg>
  );
}

/** The plate glyph a dish without a photo shows on its placeholder. */
export function PlateGlyph(props: { size: number }) {
  return (
    <svg class="plate" width={props.size} height={props.size} viewBox="0 0 40 40" aria-hidden="true">
      <circle cx="20" cy="20" r="17" fill="none" stroke="currentColor" stroke-opacity="0.75" stroke-width="1.5" />
      <circle cx="20" cy="20" r="9" fill="currentColor" fill-opacity="0.4" />
    </svg>
  );
}
