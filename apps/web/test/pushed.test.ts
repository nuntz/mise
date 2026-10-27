import { waitFor } from "@solidjs/testing-library";
import { createRoot } from "solid-js";
import { afterEach, expect, test, vi } from "vitest";
import { createPushedPages } from "../src/pushed";

/**
 * Session history as browsers keep it: a traversal runs later, to the entry it aimed at when asked,
 * even past an entry pushed in between. jsdom instead drops a pending traversal when one is pushed.
 */
function browserHistory() {
  const entries: unknown[] = [null];
  let at = 0;
  vi.spyOn(history, "state", "get").mockImplementation(() => entries[at]);
  vi.spyOn(history, "pushState").mockImplementation((state) => {
    entries.splice(at + 1, Infinity, state);
    at += 1;
  });
  vi.spyOn(history, "go").mockImplementation((delta = 0) => {
    const to = Math.min(Math.max(at + delta, 0), entries.length - 1);
    if (to === at) return;
    setTimeout(() => {
      at = to;
      window.dispatchEvent(new PopStateEvent("popstate", { state: entries[at] }));
    });
  });
  vi.spyOn(history, "back").mockImplementation(() => history.go(-1));
}

afterEach(() => {
  vi.restoreAllMocks();
});

test("an index opened as the one before it leaves shows its initial page, and back returns to it", async () => {
  browserHistory();
  const before = createRoot((dispose) => ({ pages: createPushedPages("household"), dispose }));
  before.pages.open("members");

  // The old index leaves, taking its page off history, and the new one opens in the same tick.
  before.dispose();
  const after = createRoot(() => createPushedPages("household", "resolve"));

  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(after.page()).toBe("resolve");
  after.back();
  await waitFor(() => expect(after.page()).toBeUndefined());
  expect(history.state).toBeNull();
});

test("an index that leaves before history has taken the last one's pages off leaves no page of its own", async () => {
  browserHistory();
  const before = createRoot((dispose) => ({ pages: createPushedPages("household"), dispose }));
  before.pages.open("members");

  before.dispose();
  const after = createRoot((dispose) => ({ pages: createPushedPages("household", "resolve"), dispose }));
  after.dispose();

  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(history.state).toBeNull();
});
