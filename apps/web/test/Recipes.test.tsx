import {
  DEFAULT_EFFORT_BUDGETS,
  type Household,
  ITEMS,
  type Recipe,
  type RecipeSummary,
  STORE_SECTIONS,
} from "@mise/domain";
import { cleanup, render, screen, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { expect, onTestFinished, test } from "vitest";
import { App } from "../src/App";
import type { MiseClient } from "../src/client";
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
  course: null,
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
  draft: false,
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

const summaryOf = ({ id, title, tags, effortMinutes, cuisine, mainProtein, course, allergens, photoKey }: Recipe) =>
  ({ id, title, tags, effortMinutes, cuisine, mainProtein, course, allergens, photoKey }) satisfies RecipeSummary;

/**
 * A client over a fixed set of Recipes that records every tool call made and every photo uploaded;
 * offline, every call fails.
 */
function fakeClient(stored: Recipe[], { online = true } = {}) {
  let recipes = stored;
  const calls: { name: string; input: unknown }[] = [];
  const photos: { recipeId: number; photo: Blob }[] = [];
  const { client, notify } = createFakeClient(
    async (name: string, input: Record<string, unknown>) => {
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
        case "delete_recipe": {
          const recipe = recipes.find((r) => r.id === input.id);
          if (!recipe) return { ok: false, error: { code: "not_found", message: "" } };
          recipes = recipes.filter((r) => r !== recipe);
          queueMicrotask(() => notify("recipes"));
          return { ok: true, value: recipe };
        }
        default:
          throw new Error(`Unexpected tool ${name}`);
      }
    },
    {
      online,
      uploadPhoto: async (recipeId, photo) => {
        photos.push({ recipeId, photo });
        return true;
      },
    },
  );
  return { client, calls, photos };
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

test("tapping anywhere on a Recipe row opens the Recipe", async () => {
  const user = userEvent.setup();
  const { client } = fakeClient([toast, rice]);
  await openRecipes(client);

  await user.click(await screen.findByText("Breakfast · 5 minutes"));

  expect(await screen.findByRole("heading", { name: "Toast" })).toBeTruthy();
});

test("a Recipe row with Unresolved Ingredients shows an amber Allergens unknown chip and its sentence", async () => {
  const { client } = fakeClient([toast, rice]);
  await openRecipes(client);

  const row = await screen.findByRole("button", { name: "Toast" });
  expect(within(row).getByText("Allergens unknown").classList.contains("chip-amber")).toBe(true);
  expect(within(row).getByText("Allergens unknown: 1 Ingredient is Unresolved. Contains at least: Milk.")).toBeTruthy();
  const known = screen.getByRole("button", { name: "Rice" });
  expect(within(known).queryByText("Allergens unknown")).toBeNull();
  expect(within(known).getByText("No Allergens.")).toBeTruthy();
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

test("a Recipe's tags, cuisine and main protein are sentence-cased, and its lines are not", async () => {
  const user = userEvent.setup();
  const tagged = { ...rice, tags: ["weeknight"], cuisine: "mediterranean", mainProtein: "chicken" };
  const { client } = fakeClient([tagged]);
  await openRecipes(client);

  expect(await screen.findByText("Weeknight · 5 minutes")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Rice" }));

  expect(await screen.findByText(/Mediterranean · Chicken/)).toBeTruthy();
  expect(screen.getByText("Weeknight")).toBeTruthy();
  const lines = within(screen.getByRole("list", { name: "Ingredients" })).getAllByRole("listitem");
  expect(lines[0]?.textContent).toMatch(/^1 cup rice/);
});

test("a Recipe whose lines all resolved lists its Allergens", async () => {
  const user = userEvent.setup();
  const { client } = fakeClient([toast, rice]);
  await openRecipes(client);

  await user.click(await screen.findByRole("button", { name: "Rice" }));

  expect(await screen.findByText("No Allergens.")).toBeTruthy();
});

test("a Recipe's photo is chosen with Mise's file picker, which names the file chosen", async () => {
  const user = userEvent.setup();
  const { client, photos } = fakeClient([toast, rice]);
  await openRecipes(client);
  await user.click(await screen.findByRole("button", { name: "Toast" }));

  const photo = new File([new Uint8Array([0xff, 0xd8])], "toast.jpg", { type: "image/jpeg" });
  await user.upload(await screen.findByLabelText("Add or replace photo"), photo);

  expect(await screen.findByText("Chosen: toast.jpg")).toBeTruthy();
  expect(photos).toEqual([{ recipeId: 1, photo }]);
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
  await user.selectOptions(screen.getByRole("combobox", { name: "Course" }), "Main dish");
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
    course: "main",
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

test("a Recipe read from pasted text says so, and never that it came from Paprika", async () => {
  const pasted: Recipe = {
    ...toast,
    notes: "Toast, serves 2",
    source: { kind: "text", importedAt: "2026-10-24T12:00:00.000Z" },
  };
  const { client } = fakeClient([pasted]);
  await openRecipes(client);

  await userEvent.click(await screen.findByRole("button", { name: "Toast" }));

  expect(await screen.findByText("Read by AI from pasted text, kept in the notes.")).toBeTruthy();
  expect(screen.queryByText(/Paprika/)).toBeNull();
});

test("a Recipe imported from a link names its page", async () => {
  const linked: Recipe = {
    ...toast,
    source: {
      kind: "url",
      url: "https://kitchen.example.com/toast/",
      author: null,
      importedAt: "2026-10-24T12:00:00.000Z",
    },
  };
  const { client } = fakeClient([linked]);
  await openRecipes(client);

  await userEvent.click(await screen.findByRole("button", { name: "Toast" }));

  expect(await screen.findByText("Imported from https://kitchen.example.com/toast/.")).toBeTruthy();
});

test("a Recipe read from a TikTok names the video and its author", async () => {
  const video = "https://www.tiktok.com/@cook.example/video/7301234567890123456";
  const fromTikTok: Recipe = {
    ...toast,
    source: { kind: "tiktok", url: video, author: "Sam Example", importedAt: "2026-10-24T12:00:00.000Z" },
  };
  const { client } = fakeClient([fromTikTok]);
  await openRecipes(client);

  await userEvent.click(await screen.findByRole("button", { name: "Toast" }));

  expect(await screen.findByText(`Read by AI from a TikTok by Sam Example: ${video}.`)).toBeTruthy();
});

test("a Recipe read from screenshots says so", async () => {
  const fromScreenshots: Recipe = { ...toast, source: { kind: "screenshot", importedAt: "2026-10-24T12:00:00.000Z" } };
  const { client } = fakeClient([fromScreenshots]);
  await openRecipes(client);

  await userEvent.click(await screen.findByRole("button", { name: "Toast" }));

  expect(await screen.findByText("Read by AI from screenshots.")).toBeTruthy();
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

test("deleting a Recipe asks in Mise's own sheet, and Cancel keeps it", async () => {
  const user = userEvent.setup();
  const { client, calls } = fakeClient([toast]);
  await openRecipes(client);
  await user.click(await screen.findByRole("button", { name: "Toast" }));

  await user.click(await screen.findByRole("button", { name: "Delete Recipe" }));
  const sheet = screen.getByRole("dialog", { name: "Delete Toast?" });
  expect(
    within(sheet).getByText(
      "Toast goes for good, and every Slot it's planned in, cooked ones too, is unplanned and loses its Ratings.",
    ),
  ).toBeTruthy();
  await user.click(within(sheet).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(calls.map((call) => call.name)).not.toContain("delete_recipe");
  expect(screen.getByRole("heading", { name: "Toast" })).toBeTruthy();

  await user.click(screen.getByRole("button", { name: "Delete Recipe" }));
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete Recipe" }));

  expect(calls).toContainEqual({ name: "delete_recipe", input: { id: 1, confirm: true } });
  await screen.findByRole("searchbox", { name: "Search Recipes" });
  await waitForGone(() => screen.queryByRole("button", { name: "Toast" }));
});

test("a Recipe shows its Course, which the form corrects or leaves unknown", async () => {
  const user = userEvent.setup();
  const { client, calls } = fakeClient([{ ...toast, course: "dessert" }, rice]);
  await openRecipes(client);

  await user.click(await screen.findByRole("button", { name: "Toast" }));
  expect(screen.getByText(/Dessert/).textContent).toContain("Dessert");
  await user.click(await screen.findByRole("button", { name: "Edit Recipe" }));
  expect((screen.getByRole("combobox", { name: "Course" }) as HTMLSelectElement).value).toBe("dessert");
  await user.selectOptions(screen.getByRole("combobox", { name: "Course" }), "Breakfast");
  await user.click(screen.getByRole("button", { name: "Save Recipe" }));

  expect(calls.find((call) => call.name === "update_recipe")?.input).toMatchObject({ id: 1, course: "breakfast" });
});

test("a Recipe of unknown Course says so on the form, and is saved without one", async () => {
  const user = userEvent.setup();
  const { client, calls } = fakeClient([rice]);
  await openRecipes(client);

  await user.click(await screen.findByRole("button", { name: "Rice" }));
  await user.click(await screen.findByRole("button", { name: "Edit Recipe" }));
  const course = screen.getByRole("combobox", { name: "Course" }) as HTMLSelectElement;
  expect(course.selectedOptions[0]?.textContent).toBe("Unknown");
  await user.click(screen.getByRole("button", { name: "Save Recipe" }));

  expect(calls.find((call) => call.name === "update_recipe")?.input).toMatchObject({ id: 2, course: null });
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

test("the last Recipe viewed stays readable offline", async () => {
  const user = userEvent.setup();
  await openRecipes(fakeClient([toast, rice]).client);
  await user.click(await screen.findByRole("button", { name: "Toast" }));
  await screen.findByText("Butter it.");
  cleanup();

  await openRecipes(fakeClient([toast, rice], { online: false }).client);
  await user.click(await screen.findByRole("button", { name: "Last viewed: Toast" }));
  expect(await screen.findByRole("heading", { name: "Toast" })).toBeTruthy();
  expect(screen.getByText("Butter it.")).toBeTruthy();
});

test("a link to a Recipe, as the calendar feed gives, opens it", async () => {
  window.history.replaceState(null, "", `/?recipe=${toast.id}`);
  onTestFinished(() => window.history.replaceState(null, "", "/"));
  render(() => <App client={fakeClient([toast, rice]).client} />);

  expect(await screen.findByRole("heading", { name: "Toast" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Recipes" }).getAttribute("aria-current")).toBe("page");
});

test("a Recipe read from a Google Doc links to the Doc", async () => {
  const doc = "https://docs.google.com/document/d/1SoupDocId/edit";
  const fromDrive: Recipe = { ...toast, source: { kind: "gdrive", url: doc, importedAt: "2026-10-24T12:00:00.000Z" } };
  const { client } = fakeClient([fromDrive]);
  await openRecipes(client);

  await userEvent.click(await screen.findByRole("button", { name: "Toast" }));

  expect(await screen.findByText(`Read by AI from a Google Doc in the Drive folder: ${doc}.`)).toBeTruthy();
});
