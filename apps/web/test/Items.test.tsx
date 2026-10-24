import { DEFAULT_EFFORT_BUDGETS, type Household, ITEMS, type Item, STORE_SECTIONS } from "@mise/domain";
import { render, screen, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { App } from "../src/App";
import { createFakeClient } from "./fakeClient";

const household: Household = {
  name: "The Tremblays",
  timezone: "America/Vancouver",
  dinnerTime: "18:00",
  weekStartsOn: "monday",
  weekStartChanges: [],
  units: "metric",
  locale: "en-CA",
  members: [],
  effortBudgets: DEFAULT_EFFORT_BUDGETS,
  storeSections: [...STORE_SECTIONS],
};

const masala: Item = {
  id: "household:1",
  name: "mystery masala",
  aliases: ["masala mix"],
  section: "spices",
  allergens: ["milk", "mustard"],
  unitFamily: "volume",
};

/** A client whose Items are the shipped ones plus mystery masala, recording every tool call made. */
function fakeClient() {
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  let items: Item[] = [...ITEMS, masala];
  const fake = createFakeClient(async (name: string, input: Record<string, unknown>) => {
    calls.push({ name, input });
    switch (name) {
      case "get_household":
        return { ok: true, value: household };
      case "search_recipes":
        return { ok: true, value: [] };
      case "list_items":
        // A copy, as over the wire: the screen's store takes over the objects it is given.
        return { ok: true, value: structuredClone(items) };
      case "update_item": {
        if (input.name === "butter") return { ok: false, error: { code: "name_in_use", message: "" } };
        const updated = { ...(items.find((item) => item.id === input.id) as Item), ...input } as Item;
        items = items.map((item) => (item.id === updated.id ? updated : item));
        return { ok: true, value: updated };
      }
      default:
        throw new Error(`Unexpected tool ${name}`);
    }
  });
  return { ...fake, calls };
}

async function openItems() {
  const user = userEvent.setup();
  const fake = fakeClient();
  render(() => <App client={fake.client} />);
  await user.click(await screen.findByRole("button", { name: "Household" }));
  await user.click(await screen.findByRole("button", { name: "Items" }));
  return { user, ...fake };
}

const updates = (calls: { name: string; input: unknown }[]) =>
  calls.filter((call) => call.name === "update_item").map((call) => call.input);

test("shipped and Household Items are listed with their Store Section and Allergens", async () => {
  await openItems();

  const mine = await screen.findByRole("article", { name: "mystery masala" });
  expect(within(mine).getByText("Yours")).toBeTruthy();
  expect(within(mine).getByText("Spices · Milk, Mustard")).toBeTruthy();
  expect(within(mine).getByText("Also called: masala mix")).toBeTruthy();
  const butter = screen.getByRole("article", { name: "butter" });
  expect(within(butter).getByText("Ships with Mise")).toBeTruthy();
  expect(within(butter).getByText("Dairy · Milk")).toBeTruthy();
});

test("the list narrows to the Items a search names, by name or alias", async () => {
  const { user } = await openItems();

  await user.type(await screen.findByRole("searchbox", { name: "Find an Item" }), "Masala Mix");

  expect(screen.getAllByRole("article").map((article) => article.getAttribute("aria-label"))).toEqual([
    "mystery masala",
  ]);
});

test("a Household Item's name, aliases, section, measure and Allergens are edited", async () => {
  const { user, calls, notify } = await openItems();

  const mine = await screen.findByRole("article", { name: "mystery masala" });
  await user.click(within(mine).getByRole("button", { name: "Edit" }));
  const name = within(mine).getByRole("textbox", { name: "Name" });
  await user.clear(name);
  await user.type(name, "house masala");
  const aliases = within(mine).getByRole("textbox", { name: "Other names" });
  await user.clear(aliases);
  await user.type(aliases, "masala mix, chaat mix");
  await user.selectOptions(within(mine).getByRole("combobox", { name: "Store Section" }), "international");
  await user.selectOptions(within(mine).getByRole("combobox", { name: "Measured by" }), "mass");
  await user.click(within(mine).getByRole("checkbox", { name: "Sesame" }));
  await user.click(within(mine).getByRole("button", { name: "Save" }));

  expect(updates(calls)).toEqual([
    {
      id: "household:1",
      name: "house masala",
      aliases: ["masala mix", "chaat mix"],
      section: "international",
      unitFamily: "mass",
      allergens: ["milk", "sesame", "mustard"],
    },
  ]);
  notify("recipes");
  const saved = await screen.findByRole("article", { name: "house masala" });
  expect(await within(saved).findByText("International · Milk, Sesame, Mustard")).toBeTruthy();
});

test("a name that already names another Item is reported", async () => {
  const { user } = await openItems();

  const mine = await screen.findByRole("article", { name: "mystery masala" });
  await user.click(within(mine).getByRole("button", { name: "Edit" }));
  const name = within(mine).getByRole("textbox", { name: "Name" });
  await user.clear(name);
  await user.type(name, "butter");
  await user.click(within(mine).getByRole("button", { name: "Save" }));

  expect((await within(mine).findByRole("alert")).textContent).toBe("That name already belongs to another Item.");
});

test("taking an Allergen away has to be confirmed, and taking them all away said on purpose", async () => {
  const { user, calls } = await openItems();

  const mine = await screen.findByRole("article", { name: "mystery masala" });
  await user.click(within(mine).getByRole("button", { name: "Edit" }));
  await user.click(within(mine).getByRole("checkbox", { name: "Milk" }));
  await user.click(within(mine).getByRole("button", { name: "Save" }));

  expect(within(mine).getByRole("alert").textContent).toBe(
    "Confirm that it has no Milk: every Recipe using it will stop showing it.",
  );
  await user.click(within(mine).getByRole("checkbox", { name: "It has no Milk" }));
  await user.click(within(mine).getByRole("checkbox", { name: "Mustard" }));
  await user.click(within(mine).getByRole("button", { name: "Save" }));

  expect(within(mine).getByRole("alert").textContent).toBe(
    'Tick the Allergens it contains, or "Contains none of these".',
  );
  expect(updates(calls)).toEqual([]);

  await user.click(within(mine).getByRole("checkbox", { name: "Contains none of these" }));
  await user.click(within(mine).getByRole("button", { name: "Save" }));

  expect(updates(calls)).toMatchObject([{ id: "household:1", allergens: [] }]);
});

test("a shipped Item gains aliases and a Store Section, but its Allergens can't be edited", async () => {
  const { user, calls } = await openItems();

  const butter = await screen.findByRole("article", { name: "butter" });
  await user.click(within(butter).getByRole("button", { name: "Edit" }));
  expect(within(butter).queryByRole("textbox", { name: "Name" })).toBeNull();
  expect(within(butter).queryByRole("checkbox", { name: "Milk" })).toBeNull();
  expect(
    within(butter).getByText("Its Allergens ship with Mise and are corrected by an update, not here."),
  ).toBeTruthy();
  await user.type(within(butter).getByRole("textbox", { name: "Other names" }), "beurre");
  await user.selectOptions(within(butter).getByRole("combobox", { name: "Store Section" }), "baking");
  await user.click(within(butter).getByRole("button", { name: "Save" }));

  expect(updates(calls)).toEqual([{ id: "butter", aliases: ["beurre"], section: "baking" }]);
});
