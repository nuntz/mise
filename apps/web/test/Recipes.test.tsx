import {
  DEFAULT_EFFORT_BUDGETS,
  type Household,
  ITEMS,
  type Recipe,
  type RecipeSummary,
  STORE_SECTIONS,
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

const toast: Recipe = {
  id: 1,
  title: "Toast",
  baseServings: 2,
  ingredients: [
    { raw: "2 slices bread", amount: { min: 2, max: 2 }, unit: "slice", name: "bread", note: null, item: null },
    {
      raw: "1 tbsp butter, softened",
      amount: { min: 1, max: 1 },
      unit: "tbsp",
      name: "butter",
      note: "softened",
      item: "butter",
    },
  ],
  steps: ["Toast the bread.", "Butter it."],
  tags: ["breakfast"],
  effortMinutes: 5,
  cuisine: null,
  mainProtein: null,
  recurring: "weekly",
  yieldsLeftovers: false,
  prepAhead: null,
  notes: null,
  photoKey: null,
  allergens: { kind: "unknown", atLeast: ["milk"], unresolved: 1 },
  source: { kind: "manual" },
  importedPreference: null,
  createdAt: "2026-10-21T12:00:00.000Z",
  updatedAt: "2026-10-21T12:00:00.000Z",
  editedInAppAt: null,
  lastCookedAt: null,
  cookCount: 0,
};

const rice: Recipe = {
  ...toast,
  id: 2,
  title: "Rice",
  ingredients: [{ raw: "1 cup rice", amount: { min: 1, max: 1 }, unit: "cup", name: "rice", note: null, item: "rice" }],
  tags: [],
  recurring: null,
  allergens: { kind: "known", allergens: [] },
};

const summaryOf = ({ id, title, tags, effortMinutes, cuisine, mainProtein, allergens, photoKey }: Recipe) =>
  ({ id, title, tags, effortMinutes, cuisine, mainProtein, allergens, photoKey }) satisfies RecipeSummary;

/** A client over a fixed set of Recipes that records every tool call made. */
function fakeClient(recipes: Recipe[]) {
  const calls: { name: string; input: unknown }[] = [];
  const client: MiseClient = {
    call: (async (name: string, input: Record<string, unknown>) => {
      calls.push({ name, input });
      switch (name) {
        case "get_household":
          return { ok: true, value: household };
        case "get_caller":
          return { ok: true, value: null };
        case "search_recipes": {
          const query = String(input.query ?? "").toLowerCase();
          return {
            ok: true,
            value: recipes.filter((recipe) => recipe.title.toLowerCase().includes(query)).map(summaryOf),
          };
        }
        case "get_recipe": {
          const recipe = recipes.find((r) => r.id === input.id);
          return recipe ? { ok: true, value: recipe } : { ok: false, error: { code: "not_found", message: "" } };
        }
        case "list_items":
          return { ok: true, value: ITEMS };
        case "create_recipe":
          return { ok: true, value: { ...rice, id: 3, title: String(input.title) } };
        case "update_recipe":
          return { ok: true, value: { ...toast, ...input } };
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
    close() {},
  };
  return { client, calls };
}

test("the Recipes are listed, and searching narrows them", async () => {
  const user = userEvent.setup();
  const { client, calls } = fakeClient([toast, rice]);
  await openRecipes(client);

  await screen.findByRole("button", { name: "Toast" });
  expect(screen.getByRole("button", { name: "Rice" })).toBeTruthy();

  await user.type(screen.getByRole("searchbox", { name: "Search Recipes" }), "ric");

  await waitForGone(() => screen.queryByRole("button", { name: "Toast" }));
  expect(screen.getByRole("button", { name: "Rice" })).toBeTruthy();
  expect(calls.filter((call) => call.name === "search_recipes").at(-1)?.input).toEqual({ query: "ric" });
});

test("a Recipe shows how each line resolved, and Allergens unknown while one is Unresolved", async () => {
  const user = userEvent.setup();
  const { client } = fakeClient([toast, rice]);
  await openRecipes(client);

  await user.click(await screen.findByRole("button", { name: "Toast" }));

  await screen.findByRole("heading", { name: "Toast" });
  const lines = within(screen.getByRole("list", { name: "Ingredients" })).getAllByRole("listitem");
  expect(lines.map((line) => line.textContent)).toEqual([
    "2 slices bread — Unresolved",
    "1 tbsp butter, softened — butter",
  ]);
  expect(screen.getByText("Allergens unknown: 1 Ingredient is Unresolved. Contains at least: Milk.")).toBeTruthy();
  expect(screen.getByText("Every week")).toBeTruthy();
});

test("a Recipe whose lines all resolved lists its Allergens", async () => {
  const user = userEvent.setup();
  const { client } = fakeClient([toast, rice]);
  await openRecipes(client);

  await user.click(await screen.findByRole("button", { name: "Rice" }));

  expect(await screen.findByText("No Allergens.")).toBeTruthy();
});

test("a new Recipe is created from its lines and fields", async () => {
  const user = userEvent.setup();
  const { client, calls } = fakeClient([]);
  await openRecipes(client);

  await user.click(await screen.findByRole("button", { name: "New Recipe" }));
  await user.type(screen.getByRole("textbox", { name: "Title" }), "Dal");
  await user.clear(screen.getByRole("spinbutton", { name: "Servings" }));
  await user.type(screen.getByRole("spinbutton", { name: "Servings" }), "6");
  await user.type(screen.getByRole("textbox", { name: "Ingredients" }), "1 cup red lentils{enter}1 tbsp ghee");
  await user.type(screen.getByRole("textbox", { name: "Steps" }), "Rinse.{enter}{enter}Simmer.");
  await user.type(screen.getByRole("textbox", { name: "Tags" }), "vegetarian, weeknight");
  await user.type(screen.getByRole("spinbutton", { name: "Effort (minutes)" }), "40");
  await user.selectOptions(screen.getByRole("combobox", { name: "Recurring" }), "monday");
  await user.click(screen.getByRole("checkbox", { name: "Yields Leftovers" }));
  await user.type(screen.getByRole("textbox", { name: "Notes" }), "From a friend.");
  await user.click(screen.getByRole("button", { name: "Save Recipe" }));

  expect(calls.find((call) => call.name === "create_recipe")?.input).toEqual({
    title: "Dal",
    baseServings: 6,
    ingredients: ["1 cup red lentils", "1 tbsp ghee"],
    steps: ["Rinse.", "", "Simmer."],
    tags: ["vegetarian", "weeknight"],
    effortMinutes: 40,
    cuisine: null,
    mainProtein: null,
    recurring: { weekday: "monday" },
    yieldsLeftovers: true,
    prepAhead: null,
    notes: "From a friend.",
  });
});

test("an imported Recipe shows its notes and where it came from", async () => {
  const imported: Recipe = {
    ...toast,
    notes: "A pot of comfort.\n\nDouble the garlic.",
    source: {
      kind: "paprika",
      externalId: "6F1B2A44",
      url: "https://recipes.example.com/toast",
      author: "The Example Kitchen",
      importedAt: "2026-10-21T12:00:00.000Z",
    },
  };
  const { client } = fakeClient([imported]);
  await openRecipes(client);

  await userEvent.click(await screen.findByRole("button", { name: "Toast" }));

  expect((await screen.findByText(/A pot of comfort/)).textContent).toBe("A pot of comfort.\n\nDouble the garlic.");
  expect(screen.getByText("Imported from Paprika; source: The Example Kitchen.")).toBeTruthy();
});

test("editing a Recipe starts from what it has and saves the changes", async () => {
  const user = userEvent.setup();
  const { client, calls } = fakeClient([toast]);
  await openRecipes(client);

  await user.click(await screen.findByRole("button", { name: "Toast" }));
  await user.click(await screen.findByRole("button", { name: "Edit Recipe" }));
  const title = screen.getByRole("textbox", { name: "Title" });
  await user.clear(title);
  await user.type(title, "Buttered toast");
  // An unknown effort stays unknown.
  await user.clear(screen.getByRole("spinbutton", { name: "Effort (minutes)" }));
  await user.click(screen.getByRole("button", { name: "Save Recipe" }));

  expect(calls.find((call) => call.name === "update_recipe")?.input).toMatchObject({
    id: 1,
    title: "Buttered toast",
    ingredients: ["2 slices bread", "1 tbsp butter, softened"],
    steps: ["Toast the bread.", "Butter it."],
    tags: ["breakfast"],
    effortMinutes: null,
    recurring: "weekly",
  });
});

/** The App opens on the Week; these tests start from the Recipes. */
async function openRecipes(client: MiseClient) {
  render(() => <App client={client} />);
  await userEvent.click(await screen.findByRole("button", { name: "Recipes" }));
}

async function waitForGone(query: () => HTMLElement | null) {
  for (let i = 0; i < 50 && query(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(query()).toBeNull();
}
