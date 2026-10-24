import {
  DEFAULT_EFFORT_BUDGETS,
  type Draft,
  type Household,
  type ImportFlag,
  type Recipe,
  STORE_SECTIONS,
  type Suggestion,
} from "@mise/domain";
import { render, screen, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
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

const dal: Recipe = {
  id: 9,
  title: "Grandma's dal",
  baseServings: 4,
  ingredients: [
    {
      raw: "1 cup red lentils",
      amount: { min: 1, max: 1 },
      unit: "cup",
      name: "red lentils",
      note: null,
      item: "dried_lentils",
    },
    {
      raw: "1 tsp mystery masala",
      amount: { min: 1, max: 1 },
      unit: "tsp",
      name: "mystery masala",
      note: null,
      item: null,
    },
  ],
  steps: ["Simmer the lentils."],
  tags: [],
  effortMinutes: 40,
  cuisine: null,
  mainProtein: null,
  course: "main",
  recurring: null,
  yieldsLeftovers: false,
  prepAhead: null,
  notes: "Grandma's dal, serves 4",
  allergens: { kind: "unknown", atLeast: [], unresolved: 1 },
  photoKey: null,
  source: { kind: "text", importedAt: "2026-10-24T19:00:00.000Z" },
  importedPreference: null,
  createdAt: "2026-10-24T19:00:00.000Z",
  updatedAt: "2026-10-24T19:00:00.000Z",
  editedInAppAt: null,
  draft: true,
  lastCookedAt: null,
  cookCount: 0,
};

const toast: Recipe = { ...dal, id: 10, title: "Toast", ingredients: [], effortMinutes: null, course: null };

const flags: ImportFlag[] = [
  {
    id: 2,
    runId: 3,
    kind: "duplicate",
    recipe: { id: 9, title: "Grandma's dal" },
    duplicateOf: { id: 2, title: "Weeknight dal" },
    flaggedAt: "2026-10-24T19:00:00.000Z",
  },
  {
    id: 1,
    runId: 1,
    kind: "merge",
    recipe: { id: 7, title: "Our Toast" },
    duplicateOf: null,
    flaggedAt: "2026-10-14T19:00:00.000Z",
  },
];

const suggestion: Suggestion = {
  id: 1,
  text: "mystery masala",
  suggested: { kind: "new", name: "garam masala", section: "spices", unitFamily: "volume", allergens: [] },
  suggestedAt: "2026-10-24T19:00:00.000Z",
};

/** A client with what waits on a person, that records every tool call made. */
function fakeClient(waiting: { drafts?: Draft[]; flags?: ImportFlag[]; suggestions?: Suggestion[] }) {
  const calls: { name: string; input: unknown }[] = [];
  let drafts = waiting.drafts ?? [];
  const { client, notify } = createFakeClient(async (name: string, input: unknown) => {
    calls.push({ name, input });
    switch (name) {
      case "get_household":
        return { ok: true, value: household };
      case "search_recipes":
      case "list_items":
      case "list_unresolved_ingredients":
        return { ok: true, value: [] };
      case "list_drafts":
        return { ok: true, value: drafts };
      case "list_import_flags":
        return { ok: true, value: waiting.flags ?? [] };
      case "list_suggestions":
        return { ok: true, value: waiting.suggestions ?? [] };
      case "accept_draft":
      case "delete_recipe": {
        const { id } = input as { id: number };
        drafts = drafts.filter((draft) => draft.recipe.id !== id);
        queueMicrotask(() => notify("recipes"));
        return { ok: true, value: { ...dal, draft: false } };
      }
      case "update_recipe": {
        const changed = { ...dal, ...(input as Partial<Recipe>), ingredients: dal.ingredients };
        drafts = drafts.map((draft) => (draft.recipe.id === changed.id ? { ...draft, recipe: changed } : draft));
        queueMicrotask(() => notify("recipes"));
        return { ok: true, value: changed };
      }
      default:
        throw new Error(`Unexpected tool ${name}`);
    }
  });
  return { client, calls };
}

async function openReview(client: MiseClient) {
  render(() => <App client={client} />);
  await userEvent.click(await screen.findByRole("button", { name: "Household" }));
  await userEvent.click(await screen.findByRole("button", { name: "Review" }));
}

test("a Draft shows what to check, says AI read it, and is accepted in one tap", async () => {
  const { client, calls } = fakeClient({ drafts: [{ recipe: dal, duplicateOf: [{ id: 2, title: "Weeknight dal" }] }] });
  await openReview(client);

  const draft = await screen.findByRole("article", { name: "Grandma's dal" });
  expect(within(draft).getByText("Serves 4 · 40 minutes · Main dish")).toBeTruthy();
  expect(within(draft).getByText("1 cup red lentils")).toBeTruthy();
  expect(within(draft).getByText("1 tsp mystery masala").closest("li")?.textContent).toBe(
    "1 tsp mystery masala — Unresolved",
  );
  expect(within(draft).getByText(/Read by AI/)).toBeTruthy();
  expect(within(draft).getByText("It may be the same as Weeknight dal, which you already have.")).toBeTruthy();

  await userEvent.click(within(draft).getByRole("button", { name: "Accept" }));

  expect(calls).toContainEqual({ name: "accept_draft", input: { id: 9 } });
  expect(await screen.findByText("Nothing is waiting on you.")).toBeTruthy();
});

test("a Draft of unknown time and Course says so", async () => {
  const { client } = fakeClient({ drafts: [{ recipe: toast, duplicateOf: [] }] });
  await openReview(client);

  const draft = await screen.findByRole("article", { name: "Toast" });
  expect(within(draft).getByText("Serves 4 · Effort unknown · Course unknown")).toBeTruthy();
});

test("a Draft is edited in place, and stays to be accepted", async () => {
  const { client, calls } = fakeClient({ drafts: [{ recipe: dal, duplicateOf: [] }] });
  await openReview(client);
  const draft = await screen.findByRole("article", { name: "Grandma's dal" });

  await userEvent.click(within(draft).getByRole("button", { name: "Edit" }));
  const course = within(draft).getByLabelText("Course");
  await userEvent.selectOptions(course, "Side");
  await userEvent.click(within(draft).getByRole("button", { name: "Save Recipe" }));

  expect(calls).toContainEqual({ name: "update_recipe", input: expect.objectContaining({ id: 9, course: "side" }) });
  const edited = await screen.findByText("Serves 4 · 40 minutes · Side");
  expect(within(edited.closest("article") as HTMLElement).getByRole("button", { name: "Accept" })).toBeTruthy();
});

test("a Draft can be discarded, once confirmed, as a Recipe is deleted", async () => {
  const { client, calls } = fakeClient({ drafts: [{ recipe: dal, duplicateOf: [] }] });
  const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
  await openReview(client);
  const draft = await screen.findByRole("article", { name: "Grandma's dal" });

  await userEvent.click(within(draft).getByRole("button", { name: "Discard" }));
  expect(calls.map((call) => call.name)).not.toContain("delete_recipe");
  await userEvent.click(within(draft).getByRole("button", { name: "Discard" }));

  expect(confirm).toHaveBeenCalledWith("Delete Grandma's dal? This cannot be undone.");
  expect(calls).toContainEqual({ name: "delete_recipe", input: { id: 9, confirm: true } });
  confirm.mockRestore();
  expect(await screen.findByText("Nothing is waiting on you.")).toBeTruthy();
});

test("lists Import Flags, those of Drafts shown on the Draft instead, and Suggestions to resolve", async () => {
  const { client } = fakeClient({
    drafts: [{ recipe: dal, duplicateOf: [{ id: 2, title: "Weeknight dal" }] }],
    flags,
    suggestions: [suggestion],
  });
  await openReview(client);

  const flagged = await screen.findByRole("list", { name: "Flagged Recipes" });
  expect(
    within(flagged)
      .getAllByRole("listitem")
      .map((item) => item.textContent),
  ).toEqual(["Our Toast changed in Paprika, but was edited in Mise, so it was left alone."]);
  const suggested = screen.getByRole("list", { name: "Suggestions" });
  expect(within(suggested).getByText(/mystery masala/).textContent).toBe(
    "mystery masala: A new Item: garam masala, in Spices, with no Allergens",
  );
  expect(screen.getByText(/AI-drafted, not guaranteed complete/)).toBeTruthy();

  await userEvent.click(screen.getByRole("button", { name: "Resolve them" }));
  expect(await screen.findByRole("heading", { name: "Resolve Ingredients" })).toBeTruthy();
});

test("says when nothing is waiting", async () => {
  const { client } = fakeClient({});
  await openReview(client);

  expect(await screen.findByText("Nothing is waiting on you.")).toBeTruthy();
});
