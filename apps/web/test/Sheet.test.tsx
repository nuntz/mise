import { render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, expect, test } from "vitest";
import { Sheet } from "../src/Sheet";

afterEach(() => {
  Reflect.deleteProperty(window, "matchMedia");
});

function search() {
  return (
    <Sheet labelledBy="title" onEscape={() => {}}>
      <h2 id="title">Find</h2>
      <input aria-label="Search" />
    </Sheet>
  );
}

test("a sheet opens on its first field", async () => {
  render(search);
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Search" })));
});

test("on a touch screen, every sheet opens on itself, not the keyboard", async () => {
  window.matchMedia = (query: string) => ({ matches: query === "(pointer: coarse)" }) as MediaQueryList;
  render(search);
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("dialog", { name: "Find" })));
});
