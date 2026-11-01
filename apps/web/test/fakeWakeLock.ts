import { onTestFinished, vi } from "vitest";

/** A screen wake lock the test can watch, gone again once the test ends. */
export function fakeWakeLock() {
  const release = vi.fn(async () => {});
  const request = vi.fn(async () => ({ release, released: false, type: "screen" }));
  Object.defineProperty(navigator, "wakeLock", { value: { request }, configurable: true });
  onTestFinished(() => {
    Reflect.deleteProperty(navigator, "wakeLock");
  });
  return { request, release };
}
