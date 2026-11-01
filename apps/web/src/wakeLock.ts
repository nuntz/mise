import { createEffect, onCleanup, onMount } from "solid-js";

/**
 * Asks the browser to keep the screen on while `wanted` holds (always, by default) and the owner is
 * mounted, and again whenever the page comes back into view (the lock is dropped when it's hidden).
 * Browsers without the Wake Lock API just sleep as usual.
 */
export function keepScreenAwake(wanted: () => boolean = () => true) {
  let lock: WakeLockSentinel | undefined;
  let holding = false;
  const request = async () => {
    if (!holding || !("wakeLock" in navigator) || document.visibilityState !== "visible") return;
    try {
      const granted = await navigator.wakeLock.request("screen");
      if (holding) lock = granted;
      else void granted.release();
    } catch {
      // Refused, such as on low battery: the screen may sleep.
    }
  };
  const letGo = () => {
    holding = false;
    void lock?.release();
    lock = undefined;
  };
  createEffect(() => {
    if (!wanted()) return letGo();
    holding = true;
    void request();
  });
  const onVisible = () => void request();
  onMount(() => document.addEventListener("visibilitychange", onVisible));
  onCleanup(() => {
    document.removeEventListener("visibilitychange", onVisible);
    letGo();
  });
}
