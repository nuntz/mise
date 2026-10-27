import {
  addDays,
  DEFAULT_EFFORT_BUDGETS,
  type Household,
  ITEMS,
  MEALS,
  type Member,
  parseIngredient,
  type Recipe,
  type RecipeSummary,
  type Slot,
  STORE_SECTIONS,
  type Staple,
  type ToolResult,
  type Week,
} from "@mise/domain";
import { cleanup, render, screen, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, onTestFinished, test, vi } from "vitest";
import { App } from "../src/App";
import type { MiseClient } from "../src/client";
import { setPseudoLocale } from "../src/messages";
import { createFakeClient } from "./fakeClient";

// The fixtures are the Week of Monday 26 October; on the Sunday before, none of its days is today.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-25T12:00:00-07:00"));
});
afterEach(() => vi.useRealTimers());

const robin: Member = { id: 1, name: "Robin", email: null, constraints: [] };
const alex: Member = { id: 2, name: "Alex", email: null, constraints: [] };
const sam: Member = { id: 3, name: "Sam", email: null, constraints: [] };

const household: Household = {
  name: "The Tremblays",
  timezone: "America/Vancouver",
  dinnerTime: "18:00",
  weekStartsOn: "monday",
  weekStartChanges: [],
  units: "metric",
  locale: "en-CA",
  members: [robin, alex, sam],
  effortBudgets: DEFAULT_EFFORT_BUDGETS,
  storeSections: [...STORE_SECTIONS],
};

const pasta: RecipeSummary = {
  id: 1,
  title: "Pasta",
  tags: [],
  effortMinutes: 20,
  cuisine: null,
  mainProtein: null,
  course: null,
  allergens: { kind: "known", allergens: ["wheat"] },
  photoKey: "photos/pasta",
};
const curry: RecipeSummary = { ...pasta, id: 2, title: "Curry", photoKey: null };

const pastaRecipe: Recipe = {
  ...pasta,
  baseServings: 4,
  ingredients: ["200 g spaghetti", "2 cloves garlic, minced", "salt to taste"].map((raw) => parseIngredient(raw)),
  steps: ["Boil the spaghetti.", "Fry the garlic and toss it through."],
  recurring: null,
  yieldsLeftovers: false,
  prepAhead: "Make the sauce the night before",
  notes: "Basil from the garden",
  source: { kind: "manual" },
  importedPreference: null,
  createdAt: "2026-10-21T12:00:00.000Z",
  updatedAt: "2026-10-21T12:00:00.000Z",
  editedInAppAt: null,
  draft: false,
  lastCookedAt: null,
  cookCount: 0,
};

function emptyWeek(startDate: string): Week {
  return {
    startDate,
    endDate: addDays(startDate, 6),
    slots: Array.from({ length: 7 }, (_, day) => addDays(startDate, day)).flatMap((date) =>
      MEALS.map(
        (meal): Slot => ({
          date,
          meal,
          kind: "unplanned",
          recipe: null,
          note: null,
          diners: [1, 2, 3],
          dinersAreDefault: true,
          guests: 0,
          guestConstraints: [],
          servings: 3,
          cookFor: 0,
          leftoversOf: null,
          leftovers: [],
          locked: false,
          conflicts: [],
          reason: null,
          cookedAt: null,
          ratings: [],
        }),
      ),
    ),
    effortBudgets: DEFAULT_EFFORT_BUDGETS,
    effortBudgetOverrides: {},
    proposalSeed: null,
    reviewed: false,
  };
}

/**
 * This Week as proposed with seed 7 and not yet reviewed, with Monday's Effort Budget overridden:
 * Monday's dinner chosen, and no Recipe fitting Tuesday's.
 */
function proposedWeek(): Week {
  const week = emptyWeek("2026-10-26");
  Object.assign(week.slots[2] as Slot, {
    kind: "recipe",
    recipe: { id: 2, title: "Curry", baseServings: 4, photoKey: null },
    reason: {
      kind: "chosen",
      candidates: 12,
      factors: [
        { kind: "recency", daysApart: null },
        { kind: "effort", minutes: 30, budget: 45 },
        { kind: "uses_up", items: ["spinach"] },
        { kind: "disliked", by: [2] },
      ],
    },
  });
  Object.assign(week.slots[5] as Slot, {
    reason: { kind: "no_candidate", excluded: { conflict: 3, never: 0, course: 4, recent: 2, effort: 1 } },
  });
  return {
    ...week,
    proposalSeed: 7,
    reviewed: false,
    effortBudgetOverrides: { monday: 30 },
    effortBudgets: { ...DEFAULT_EFFORT_BUDGETS, monday: 30 },
  };
}

type Answer = (input: Record<string, unknown>) => ToolResult<unknown> | Promise<ToolResult<unknown>> | undefined;

/**
 * A client whose current Week starts on Monday, October 26; it records every tool call made. `answers`
 * answer a tool's calls instead, unless they return undefined.
 */
function fakeClient(answers: Record<string, Answer> = {}) {
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const thisWeek = emptyWeek("2026-10-26");
  const tuesdayDinner = thisWeek.slots[5] as Slot;
  Object.assign(tuesdayDinner, {
    kind: "recipe",
    recipe: { id: 1, title: "Pasta", baseServings: 4, photoKey: "photos/pasta" },
    note: "Use the fresh basil",
    guests: 1,
    servings: 4,
    locked: true,
  });
  const { client, notify, goOffline } = createFakeClient(async (name: string, input: Record<string, unknown>) => {
    calls.push({ name, input });
    const answer = answers[name]?.(input);
    if (answer) return answer;
    switch (name) {
      case "get_household":
        return { ok: true, value: household };
      case "get_week":
        return { ok: true, value: input.date === "2026-11-02" ? emptyWeek("2026-11-02") : thisWeek };
      case "search_recipes":
        return { ok: true, value: [curry, pasta] };
      case "get_recipe":
        return { ok: true, value: pastaRecipe };
      case "set_slot":
      case "set_guests":
      case "lock_slot":
        return { ok: true, value: tuesdayDinner };
      case "set_diners":
        return { ok: true, value: [tuesdayDinner] };
      case "mark_cooked":
      case "rate_recipe":
        return { ok: true, value: tuesdayDinner };
      case "list_items":
        return { ok: true, value: ITEMS };
      case "propose_week":
      case "review_week":
      case "set_week_effort_budgets":
        return { ok: true, value: thisWeek };
      case "set_effort_budgets":
        return { ok: true, value: DEFAULT_EFFORT_BUDGETS };
      case "clear_week":
        return { ok: true, value: emptyWeek("2026-10-26") };
      default:
        throw new Error(`Unexpected tool ${name}`);
    }
  });
  return { client, calls, notify, goOffline };
}

/** The text of what `control` names as its accessible description. */
const description = (control: HTMLElement) =>
  document.getElementById(String(control.getAttribute("aria-describedby")))?.textContent;

const writes = (calls: { name: string; input: unknown }[]) =>
  calls.filter(
    (call) =>
      ![
        "get_household",
        "get_week",
        "get_grocery_list",
        "search_recipes",
        "get_recipe",
        "list_items",
        "list_staples",
        "list_due_staples",
      ].includes(call.name),
  );

test("the Week opens first: each day's dinner with its photo, breakfast and lunch tucked away", async () => {
  const { client } = fakeClient();
  render(() => <App client={client} />);

  const tuesday = await screen.findByRole("region", { name: "Tuesday, October 27" });
  const dinner = within(tuesday).getByRole("region", { name: "Dinner" });
  expect(within(dinner).getByRole("heading", { name: "Pasta" })).toBeTruthy();
  expect(within(dinner).getByRole("img", { name: "Photo of Pasta" }).getAttribute("src")).toBe(
    "/photos/1?v=photos/pasta",
  );
  expect(within(dinner).getByText("Serves 4 (Robin, Alex, Sam and 1 Guest); the Recipe makes 4.")).toBeTruthy();
  expect(within(dinner).getByText("Use the fresh basil")).toBeTruthy();
  expect(within(dinner).getByText("Locked")).toBeTruthy();

  expect(
    within(tuesday).getByRole("button", { name: "Breakfast and lunch not planned" }).getAttribute("aria-expanded"),
  ).toBe("false");
  expect(within(tuesday).queryByRole("region", { name: "Breakfast" })).toBeNull();
  expect(
    within(screen.getByRole("region", { name: "Monday, October 26" })).getByText("Mon 26 · Nothing planned"),
  ).toBeTruthy();
});

/** This Week with Tuesday's dinner the Pasta for 6: the household and 3 Guests. */
function pastaForSix(): Week {
  const week = emptyWeek("2026-10-26");
  Object.assign(week.slots[5] as Slot, {
    kind: "recipe",
    recipe: { id: 1, title: "Pasta", baseServings: 4, photoKey: "photos/pasta" },
    guests: 3,
    servings: 6,
    cookFor: 6,
  });
  return week;
}

test("a dinner's Recipe opens over the Week, its Ingredients scaled to what the Slot is cooked for", async () => {
  const user = userEvent.setup();
  const { client } = fakeClient({ get_week: () => ({ ok: true, value: pastaForSix() }) });
  render(() => <App client={client} />);

  const tuesday = await screen.findByRole("region", { name: "Tuesday, October 27" });
  await user.click(within(tuesday).getByRole("button", { name: "Pasta" }));

  const sheet = await screen.findByRole("dialog", { name: "Pasta" });
  expect(within(sheet).getByText("For 6. The Recipe makes 4.")).toBeTruthy();
  const ingredients = within(sheet).getByRole("list", { name: "Ingredients" });
  expect(
    within(ingredients)
      .getAllByRole("listitem")
      .map((line) => line.textContent),
  ).toEqual(["300 g spaghetti", "3 cloves garlic, minced", "salt to taste"]);
});

test("a Recipe opened over the Week is cooked from there, for as many as its Slot", async () => {
  const user = userEvent.setup();
  const { client } = fakeClient({ get_week: () => ({ ok: true, value: pastaForSix() }) });
  render(() => <App client={client} />);

  const tuesday = await screen.findByRole("region", { name: "Tuesday, October 27" });
  await user.click(within(tuesday).getByRole("button", { name: "Pasta" }));
  const sheet = await screen.findByRole("dialog", { name: "Pasta" });
  await user.click(await within(sheet).findByRole("button", { name: "Cook" }));

  const kitchen = await screen.findByRole("region", { name: "Kitchen mode" });
  await user.click(within(kitchen).getByRole("button", { name: "Ingredients" }));
  expect(within(kitchen).getByText("For 6. The Recipe makes 4.")).toBeTruthy();
});

test("a Recipe opened over the Week shows how it's made, can't be changed there, and closes back to the Week", async () => {
  const user = userEvent.setup();
  const { client } = fakeClient();
  render(() => <App client={client} />);

  const tuesday = await screen.findByRole("region", { name: "Tuesday, October 27" });
  await user.click(within(tuesday).getByRole("button", { name: "Pasta" }));

  const sheet = await screen.findByRole("dialog", { name: "Pasta" });
  expect(within(sheet).getByText("Prep ahead: Make the sauce the night before")).toBeTruthy();
  const steps = within(sheet).getByRole("list", { name: "Steps" });
  expect(
    within(steps)
      .getAllByRole("listitem")
      .map((step) => step.textContent),
  ).toEqual(["Boil the spaghetti.", "Fry the garlic and toss it through."]);
  expect(within(sheet).getByText("Basil from the garden")).toBeTruthy();
  expect(within(sheet).queryByRole("button", { name: "Edit Recipe" })).toBeNull();
  expect(within(sheet).queryByRole("button", { name: "Delete Recipe" })).toBeNull();

  await user.click(within(sheet).getByRole("button", { name: "Close the Recipe" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("region", { name: "Tuesday, October 27" })).toBeTruthy();
});

test("breakfast's Recipe opens over the Week from the folded strip too", async () => {
  const user = userEvent.setup();
  const week = emptyWeek("2026-10-26");
  Object.assign(week.slots[3] as Slot, {
    kind: "recipe",
    recipe: { id: 1, title: "Pasta", baseServings: 4, photoKey: null },
    cookFor: 3,
  });
  const { client } = fakeClient({ get_week: () => ({ ok: true, value: week }) });
  render(() => <App client={client} />);

  const tuesday = await screen.findByRole("region", { name: "Tuesday, October 27" });
  await user.click(within(tuesday).getByRole("button", { name: "Breakfast: Pasta · Lunch not planned" }));
  const breakfast = within(tuesday).getByRole("region", { name: "Breakfast" });
  await user.click(within(breakfast).getByRole("button", { name: "Pasta" }));

  const sheet = await screen.findByRole("dialog", { name: "Pasta" });
  expect(await within(sheet).findByText("For 3. The Recipe makes 4.")).toBeTruthy();
});

test("next Week is a tap away", async () => {
  const { client, calls } = fakeClient();
  const user = userEvent.setup();
  render(() => <App client={client} />);
  await screen.findByRole("region", { name: "Monday, October 26" });

  await user.click(screen.getByRole("button", { name: "Next Week" }));

  await screen.findByRole("region", { name: "Monday, November 2" });
  expect(calls.filter((call) => call.name === "get_week").at(-1)?.input).toEqual({ date: "2026-11-02" });
});

test("a link to next Week, as the weekly proposal's notification gives, opens it once", async () => {
  window.history.replaceState(null, "", "/?week=next");
  onTestFinished(() => window.history.replaceState(null, "", "/"));
  const { client } = fakeClient();
  const user = userEvent.setup();
  render(() => <App client={client} />);

  await screen.findByRole("region", { name: "Monday, November 2" });
  expect(screen.getByRole("button", { name: "Next Week" }).getAttribute("aria-pressed")).toBe("true");
  expect(window.location.search).toBe("");

  await user.click(screen.getByRole("button", { name: "This Week" }));
  await screen.findByRole("region", { name: "Monday, October 26" });
});

test("editing a dinner sends what changed in one change to the Slot, then the Lock", async () => {
  const { client, calls } = fakeClient();
  const user = userEvent.setup();
  render(() => <App client={client} />);
  const tuesday = await screen.findByRole("region", { name: "Tuesday, October 27" });

  await user.click(within(tuesday).getByRole("button", { name: "Pasta" }));
  await user.click(
    within(await screen.findByRole("dialog", { name: "Pasta" })).getByRole("button", { name: "Edit dinner" }),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  const form = within(tuesday).getByRole("form", { name: "Dinner" });
  await within(form).findByRole("option", { name: "Curry" });
  await user.selectOptions(within(form).getByRole("combobox", { name: "Recipe" }), "Curry");
  await user.click(within(form).getByRole("checkbox", { name: "Everyone" }));
  await user.click(within(form).getByRole("checkbox", { name: "Alex" }));
  await user.click(within(form).getByRole("checkbox", { name: "Locked" }));
  await user.click(within(form).getByRole("button", { name: "Save" }));

  await vi.waitFor(() => expect(within(tuesday).queryByRole("form")).toBeNull());
  expect(writes(calls)).toEqual([
    {
      name: "set_slot",
      input: {
        date: "2026-10-27",
        meal: "dinner",
        kind: "recipe",
        recipeId: 2,
        note: "Use the fresh basil",
        diners: [1, 3],
      },
    },
    { name: "lock_slot", input: { date: "2026-10-27", meal: "dinner", locked: false } },
  ]);
});

test("a late save closes only its own Slot's form, leaving another's open with what was typed", async () => {
  let finish = (_: ToolResult<unknown>) => {};
  const { client, calls } = fakeClient({ set_slot: () => new Promise((resolve) => (finish = resolve)) });
  const user = userEvent.setup();
  render(() => <App client={client} />);
  const tuesday = await screen.findByRole("region", { name: "Tuesday, October 27" });
  await user.click(within(tuesday).getByRole("button", { name: "Pasta" }));
  await user.click(
    within(await screen.findByRole("dialog", { name: "Pasta" })).getByRole("button", { name: "Edit dinner" }),
  );
  const pasta = within(tuesday).getByRole("form", { name: "Dinner" });
  await user.type(within(pasta).getByRole("textbox", { name: "Note" }), ", please");
  await user.click(within(pasta).getByRole("button", { name: "Save" }));
  await user.click(within(pasta).getByRole("button", { name: "Cancel" }));
  const monday = screen.getByRole("region", { name: "Monday, October 26" });
  await user.click(within(monday).getByRole("button", { name: "Choose a dinner" }));
  const note = within(within(monday).getByRole("form", { name: "Dinner" })).getByRole("textbox", {
    name: "Note",
  }) as HTMLInputElement;
  await user.type(note, "Soup night");

  expect(writes(calls).map((call) => call.name)).toEqual(["set_slot"]);
  finish({ ok: true, value: null });
  await new Promise((resolve) => setTimeout(resolve));

  expect(within(monday).getByRole("form", { name: "Dinner" })).toBeTruthy();
  expect(note.value).toBe("Soup night");
});

test("a save that finishes while its own Slot is still open closes it", async () => {
  let finish = (_: ToolResult<unknown>) => {};
  const { client } = fakeClient({ set_slot: () => new Promise((resolve) => (finish = resolve)) });
  const user = userEvent.setup();
  render(() => <App client={client} />);
  const monday = await screen.findByRole("region", { name: "Monday, October 26" });
  await user.click(within(monday).getByRole("button", { name: "Choose a dinner" }));
  const form = within(monday).getByRole("form", { name: "Dinner" });
  await user.type(within(form).getByRole("textbox", { name: "Note" }), "Soup night");
  await user.click(within(form).getByRole("button", { name: "Save" }));

  finish({ ok: true, value: null });

  await vi.waitFor(() => expect(within(monday).queryByRole("form")).toBeNull());
});

test("Guests and their Constraints are set on the Slot", async () => {
  const { client, calls } = fakeClient();
  const user = userEvent.setup();
  render(() => <App client={client} />);
  const monday = await screen.findByRole("region", { name: "Monday, October 26" });

  await user.click(within(monday).getByRole("button", { name: "Choose a dinner" }));
  const form = within(monday).getByRole("form", { name: "Dinner" });
  await user.selectOptions(within(form).getByRole("combobox", { name: "What" }), "Eating out");
  await user.clear(within(form).getByRole("spinbutton", { name: "Guests" }));
  await user.type(within(form).getByRole("spinbutton", { name: "Guests" }), "2");
  await user.click(within(form).getByRole("button", { name: "Add a Constraint" }));
  await user.selectOptions(within(form).getByRole("combobox", { name: "Allergen" }), "Sesame");
  await user.click(within(form).getByRole("button", { name: "Save" }));

  await vi.waitFor(() => expect(within(monday).queryByRole("form")).toBeNull());
  expect(writes(calls)).toEqual([
    {
      name: "set_slot",
      input: {
        date: "2026-10-26",
        meal: "dinner",
        kind: "eat_out",
        note: null,
        guests: 2,
        guestConstraints: [{ kind: "allergy", allergen: "sesame" }],
      },
    },
  ]);
});

test("who's eating can be set for a whole day", async () => {
  const { client, calls } = fakeClient();
  const user = userEvent.setup();
  render(() => <App client={client} />);
  const wednesday = await screen.findByRole("region", { name: "Wednesday, October 28" });

  expect(within(wednesday).queryByRole("button", { name: "Who's eating today" })).toBeNull();
  await user.click(within(wednesday).getByRole("button", { name: "3 eating" }));
  const form = within(wednesday).getByRole("form", { name: "Who's eating today" });
  await user.click(within(form).getByRole("checkbox", { name: "Everyone" }));
  await user.click(within(form).getByRole("checkbox", { name: "Robin" }));
  await user.click(within(form).getByRole("button", { name: "Save" }));

  await vi.waitFor(() =>
    expect(writes(calls)).toEqual([{ name: "set_diners", input: { date: "2026-10-28", diners: [2, 3] } }]),
  );
});

test("clearing the Week asks first, in Mise's own sheet", async () => {
  const { client, calls } = fakeClient();
  const user = userEvent.setup();
  render(() => <App client={client} />);
  await screen.findByRole("region", { name: "Monday, October 26" });

  await user.click(screen.getByRole("button", { name: "Clear this Week" }));
  const sheet = screen.getByRole("dialog", { name: "Clear this Week?" });
  expect(
    within(sheet).getByText(
      "Every Slot of the Week starting Monday, October 26 is emptied for good, Locked ones too; meals already cooked stay.",
    ),
  ).toBeTruthy();
  await user.click(within(sheet).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBeNull();

  await user.click(screen.getByRole("button", { name: "Clear this Week" }));
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(writes(calls)).toEqual([]);

  await user.click(screen.getByRole("button", { name: "Clear this Week" }));
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Clear this Week" }));

  await vi.waitFor(() =>
    expect(writes(calls)).toEqual([{ name: "clear_week", input: { date: "2026-10-26", confirm: true } }]),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
});

const robinsPeanut = { who: 1, allergen: "peanut", constraint: "allergy", cause: "contains" } as const;

test("a breakfast that isn't safe unfolds its Day's strip, which can still be folded", async () => {
  const week = emptyWeek("2026-10-26");
  Object.assign(week.slots[3] as Slot, {
    kind: "recipe",
    recipe: { id: 1, title: "Pasta", baseServings: 4, photoKey: null },
    conflicts: [{ ...robinsPeanut, override: null }],
  });
  const { client } = fakeClient({ get_week: () => ({ ok: true, value: week }) });
  const user = userEvent.setup();
  render(() => <App client={client} />);
  const tuesday = await screen.findByRole("region", { name: "Tuesday, October 27" });

  const strip = within(tuesday).getByRole("button", { name: "Breakfast: Pasta · Lunch not planned" });
  expect(strip.getAttribute("aria-expanded")).toBe("true");
  expect(within(tuesday).getByRole("region", { name: "Breakfast" })).toBeTruthy();
  await user.click(strip);
  expect(strip.getAttribute("aria-expanded")).toBe("false");
  expect(within(tuesday).queryByRole("region", { name: "Breakfast" })).toBeNull();
});

test("each Slot shows its Conflicts: blocking ones as warnings, overridden ones with their reason", async () => {
  const { client } = fakeClient({
    get_week: (input) => {
      if (input.date) return undefined;
      const week = emptyWeek("2026-10-26");
      Object.assign(week.slots[2] as Slot, {
        kind: "recipe",
        recipe: { id: 1, title: "Satay", baseServings: 4, photoKey: null },
        conflicts: [{ ...robinsPeanut, override: "Hers without the peanut butter" }],
      });
      Object.assign(week.slots[5] as Slot, {
        kind: "recipe",
        recipe: { id: 4, title: "Stew", baseServings: 4, photoKey: null },
        guests: 1,
        conflicts: [{ who: "guests", allergen: "milk", constraint: "intolerance", cause: "unknown", override: null }],
      });
      return { ok: true, value: week };
    },
  });
  render(() => <App client={client} />);

  const monday = await screen.findByRole("region", { name: "Monday, October 26" });
  const tuesday = screen.getByRole("region", { name: "Tuesday, October 27" });
  expect(within(monday).queryByRole("alert")).toBeNull();
  expect(
    within(monday).getByText("Planned anyway for Robin (Peanut, Allergy): Hers without the peanut butter"),
  ).toBeTruthy();
  expect(within(tuesday).getByRole("alert").textContent).toBe(
    "Maybe not safe for the Guests (Milk, Intolerance): Stew has Unresolved Ingredients, so its Allergens are unknown. Resolve them under Resolve Ingredients.",
  );
});

test("a Recipe opened over the Week shows its Slot's Conflicts first, overridden ones with their reason", async () => {
  const user = userEvent.setup();
  const { client } = fakeClient({
    get_week: (input) => {
      if (input.date) return undefined;
      const week = emptyWeek("2026-10-26");
      Object.assign(week.slots[5] as Slot, {
        kind: "recipe",
        recipe: { id: 1, title: "Pasta", baseServings: 4, photoKey: null },
        guests: 1,
        conflicts: [
          { ...robinsPeanut, override: "Hers without the peanut butter" },
          { who: "guests", allergen: "milk", constraint: "intolerance", cause: "unknown", override: null },
        ],
      });
      return { ok: true, value: week };
    },
  });
  render(() => <App client={client} />);

  const tuesday = await screen.findByRole("region", { name: "Tuesday, October 27" });
  await user.click(within(tuesday).getByRole("button", { name: "Pasta" }));

  const sheet = await screen.findByRole("dialog", { name: "Pasta" });
  expect(within(sheet).getByRole("alert").textContent).toBe(
    "Maybe not safe for the Guests (Milk, Intolerance): Pasta has Unresolved Ingredients, so its Allergens are unknown. Resolve them under Resolve Ingredients.",
  );
  expect(
    within(sheet).getByText("Planned anyway for Robin (Peanut, Allergy): Hers without the peanut butter"),
  ).toBeTruthy();
});

test("a change refused for a Conflict names the person and the Allergen, and saves anyway with a reason", async () => {
  const { client, calls } = fakeClient({
    set_slot: (input) =>
      input.overrides
        ? undefined
        : {
            ok: false,
            error: {
              code: "constraint_conflict",
              message: "Refused",
              conflicts: [{ date: "2026-10-26", meal: "dinner", ...robinsPeanut }],
            },
          },
  });
  const user = userEvent.setup();
  render(() => <App client={client} />);
  const monday = await screen.findByRole("region", { name: "Monday, October 26" });

  await user.click(within(monday).getByRole("button", { name: "Choose a dinner" }));
  const form = within(monday).getByRole("form", { name: "Dinner" });
  await user.selectOptions(within(form).getByRole("combobox", { name: "What" }), "A Recipe");
  await within(form).findByRole("option", { name: "Curry" });
  await user.selectOptions(within(form).getByRole("combobox", { name: "Recipe" }), "Curry");
  await user.click(within(form).getByRole("button", { name: "Save" }));

  const warning = await within(form).findByRole("alert");
  expect(warning.textContent).toContain("Not safe for Robin (Peanut, Allergy): Curry contains it.");
  await user.click(within(form).getByRole("button", { name: "Save anyway" }));
  expect(writes(calls)).toHaveLength(1);
  await user.type(within(form).getByRole("textbox", { name: "Why it's safe for Robin (Peanut)" }), "Hers on the side");
  await user.click(within(form).getByRole("button", { name: "Save anyway" }));

  await vi.waitFor(() => expect(within(monday).queryByRole("form")).toBeNull());
  expect(writes(calls).at(-1)).toEqual({
    name: "set_slot",
    input: {
      date: "2026-10-26",
      meal: "dinner",
      kind: "recipe",
      recipeId: 2,
      note: null,
      overrides: [{ who: 1, allergen: "peanut", reason: "Hers on the side" }],
    },
  });
});

test("who's eating for a day is refused and overridden the same way", async () => {
  const { client, calls } = fakeClient({
    set_diners: (input) =>
      input.overrides
        ? undefined
        : {
            ok: false,
            error: {
              code: "constraint_conflict",
              message: "Refused",
              conflicts: [{ date: "2026-10-27", meal: "dinner", ...robinsPeanut }],
            },
          },
  });
  const user = userEvent.setup();
  render(() => <App client={client} />);
  const tuesday = await screen.findByRole("region", { name: "Tuesday, October 27" });

  await user.click(within(tuesday).getByRole("button", { name: "3 eating" }));
  const form = within(tuesday).getByRole("form", { name: "Who's eating today" });
  await user.click(within(form).getByRole("checkbox", { name: "Everyone" }));
  await user.click(within(form).getByRole("checkbox", { name: "Alex" }));
  await user.click(within(form).getByRole("button", { name: "Save" }));

  expect((await within(form).findByRole("alert")).textContent).toContain(
    "Dinner: Not safe for Robin (Peanut, Allergy): Pasta contains it.",
  );
  await user.type(within(form).getByRole("textbox", { name: "Why it's safe for Robin (Peanut)" }), "No sauce");
  await user.click(within(form).getByRole("button", { name: "Save anyway" }));

  await vi.waitFor(() =>
    expect(writes(calls).at(-1)).toEqual({
      name: "set_diners",
      input: {
        date: "2026-10-27",
        diners: [1, 3],
        overrides: [{ who: 1, allergen: "peanut", reason: "No sauce" }],
      },
    }),
  );
});

test("changing the Slot after a refusal takes the warning away, and its reasons with it", async () => {
  const { client, calls } = fakeClient({
    set_slot: (input) =>
      input.recipeId === 2 && !input.overrides
        ? {
            ok: false,
            error: {
              code: "constraint_conflict",
              message: "Refused",
              conflicts: [{ date: "2026-10-26", meal: "dinner", ...robinsPeanut }],
            },
          }
        : undefined,
  });
  const user = userEvent.setup();
  render(() => <App client={client} />);
  const monday = await screen.findByRole("region", { name: "Monday, October 26" });

  await user.click(within(monday).getByRole("button", { name: "Choose a dinner" }));
  const form = within(monday).getByRole("form", { name: "Dinner" });
  await user.selectOptions(within(form).getByRole("combobox", { name: "What" }), "A Recipe");
  await within(form).findByRole("option", { name: "Curry" });
  await user.selectOptions(within(form).getByRole("combobox", { name: "Recipe" }), "Curry");
  await user.click(within(form).getByRole("button", { name: "Save" }));
  await user.type(await within(form).findByRole("textbox", { name: "Why it's safe for Robin (Peanut)" }), "Hers apart");
  await user.selectOptions(within(form).getByRole("combobox", { name: "Recipe" }), "Pasta");

  expect(within(form).queryByRole("alert")).toBeNull();
  await user.click(within(form).getByRole("button", { name: "Save" }));
  await vi.waitFor(() => expect(within(monday).queryByRole("form")).toBeNull());
  expect(writes(calls).at(-1)).toEqual({
    name: "set_slot",
    input: { date: "2026-10-26", meal: "dinner", kind: "recipe", recipeId: 1, note: null },
  });
});

test("a Week not yet proposed can be proposed, with nothing to re-roll yet", async () => {
  const { client, calls } = fakeClient();
  const user = userEvent.setup();
  render(() => <App client={client} />);
  await screen.findByRole("region", { name: "Monday, October 26" });
  expect(screen.queryByRole("button", { name: "Re-roll" })).toBeNull();

  await user.click(screen.getByRole("button", { name: "Propose dinners" }));
  await user.click(
    within(screen.getByRole("dialog", { name: "Use it up" })).getByRole("button", { name: "Propose dinners" }),
  );

  await vi.waitFor(() => expect(writes(calls)).toEqual([{ name: "propose_week", input: { date: "2026-10-26" } }]));
});

test("an empty Week offers Propose, without Use it up, and has nothing to clear", async () => {
  const { client } = fakeClient();
  const user = userEvent.setup();
  render(() => <App client={client} />);
  await screen.findByRole("region", { name: "Monday, October 26" });
  expect(screen.getByRole("button", { name: "Clear this Week" })).toBeTruthy();

  await user.click(screen.getByRole("button", { name: "Next Week" }));
  await screen.findByRole("region", { name: "Monday, November 2" });
  expect(screen.getByText("Nothing planned yet")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Propose dinners" })).toBeTruthy();
  expect(screen.queryByRole("form", { name: "Use it up" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Clear this Week" })).toBeNull();
});

test("offline, proposing says it needs a connection under the control, and its helper text goes", async () => {
  const { client, goOffline } = fakeClient({ get_week: () => ({ ok: true, value: proposedWeek() }) });
  render(() => <App client={client} />);
  const reroll = (await screen.findByRole("button", { name: "Re-roll" })) as HTMLButtonElement;
  expect(screen.getByText(/Fills the dinners that aren't Locked/)).toBeTruthy();

  goOffline();

  const again = screen.getByRole("button", { name: "Propose again" }) as HTMLButtonElement;
  for (const control of [reroll, again]) {
    expect(control.disabled).toBe(true);
    expect(description(control)).toBe("Needs a connection.");
  }
  expect(screen.queryByText(/Fills the dinners that aren't Locked/)).toBeNull();
});

test("offline, an empty Week's Propose says it needs a connection", async () => {
  const { client, goOffline } = fakeClient();
  const user = userEvent.setup();
  render(() => <App client={client} />);
  await screen.findByRole("region", { name: "Monday, October 26" });
  await user.click(screen.getByRole("button", { name: "Next Week" }));
  await screen.findByText("Nothing planned yet");

  goOffline();

  const propose = screen.getByRole("button", { name: "Propose dinners" }) as HTMLButtonElement;
  expect(propose.disabled).toBe(true);
  expect(description(propose)).toBe("Needs a connection.");
  expect(propose.nextElementSibling?.textContent).toBe("Needs a connection.");
});

test("Use it up is offered on proposing, and its Items go with the Proposal and the re-rolls after it", async () => {
  const { client, calls } = fakeClient({ get_week: () => ({ ok: true, value: proposedWeek() }) });
  const user = userEvent.setup();
  render(() => <App client={client} />);
  await screen.findByRole("region", { name: "Monday, October 26" });
  expect(screen.queryByRole("form", { name: "Use it up" })).toBeNull();

  await user.click(screen.getByRole("button", { name: "Propose again" }));
  const sheet = screen.getByRole("dialog", { name: "Use it up" });
  // The sheet takes the focus, not its field, so a phone doesn't open the keyboard and its suggestions.
  await vi.waitFor(() => expect(document.activeElement).toBe(sheet));
  const useUp = within(sheet).getByRole("form", { name: "Use it up" });
  const field = within(useUp).getByRole("combobox", { name: "Item on hand" });
  await user.type(field, "baby spinach");
  await user.click(within(useUp).getByRole("button", { name: "Add" }));
  await user.type(field, "Rice{Enter}");
  // Not an Item: nothing is added, and the form says why.
  await user.type(field, "moon cheese{Enter}");
  expect(within(useUp).getByRole("alert").textContent).toBe("No Item is called “moon cheese”.");
  await user.clear(field);
  expect(
    within(useUp)
      .getAllByRole("listitem")
      .map((item) => item.textContent),
  ).toEqual([expect.stringContaining("spinach"), expect.stringContaining("rice")]);
  await user.click(within(useUp).getByRole("button", { name: "Remove rice" }));
  await user.click(within(sheet).getByRole("button", { name: "Propose dinners" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Re-roll" }));

  // Cancelled, nothing is proposed and nothing picked changes; asked again, the Items picked are still there.
  await user.click(screen.getByRole("button", { name: "Propose again" }));
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Remove spinach" }));
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Re-roll" }));
  await user.click(screen.getByRole("button", { name: "Propose again" }));
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Propose again" }));
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Remove spinach" }));
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Propose dinners" }));

  await vi.waitFor(() =>
    expect(writes(calls)).toEqual([
      { name: "propose_week", input: { date: "2026-10-26", useUp: ["spinach"] } },
      { name: "propose_week", input: { date: "2026-10-26", reroll: true, useUp: ["spinach"] } },
      { name: "propose_week", input: { date: "2026-10-26", reroll: true, useUp: ["spinach"] } },
      { name: "propose_week", input: { date: "2026-10-26" } },
    ]),
  );
});

test("a dinner cooked for its Leftovers says how many to cook for, and the Leftovers what they're of", async () => {
  const week = emptyWeek("2026-10-26");
  const curryRecipe = { id: 2, title: "Curry", baseServings: 4, photoKey: null };
  Object.assign(week.slots[2] as Slot, {
    kind: "recipe",
    recipe: curryRecipe,
    cookFor: 6,
    leftovers: [{ date: "2026-10-27", meal: "dinner" }],
  });
  Object.assign(week.slots[5] as Slot, {
    kind: "leftovers",
    leftoversOf: { date: "2026-10-26", meal: "dinner", recipe: curryRecipe },
    reason: { kind: "leftovers", of: "2026-10-26" },
  });
  const { client } = fakeClient({ get_week: () => ({ ok: true, value: week }) });
  render(() => <App client={client} />);

  const monday = await screen.findByRole("region", { name: "Monday, October 26" });
  // A meta line under the title, not a chip: chips are short labels.
  expect(within(monday).getByText("Cook for 6, with Tuesday's Leftovers.").closest(".chip")).toBeNull();
  const tuesday = screen.getByRole("region", { name: "Tuesday, October 27" });
  const dinner = within(tuesday).getByRole("region", { name: "Dinner" });
  expect(within(dinner).getByRole("heading", { name: "Leftovers of Curry" })).toBeTruthy();
  expect(within(dinner).getByText("Leftovers of Monday's dinner, cooked for both.")).toBeTruthy();
});

test("a dinner cooked for a lunch's Leftovers, or for several, says so in one sentence", async () => {
  const week = emptyWeek("2026-10-26");
  const curryRecipe = { id: 2, title: "Curry", baseServings: 4, photoKey: null };
  Object.assign(week.slots[2] as Slot, {
    kind: "recipe",
    recipe: curryRecipe,
    cookFor: 6,
    leftovers: [{ date: "2026-10-27", meal: "lunch" }],
  });
  Object.assign(week.slots[5] as Slot, {
    kind: "recipe",
    recipe: { ...curryRecipe, id: 3, title: "Stew" },
    cookFor: 8,
    leftovers: [
      { date: "2026-10-28", meal: "lunch" },
      { date: "2026-10-29", meal: "dinner" },
    ],
  });
  const { client } = fakeClient({ get_week: () => ({ ok: true, value: week }) });
  render(() => <App client={client} />);

  const monday = await screen.findByRole("region", { name: "Monday, October 26" });
  expect(within(monday).getByText("Cook for 6, with Tuesday's lunch Leftovers.")).toBeTruthy();
  const tuesday = screen.getByRole("region", { name: "Tuesday, October 27" });
  expect(within(tuesday).getByText("Cook for 8, with Leftovers on Wednesday and Thursday.")).toBeTruthy();
});

test("in the pseudo-locale, the Cook-for line and Choose actions are each one message", async () => {
  setPseudoLocale(true);
  onTestFinished(() => setPseudoLocale(false));
  const week = emptyWeek("2026-10-26");
  Object.assign(week.slots[2] as Slot, {
    kind: "recipe",
    recipe: { id: 2, title: "Curry", baseServings: 4, photoKey: null },
    cookFor: 6,
    leftovers: [{ date: "2026-10-27", meal: "dinner" }],
  });
  const { client } = fakeClient({ get_week: () => ({ ok: true, value: week }) });
  render(() => <App client={client} />);

  const monday = await screen.findByRole("region", { name: /Monday/ });
  const cookFor = within(monday).getByText(/^\[Çööķ ƒöŕ 6/);
  expect(cookFor.textContent).not.toMatch(/\[.*\[/);
  const tuesday = screen.getByRole("region", { name: /Tuesday/ });
  for (const choose of within(tuesday).getAllByRole("button", { name: /^\[Çĥööšé/ })) {
    expect(choose.textContent).not.toMatch(/\[.*\[/);
  }
});

test("Leftovers open the Recipe they're of, scaled as it's cooked, with nothing to cook", async () => {
  const user = userEvent.setup();
  const week = emptyWeek("2026-10-26");
  const pastaOnMonday = { id: 1, title: "Pasta", baseServings: 4, photoKey: null };
  Object.assign(week.slots[2] as Slot, {
    kind: "recipe",
    recipe: pastaOnMonday,
    cookFor: 6,
    leftovers: [{ date: "2026-10-27", meal: "dinner" }],
  });
  Object.assign(week.slots[5] as Slot, {
    kind: "leftovers",
    leftoversOf: { date: "2026-10-26", meal: "dinner", recipe: pastaOnMonday },
  });
  const { client } = fakeClient({ get_week: () => ({ ok: true, value: week }) });
  render(() => <App client={client} />);

  const tuesday = await screen.findByRole("region", { name: "Tuesday, October 27" });
  await user.click(within(tuesday).getByRole("button", { name: "Leftovers of Pasta" }));

  const sheet = await screen.findByRole("dialog", { name: "Pasta" });
  expect(await within(sheet).findByText("For 6. The Recipe makes 4.")).toBeTruthy();
  expect(within(sheet).queryByRole("button", { name: "Cook" })).toBeNull();
});

test("a proposed Week shows why each dinner was chosen, and asks to be reviewed", async () => {
  const { client, calls } = fakeClient({ get_week: () => ({ ok: true, value: proposedWeek() }) });
  const user = userEvent.setup();
  render(() => <App client={client} />);

  const monday = await screen.findByRole("region", { name: "Monday, October 26" });
  const dinner = within(monday).getByRole("region", { name: "Dinner" });
  await within(dinner).findByText(
    "Chosen from 12 Recipes that fit: not planned in the last 6 weeks; 30 of 45 minutes; uses up spinach; disliked by Alex.",
  );
  const tuesday = screen.getByRole("region", { name: "Tuesday, October 27" });
  expect(
    within(tuesday).getByText(
      "No Recipe fits: 3 conflict with someone eating, 4 not a main dish, 2 planned within 2 weeks, 1 over the Effort Budget.",
    ),
  ).toBeTruthy();

  expect(screen.getByRole("status").textContent).toContain("This Week was proposed and hasn't been reviewed yet.");
  await user.click(screen.getByRole("button", { name: "Re-roll" }));
  await user.click(screen.getByRole("button", { name: "Mark as reviewed" }));

  await vi.waitFor(() =>
    expect(writes(calls)).toEqual([
      { name: "propose_week", input: { date: "2026-10-26", reroll: true } },
      { name: "review_week", input: { date: "2026-10-26", reviewed: true } },
    ]),
  );
});

test("Effort Budgets are set for this Week, or for every Week", async () => {
  const { client, calls } = fakeClient({ get_week: () => ({ ok: true, value: proposedWeek() }) });
  const user = userEvent.setup();
  render(() => <App client={client} />);
  await screen.findByRole("region", { name: "Monday, October 26" });

  await user.click(screen.getByRole("heading", { level: 2, name: "Effort Budgets" }));
  const thisWeek = screen.getByRole("form", { name: "This Week's Effort Budgets" });
  expect((within(thisWeek).getByRole("spinbutton", { name: "Monday" }) as HTMLInputElement).value).toBe("30");
  // Back to the default on Monday, and a lighter Friday.
  await user.clear(within(thisWeek).getByRole("spinbutton", { name: "Monday" }));
  await user.type(within(thisWeek).getByRole("spinbutton", { name: "Monday" }), "45");
  await user.clear(within(thisWeek).getByRole("spinbutton", { name: "Friday" }));
  await user.type(within(thisWeek).getByRole("spinbutton", { name: "Friday" }), "20");
  await user.click(within(thisWeek).getByRole("button", { name: "Save" }));

  const everyWeek = screen.getByRole("form", { name: "Every Week's Effort Budgets" });
  await user.clear(within(everyWeek).getByRole("spinbutton", { name: "Saturday" }));
  await user.type(within(everyWeek).getByRole("spinbutton", { name: "Saturday" }), "150");
  await user.click(within(everyWeek).getByRole("button", { name: "Save" }));

  await vi.waitFor(() =>
    expect(writes(calls)).toEqual([
      { name: "set_week_effort_budgets", input: { date: "2026-10-26", budgets: { monday: null, friday: 20 } } },
      { name: "set_effort_budgets", input: { budgets: { saturday: 150 } } },
    ]),
  );
});

/** This Week's dinners in each state: Monday unplanned, Tuesday planned, Wednesday cooked, Thursday rated. */
function dinnersByState(): Week {
  const week = emptyWeek("2026-10-26");
  const pastaSlot = { kind: "recipe", recipe: { id: 1, title: "Pasta", baseServings: 4, photoKey: null } };
  Object.assign(week.slots[5] as Slot, pastaSlot);
  Object.assign(week.slots[8] as Slot, { ...pastaSlot, cookedAt: "2026-10-29T02:00:00.000Z" });
  Object.assign(week.slots[11] as Slot, {
    ...pastaSlot,
    cookedAt: "2026-10-30T02:00:00.000Z",
    ratings: [{ memberId: 1, rating: "again", note: null, at: "2026-10-30T02:10:00.000Z" }],
  });
  return week;
}

/** What a dinner card offers besides opening its Recipe from its title. */
const dinnerActions = (day: string) => {
  const dinner = within(screen.getByRole("region", { name: day })).getByRole("region", { name: "Dinner" });
  return within(dinner)
    .queryAllByRole("button")
    .map((button) => button.textContent)
    .filter((name) => name !== "Pasta");
};

test("each dinner card has one action: Choose a dinner, then Cook, then Rate it, then none", async () => {
  const { client } = fakeClient({ get_week: () => ({ ok: true, value: dinnersByState() }) });
  render(() => <App client={client} />);
  await screen.findByRole("region", { name: "Monday, October 26" });

  expect(dinnerActions("Monday, October 26")).toEqual(["Choose a dinner"]);
  expect(dinnerActions("Tuesday, October 27")).toEqual(["Cook"]);
  expect(dinnerActions("Wednesday, October 28")).toEqual(["Rate it"]);
  expect(dinnerActions("Thursday, October 29")).toEqual([]);

  const wednesday = within(screen.getByRole("region", { name: "Wednesday, October 28" }));
  expect(wednesday.getByText("Cooked")).toBeTruthy();
  const thursday = within(screen.getByRole("region", { name: "Thursday, October 29" }));
  expect(thursday.getByText("Again")).toBeTruthy();
});

/** Monday Leftovers, Tuesday a meal out, Wednesday no meal: decided, without a Recipe to cook. */
function dinnersWithoutRecipe(): Week {
  const week = emptyWeek("2026-10-26");
  Object.assign(week.slots[2] as Slot, { kind: "leftovers" });
  Object.assign(week.slots[5] as Slot, { kind: "eat_out" });
  Object.assign(week.slots[8] as Slot, { kind: "skip" });
  return week;
}

test("Leftovers, Eat out and Skip dinners have one action, to change them", async () => {
  const { client } = fakeClient({ get_week: () => ({ ok: true, value: dinnersWithoutRecipe() }) });
  const user = userEvent.setup();
  render(() => <App client={client} />);
  await screen.findByRole("region", { name: "Monday, October 26" });

  for (const day of ["Monday, October 26", "Tuesday, October 27", "Wednesday, October 28"]) {
    expect(dinnerActions(day)).toEqual(["Change dinner"]);
  }
  const tuesday = screen.getByRole("region", { name: "Tuesday, October 27" });
  await user.click(within(tuesday).getByRole("button", { name: "Change dinner" }));
  expect(within(tuesday).getByRole("form")).toBeTruthy();
});

test("in the pseudo-locale, a Leftovers, Eat out or Skip dinner's action doesn't say Choose", async () => {
  setPseudoLocale(true);
  onTestFinished(() => setPseudoLocale(false));
  const { client } = fakeClient({ get_week: () => ({ ok: true, value: dinnersWithoutRecipe() }) });
  render(() => <App client={client} />);
  await screen.findByRole("region", { name: /Monday/ });

  for (const day of [/Monday/, /Tuesday/, /Wednesday/]) {
    const dinner = within(screen.getByRole("region", { name: day })).getByRole("region", { name: /Đîññéŕ/ });
    const actions = within(dinner).getAllByRole("button");
    expect(actions.map((button) => button.textContent)).toEqual([expect.stringMatching(/^\[Çĥàñĝé đîññéŕ ·+\]$/)]);
  }
});

test("Clear shows when a Week's only changes are on unplanned Slots, or Leftovers linked to one", async () => {
  for (const change of [
    { note: "Picnic" },
    { locked: true },
    { diners: [1], dinersAreDefault: false, servings: 1 },
    { leftovers: [{ date: "2026-11-02", meal: "lunch" }] },
  ]) {
    const week = emptyWeek("2026-10-26");
    Object.assign(week.slots[4] as Slot, change);
    const { client } = fakeClient({ get_week: () => ({ ok: true, value: week }) });
    render(() => <App client={client} />);
    await screen.findByRole("region", { name: "Monday, October 26" });

    expect(screen.getByRole("button", { name: "Clear this Week" })).toBeTruthy();
    cleanup();
  }
});

test("Clear is hidden when only cooked meals would be left to clear, which it keeps", async () => {
  const week = emptyWeek("2026-10-26");
  Object.assign(week.slots[5] as Slot, {
    kind: "recipe",
    recipe: { id: 1, title: "Pasta", baseServings: 4, photoKey: null },
    cookedAt: "2026-10-28T02:00:00.000Z",
  });
  const { client } = fakeClient({ get_week: () => ({ ok: true, value: week }) });
  render(() => <App client={client} />);
  await screen.findByRole("region", { name: "Monday, October 26" });

  expect(screen.queryByRole("button", { name: "Clear this Week" })).toBeNull();
});

test("Rate it opens the dinner's Recipe at its rating, and the rated dinner shows the Rating", async () => {
  let rated = false;
  const fake = fakeClient({
    get_week: () => {
      const week = dinnersByState();
      if (rated) {
        (week.slots[8] as Slot).ratings = [
          { memberId: null, rating: "meh", note: null, at: "2026-10-29T03:00:00.000Z" },
        ];
      }
      return { ok: true, value: week };
    },
    rate_recipe: () => {
      rated = true;
      queueMicrotask(() => fake.notify("plan"));
      return undefined;
    },
  });
  const user = userEvent.setup();
  render(() => <App client={fake.client} />);
  const wednesday = await screen.findByRole("region", { name: "Wednesday, October 28" });

  await user.click(within(wednesday).getByRole("button", { name: "Rate it" }));
  const sheet = await screen.findByRole("dialog", { name: "Pasta" });
  const form = within(sheet).getByRole("form", { name: "How was it?" });
  await vi.waitFor(() => expect(form.contains(document.activeElement)).toBe(true));
  await user.click(within(form).getByRole("radio", { name: "Meh" }));
  await user.click(within(form).getByRole("button", { name: "Rate" }));
  await user.click(within(sheet).getByRole("button", { name: "Close the Recipe" }));

  await vi.waitFor(() => expect(dinnerActions("Wednesday, October 28")).toEqual([]));
  expect(within(wednesday).getByText("Meh")).toBeTruthy();
  expect(writes(fake.calls)).toEqual([
    { name: "rate_recipe", input: { date: "2026-10-28", meal: "dinner", rating: "meh", note: null } },
  ]);
});

test("breakfast and lunch have one action each too, in the folded strip", async () => {
  const week = dinnersByState();
  Object.assign(week.slots[3] as Slot, {
    kind: "recipe",
    recipe: { id: 1, title: "Pasta", baseServings: 4, photoKey: null },
  });
  const { client } = fakeClient({ get_week: () => ({ ok: true, value: week }) });
  const user = userEvent.setup();
  render(() => <App client={client} />);
  const tuesday = await screen.findByRole("region", { name: "Tuesday, October 27" });
  await user.click(within(tuesday).getByRole("button", { name: /^Breakfast/ }));

  const breakfast = within(tuesday).getByRole("region", { name: "Breakfast" });
  expect(
    within(breakfast)
      .getAllByRole("button")
      .map((button) => button.textContent),
  ).toEqual(["Pasta", "Cook"]);
  const lunch = within(tuesday).getByRole("region", { name: "Lunch" });
  expect(
    within(lunch)
      .getAllByRole("button")
      .map((button) => button.textContent),
  ).toEqual(["Choose a lunch"]);
});

test("an unplanned Week is seven compact rows, each with Choose a dinner", async () => {
  const { client } = fakeClient({ get_week: () => ({ ok: true, value: emptyWeek("2026-10-26") }) });
  render(() => <App client={client} />);
  const monday = await screen.findByRole("region", { name: "Monday, October 26" });

  expect(within(monday).getByText("Mon 26 · Nothing planned")).toBeTruthy();
  expect(screen.getAllByRole("button", { name: "Choose a dinner" })).toHaveLength(7);
  expect(screen.queryByRole("img")).toBeNull();
});

test("a dinner with a Recipe is marked cooked from its Recipe's sheet", async () => {
  const { client, calls } = fakeClient();
  const user = userEvent.setup();
  render(() => <App client={client} />);
  const tuesday = await screen.findByRole("region", { name: "Tuesday, October 27" });

  await user.click(within(tuesday).getByRole("button", { name: "Pasta" }));
  const sheet = await screen.findByRole("dialog", { name: "Pasta" });
  await user.click(within(sheet).getByRole("button", { name: "Mark cooked" }));

  expect(writes(calls)).toEqual([{ name: "mark_cooked", input: { date: "2026-10-27", meal: "dinner" } }]);
});

test("a cooked dinner's sheet shows its Ratings, asks for one, and can be unmarked", async () => {
  const cooked = emptyWeek("2026-10-26");
  Object.assign(cooked.slots[5] as Slot, {
    kind: "recipe",
    recipe: { id: 1, title: "Pasta", baseServings: 4, photoKey: null },
    cookedAt: "2026-10-27T02:00:00.000Z",
    ratings: [
      { memberId: 1, rating: "meh", note: "Too salty", at: "2026-10-27T02:10:00.000Z" },
      { memberId: null, rating: "again", note: null, at: "2026-10-27T02:20:00.000Z" },
    ],
  });
  const { client, calls } = fakeClient({ get_week: () => ({ ok: true, value: cooked }) });
  const user = userEvent.setup();
  render(() => <App client={client} />);
  const tuesday = await screen.findByRole("region", { name: "Tuesday, October 27" });
  await user.click(within(tuesday).getByRole("button", { name: "Pasta" }));
  const sheet = await screen.findByRole("dialog", { name: "Pasta" });

  expect(within(sheet).getByText("Cooked")).toBeTruthy();
  expect(within(sheet).getByText("Robin: Meh. Too salty")).toBeTruthy();
  expect(within(sheet).getByText("Someone: Again")).toBeTruthy();
  expect(within(sheet).queryByRole("button", { name: "Mark cooked" })).toBeNull();

  const form = within(sheet).getByRole("form", { name: "How was it?" });
  await user.click(within(form).getByRole("radio", { name: "Never again" }));
  await user.type(within(form).getByRole("textbox", { name: "Note (optional)" }), "Nobody ate it");
  await user.click(within(form).getByRole("button", { name: "Rate" }));
  await user.click(within(sheet).getByRole("button", { name: "Not cooked after all" }));

  expect(writes(calls)).toEqual([
    {
      name: "rate_recipe",
      input: { date: "2026-10-27", meal: "dinner", rating: "never", note: "Nobody ate it" },
    },
    { name: "mark_cooked", input: { date: "2026-10-27", meal: "dinner", cooked: false } },
  ]);
});

test("a cooked dinner's sheet asks whether any Staple its Recipe uses has run out", async () => {
  const cooked = emptyWeek("2026-10-26");
  Object.assign(cooked.slots[5] as Slot, {
    kind: "recipe",
    recipe: { id: 1, title: "Pasta", baseServings: 4, photoKey: null },
    cookedAt: "2026-10-27T02:00:00.000Z",
  });
  const oil: Staple = {
    item: "olive_oil",
    name: "olive oil",
    location: "pantry",
    checkEvery: 14,
    alwaysBuy: false,
    qtyPerShop: null,
    status: "stocked",
    lastChecked: null,
    outInARow: 0,
    suggestAlwaysBuy: false,
  };
  const { client, calls } = fakeClient({
    get_week: () => ({ ok: true, value: cooked }),
    list_staples: (input) => ({ ok: true, value: input.usedBy === 1 ? [oil] : [] }),
    record_staple_status: () => ({ ok: true, value: { ...oil, status: "out" } }),
  });
  const user = userEvent.setup();
  render(() => <App client={client} />);
  const tuesday = await screen.findByRole("region", { name: "Tuesday, October 27" });
  await user.click(within(tuesday).getByRole("button", { name: "Pasta" }));
  const sheet = await screen.findByRole("dialog", { name: "Pasta" });

  const runOut = await within(sheet).findByRole("group", { name: "Anything run out?" });
  const oilRow = within(runOut).getByRole("listitem");
  expect(within(oilRow).getByText("Olive oil")).toBeTruthy();
  expect(within(oilRow).getByText("Stocked").className).toBe("chip chip-leaf");
  await user.click(within(oilRow).getByRole("button", { name: "Olive oil: Out" }));

  expect(writes(calls)).toEqual([
    { name: "record_staple_status", input: { item: "olive_oil", status: "out", at: expect.any(String) } },
  ]);
});

test("marking a dinner cooked asks at once whether any Staple its Recipe uses has run out", async () => {
  const cooked = emptyWeek("2026-10-26");
  Object.assign(cooked.slots[5] as Slot, {
    kind: "recipe",
    recipe: { id: 1, title: "Pasta", baseServings: 4, photoKey: null },
    cookedAt: "2026-10-27T02:00:00.000Z",
  });
  const salt: Staple = {
    item: "salt",
    name: "salt",
    location: "pantry",
    checkEvery: 30,
    alwaysBuy: false,
    qtyPerShop: null,
    status: "stocked",
    lastChecked: null,
    outInARow: 0,
    suggestAlwaysBuy: false,
  };
  let isCooked = false;
  const fake = fakeClient({
    get_week: () => (isCooked ? { ok: true, value: cooked } : undefined),
    list_staples: (input) => ({ ok: true, value: input.usedBy === 1 ? [salt] : [] }),
    mark_cooked: () => {
      isCooked = true;
      // The change notice that follows, as the household sends it.
      queueMicrotask(() => fake.notify("plan"));
      return undefined;
    },
  });
  const user = userEvent.setup();
  render(() => <App client={fake.client} />);
  const tuesday = await screen.findByRole("region", { name: "Tuesday, October 27" });
  await user.click(within(tuesday).getByRole("button", { name: "Pasta" }));
  const sheet = await screen.findByRole("dialog", { name: "Pasta" });

  await user.click(within(sheet).getByRole("button", { name: "Mark cooked" }));

  const runOut = await within(sheet).findByRole("group", { name: "Anything run out?" });
  expect(within(runOut).getByRole("button", { name: "Salt: Out" })).toBeTruthy();
});

test("offline, the Week last loaded opens read-only: it can be cooked from, not changed", async () => {
  const online = fakeClient();
  render(() => <App client={online.client} />);
  await screen.findByRole("region", { name: "Tuesday, October 27" });
  cleanup();

  const offline: MiseClient = {
    ...online.client,
    call: (async () => {
      throw new Error("Connection closed");
    }) as MiseClient["call"],
    onConnection(listener) {
      listener(false);
      return () => {};
    },
  };
  render(() => <App client={offline} />);

  const tuesday = await screen.findByRole("region", { name: "Tuesday, October 27" });
  expect(within(tuesday).getByRole("heading", { name: "Pasta" })).toBeTruthy();
  expect(within(tuesday).getByRole("button", { name: "Cook" })).toBeTruthy();
  // Monday can only be unfolded: nothing to choose, and its Diners are shown, not editable.
  const monday = screen.getByRole("region", { name: "Monday, October 26" });
  expect(
    within(monday)
      .getAllByRole("button")
      .map((button) => button.textContent),
  ).toEqual(["Breakfast and lunch not planned"]);
  expect(within(monday).getByText("3 eating")).toBeTruthy();
  await userEvent.click(within(tuesday).getByRole("button", { name: "Pasta" }));
  const sheet = await screen.findByRole("dialog");
  expect(within(sheet).queryByRole("button", { name: "Edit dinner" })).toBeNull();
  expect(within(sheet).queryByRole("button", { name: "Mark cooked" })).toBeNull();
  expect((screen.getByRole("button", { name: "Propose dinners" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole("alert")).toBeNull();
});

test("offline, a Recipe opened over the Week before opens again from this device", async () => {
  const user = userEvent.setup();
  const online = fakeClient();
  render(() => <App client={online.client} />);
  await user.click(
    within(await screen.findByRole("region", { name: "Tuesday, October 27" })).getByRole("button", { name: "Pasta" }),
  );
  await within(await screen.findByRole("dialog", { name: "Pasta" })).findByRole("list", { name: "Ingredients" });
  cleanup();

  const offline: MiseClient = {
    ...online.client,
    call: (async () => {
      throw new Error("Connection closed");
    }) as MiseClient["call"],
    onConnection(listener) {
      listener(false);
      return () => {};
    },
  };
  render(() => <App client={offline} />);
  await user.click(
    within(await screen.findByRole("region", { name: "Tuesday, October 27" })).getByRole("button", { name: "Pasta" }),
  );

  const sheet = await screen.findByRole("dialog", { name: "Pasta" });
  const ingredients = within(sheet).getByRole("list", { name: "Ingredients" });
  expect(
    within(ingredients)
      .getAllByRole("listitem")
      .map((line) => line.textContent),
  ).toEqual(["200 g spaghetti", "2 cloves garlic, minced", "salt to taste"]);
});

test("offline, a Week kept from before that has ended isn't shown as this one", async () => {
  const online = fakeClient({ get_week: () => ({ ok: true, value: emptyWeek("2025-01-06") }) });
  render(() => <App client={online.client} />);
  await screen.findByRole("region", { name: "Monday, January 6" });
  cleanup();

  render(() => (
    <App
      client={{
        ...online.client,
        call: (async () => {
          throw new Error("Connection closed");
        }) as MiseClient["call"],
        onConnection(listener) {
          listener(false);
          return () => {};
        },
      }}
    />
  ));

  await screen.findByRole("button", { name: "Household" });
  expect(screen.queryByRole("region", { name: "Monday, January 6" })).toBeNull();
});
