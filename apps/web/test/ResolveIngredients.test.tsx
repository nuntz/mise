import {
  DEFAULT_EFFORT_BUDGETS,
  type Household,
  ITEMS,
  type RecipeSummary,
  STORE_SECTIONS,
  type UnresolvedGroup,
} from "@mise/domain";
import { render, screen, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { App } from "../src/App";
import type { MiseClient } from "../src/client";

const household: Household = {
  name: "The Tremblays",
  timezone: "America/Vancouver",
  dinnerTime: "18:00",
  weekStartsOn: "monday",
  units: "metric",
  locale: "en-CA",
  members: [],
  effortBudgets: DEFAULT_EFFORT_BUDGETS,
  storeSections: [...STORE_SECTIONS],
};

const groups: UnresolvedGroup[] = [
  {
    text: "gochujang",
    count: 2,
    lines: ["2 tbsp gochujang", "1 tbsp Gochujang"],
    recipes: [
      { id: 1, title: "Bibimbap" },
      { id: 2, title: "Tteokbokki" },
    ],
  },
  { text: "beurre", count: 1, lines: ["1 tbsp beurre"], recipes: [{ id: 3, title: "Toast" }] },
  { text: "", count: 1, lines: ["2 cups"], recipes: [{ id: 3, title: "Toast" }] },
];

const untagged: RecipeSummary[] = [
  {
    id: 1,
    title: "Bibimbap",
    tags: [],
    effortMinutes: null,
    cuisine: "korean",
    mainProtein: null,
    allergens: { kind: "known", allergens: [] },
    photoKey: null,
  },
];

/** A client with fixed Unresolved Ingredients and untagged Recipes that records every tool call made. */
function fakeClient() {
  const calls: { name: string; input: unknown }[] = [];
  const client: MiseClient = {
    call: (async (name: string, input: Record<string, unknown>) => {
      calls.push({ name, input });
      switch (name) {
        case "get_household":
          return { ok: true, value: household };
        case "search_recipes":
          return { ok: true, value: [] };
        case "list_items":
          return { ok: true, value: ITEMS };
        case "list_unresolved_ingredients":
          return { ok: true, value: groups };
        case "list_untagged_recipes":
          return { ok: true, value: untagged };
        case "resolve_ingredient":
          return { ok: true, value: { item: ITEMS[0], resolved: 1 } };
        case "create_item":
          return input.name === "eggs"
            ? { ok: false, error: { code: "name_in_use", message: "" } }
            : { ok: true, value: { ...ITEMS[0], ...input, id: "household:1" } };
        case "update_recipe":
          return { ok: true, value: {} };
        default:
          throw new Error(`Unexpected tool ${name}`);
      }
    }) as MiseClient["call"],
    subscribe(_topic, refetch) {
      queueMicrotask(refetch);
      return () => {};
    },
    photoUrl: (id, key) => `/photos/${id}?v=${key}`,
    uploadPhoto: async () => true,
    removePhoto: async () => true,
    uploadExport: async () => null,
    onConnection(listener) {
      listener(true);
      return () => {};
    },
    close() {},
  };
  return { client, calls };
}

async function openPage(name: string) {
  const user = userEvent.setup();
  const fake = fakeClient();
  render(() => <App client={fake.client} />);
  await user.click(await screen.findByRole("button", { name: "Household" }));
  await user.click(await screen.findByRole("button", { name }));
  return { user, ...fake };
}

test("Unresolved Ingredients are listed by text, with their lines and Recipes", async () => {
  await openPage("Resolve Ingredients");

  const gochujang = await screen.findByRole("article", { name: "gochujang" });
  expect(within(gochujang).getByText("2 lines, in Bibimbap, Tteokbokki")).toBeTruthy();
  expect(within(gochujang).getByText("1 tbsp Gochujang")).toBeTruthy();
  expect(screen.getAllByRole("article").map((article) => article.getAttribute("aria-label"))).toEqual([
    "gochujang",
    "beurre",
    "(no name)",
  ]);
  const blank = screen.getByRole("article", { name: "(no name)" });
  expect(within(blank).getByText("These lines name no Item. Edit their Recipes to say what they are.")).toBeTruthy();
  expect(within(blank).queryByRole("button")).toBeNull();
});

test("a group is mapped to an existing Item by its name", async () => {
  const { user, calls } = await openPage("Resolve Ingredients");

  const beurre = await screen.findByRole("article", { name: "beurre" });
  await user.click(within(beurre).getByRole("button", { name: "Map to an Item" }));
  // By an alias of the Item, not only its name.
  await user.type(within(beurre).getByRole("combobox", { name: "Item" }), "unsalted butters");
  await user.click(within(beurre).getByRole("button", { name: "Resolve" }));

  expect(calls.find((call) => call.name === "resolve_ingredient")?.input).toEqual({ text: "beurre", item: "butter" });
});

test("a name that is no Item asks to pick from the list", async () => {
  const { user, calls } = await openPage("Resolve Ingredients");

  const beurre = await screen.findByRole("article", { name: "beurre" });
  await user.click(within(beurre).getByRole("button", { name: "Map to an Item" }));
  await user.type(within(beurre).getByRole("combobox", { name: "Item" }), "unobtainium");
  await user.click(within(beurre).getByRole("button", { name: "Resolve" }));

  expect(within(beurre).getByRole("alert").textContent).toBe("Pick an Item from the list, or create a new one.");
  expect(calls.some((call) => call.name === "resolve_ingredient")).toBe(false);
});

test("a new Item is created from a group with its Allergens and Store Section, the text kept as an alias", async () => {
  const { user, calls } = await openPage("Resolve Ingredients");

  const gochujang = await screen.findByRole("article", { name: "gochujang" });
  await user.click(within(gochujang).getByRole("button", { name: "Create an Item" }));
  const name = within(gochujang).getByRole("textbox", { name: "Name" });
  await user.clear(name);
  await user.type(name, "Korean chili paste");
  await user.selectOptions(within(gochujang).getByRole("combobox", { name: "Store Section" }), "international");
  await user.selectOptions(within(gochujang).getByRole("combobox", { name: "Measured by" }), "volume");
  await user.click(within(gochujang).getByRole("checkbox", { name: "Soy" }));
  await user.click(within(gochujang).getByRole("checkbox", { name: "Wheat" }));
  await user.click(within(gochujang).getByRole("button", { name: "Create Item" }));

  expect(calls.find((call) => call.name === "create_item")?.input).toEqual({
    name: "Korean chili paste",
    section: "international",
    unitFamily: "volume",
    allergens: ["soy", "wheat"],
    aliases: ["gochujang"],
  });
});

test("a new Item needs its Allergens ticked, or none of them ticked on purpose", async () => {
  const { user, calls } = await openPage("Resolve Ingredients");

  const gochujang = await screen.findByRole("article", { name: "gochujang" });
  await user.click(within(gochujang).getByRole("button", { name: "Create an Item" }));
  await user.click(within(gochujang).getByRole("button", { name: "Create Item" }));

  expect(within(gochujang).getByRole("alert").textContent).toBe(
    'Tick the Allergens it contains, or "Contains none of these".',
  );
  expect(calls.some((call) => call.name === "create_item")).toBe(false);

  await user.click(within(gochujang).getByRole("checkbox", { name: "Contains none of these" }));
  await user.click(within(gochujang).getByRole("button", { name: "Create Item" }));

  expect(calls.find((call) => call.name === "create_item")?.input).toMatchObject({ allergens: [] });
});

test("a new Item named as the group has no alias, and a name in use is reported", async () => {
  const { user, calls } = await openPage("Resolve Ingredients");

  const gochujang = await screen.findByRole("article", { name: "gochujang" });
  await user.click(within(gochujang).getByRole("button", { name: "Create an Item" }));
  await user.click(within(gochujang).getByRole("checkbox", { name: "Contains none of these" }));
  await user.click(within(gochujang).getByRole("button", { name: "Create Item" }));
  const name = within(gochujang).getByRole("textbox", { name: "Name" });
  await user.clear(name);
  await user.type(name, "eggs");
  await user.click(within(gochujang).getByRole("button", { name: "Create Item" }));

  expect(calls.find((call) => call.name === "create_item")?.input).toMatchObject({ name: "gochujang", aliases: [] });
  expect((await within(gochujang).findByRole("alert")).textContent).toBe("That name already belongs to another Item.");
});

test("a Recipe missing a main protein is tagged in place", async () => {
  const { user, calls } = await openPage("Tag Recipes");

  const bibimbap = await screen.findByRole("form", { name: "Bibimbap" });
  expect(within(bibimbap).getByRole<HTMLInputElement>("textbox", { name: "Cuisine" }).value).toBe("korean");
  await user.type(within(bibimbap).getByRole("textbox", { name: "Main protein" }), " beef ");
  await user.click(within(bibimbap).getByRole("button", { name: "Save" }));

  expect(calls.find((call) => call.name === "update_recipe")?.input).toEqual({
    id: 1,
    cuisine: "korean",
    mainProtein: "beef",
  });
});
