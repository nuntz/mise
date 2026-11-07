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

test("a sheet whose first field is a choice opens on it", async () => {
  render(() => (
    <Sheet labelledBy="title" onEscape={() => {}}>
      <h2 id="title">Change</h2>
      <select aria-label="What">
        <option>Recipe</option>
      </select>
      <input aria-label="Note" />
    </Sheet>
  ));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "What" })));
});

test("on a touch screen, every sheet opens on itself, not the keyboard", async () => {
  window.matchMedia = (query: string) => ({ matches: query === "(pointer: coarse)" }) as MediaQueryList;
  render(search);
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("dialog", { name: "Find" })));
});

test("a sheet opened for one control opens on it, even where it would open on itself", async () => {
  render(() => (
    <Sheet labelledBy="title" onEscape={() => {}} focusField={false}>
      <h2 id="title">Pasta</h2>
      <input aria-label="Note" />
      <label>
        <input type="radio" name="rating" autofocus />
        Again
      </label>
    </Sheet>
  ));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Again" })));
});
