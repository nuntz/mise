import { createSignal } from "solid-js";

const KEY = "mise.kitchenMode";

/**
 * Whether this device shows Mise in kitchen mode: the high-contrast theme everywhere, chosen in the
 * Household menu and kept on the device. The Recipe's kitchen-mode screen uses it whatever this says.
 */
export function createKitchenMode(): [() => boolean, (on: boolean) => void] {
  const [on, setOn] = createSignal(read());
  apply(on());
  const set = (value: boolean) => {
    setOn(value);
    apply(value);
    try {
      localStorage.setItem(KEY, value ? "on" : "off");
    } catch {
      // Not kept on this device, but in use until the page is closed.
    }
  };
  return [on, set];
}

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === "on";
  } catch {
    return false;
  }
}

function apply(on: boolean) {
  if (on) document.documentElement.dataset.theme = "kitchen";
  else delete document.documentElement.dataset.theme;
  // The browser's own bars take the `surface` token of the theme now in use.
  const surface = getComputedStyle(document.documentElement).getPropertyValue("--surface").trim();
  if (surface) document.querySelector('meta[name="theme-color"]')?.setAttribute("content", surface);
}
