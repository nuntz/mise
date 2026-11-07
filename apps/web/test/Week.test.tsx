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
import { primaries } from "./primaries";

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
  voiceMinutesPerDay: 30,
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
  readyMade: false,
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
    useUp: [],
  };
}

/**
 * This Week as proposed with seed 7, with Monday's Effort Budget overridden:
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
  });
  const { client, notify, goOnline, goOffline } = createFakeClient(
    async (name: string, input: Record<string, unknown>) => {
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
          return { ok: true, value: tuesdayDinner };
        case "set_diners":
          return { ok: true, value: [tuesdayDinner] };
        case "mark_cooked":
        case "rate_recipe":
        case "keep_slot":
          return { ok: true, value: tuesdayDinner };
        case "list_items":
          return { ok: true, value: ITEMS };
        case "propose_week":
        case "propose_dinner":
        case "set_use_up":
          return { ok: true, value: { week: thisWeek, changed: true } };
        case "set_week_effort_budgets":
          return { ok: true, value: thisWeek };
        case "set_effort_budgets":
          return { ok: true, value: DEFAULT_EFFORT_BUDGETS };
        case "clear_week":
          return { ok: true, value: emptyWeek("2026-10-26") };
        default:
          throw new Error(`Unexpected tool ${name}`);
      }
    },
  );
  return { client, calls, notify, goOnline, goOffline };
}

/** Picks `title` in Choose a Recipe, opened from the Slot form's Recipe field. */
async function chooseRecipe(user: ReturnType<typeof userEvent.setup>, form: HTMLElement, title: string) {
  await user.click(within(form).getByRole("button", { name: /^Recipe / }));
  const picker = await screen.findByRole("dialog", { name: "Choose a Recipe" });
  await user.click(await within(picker).findByRole("button", { name: title }));
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

test("the Week opens first: each day's dinner as a compact card with its photo, breakfast and lunch tucked away", async () => {
  const { client } = fakeClient();
  render(() => <App client={client} />);

  const tuesday = await screen.findByRole("region", { name: "Tuesday, October 27" });
  const dinner = within(tuesday).getByRole("region", { name: "Dinner" });
  expect(within(dinner).getByRole("heading", { name: "Pasta" })).toBeTruthy();
  // The photo is the card's thumb, which the title names: the title opens the Recipe.
  expect(dinner.querySelector(".thumb img")?.getAttribute("src")).toBe("/photos/1?v=photos/pasta");
  // Who of the Household is eating is the day's strip, which doesn't count Guests: the card does.
  expect(within(dinner).getByText("With 1 Guest")).toBeTruthy();
  expect(within(dinner).queryByText(/the Recipe makes/)).toBeNull();
  // The strip shows the count beside its icon; the whole phrase names it.
  const eating = within(tuesday).getByRole("button", { name: "3 eating" });
  expect(eating.querySelector("[aria-hidden='true']:not(svg)")?.textContent).toBe("3");
  expect(within(dinner).getByText("Use the fresh basil")).toBeTruthy();
  // Lock is retired (ADR 0030): a dinner is pencilled or the Household's own.
  expect(within(dinner).queryByText("Locked")).toBeNull();

  expect(within(tuesday).getByRole("button", { name: "No breakfast or lunch" }).getAttribute("aria-expanded")).toBe(
    "false",
  );
  expect(within(tuesday).queryByRole("region", { name: "Breakfast" })).toBeNull();
  const monday = within(screen.getByRole("region", { name: "Monday, October 26" }));
  expect(monday.getByText("Mon 26")).toBeTruthy();
  // Nothing planned is a gap, not a dish: its name is muted.
  expect(monday.getByRole("heading", { name: "Nothing planned" }).classList.contains("dish-title-none")).toBe(true);
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

test("a Ready-made dish opened over the Week is heated whole, in as many packages as it takes", async () => {
  const user = userEvent.setup();
  const week = emptyWeek("2026-10-26");
  Object.assign(week.slots[5] as Slot, {
    kind: "recipe",
    recipe: { id: 1, title: "Dumplings", baseServings: 4, photoKey: null, readyMade: true },
    servings: 6,
    cookFor: 6,
  });
  const dumplings = {
    ...pastaRecipe,
    title: "Dumplings",
    readyMade: true,
    ingredients: [parseIngredient("1 package frozen vegetable dumplings")],
  };
  const { client } = fakeClient({
    get_week: () => ({ ok: true, value: week }),
    get_recipe: () => ({ ok: true, value: dumplings }),
  });
  render(() => <App client={client} />);

  const tuesday = await screen.findByRole("region", { name: "Tuesday, October 27" });
  await user.click(within(tuesday).getByRole("button", { name: "Dumplings" }));

  const sheet = await screen.findByRole("dialog", { name: "Dumplings" });
  const ingredients = await within(sheet).findByRole("list", { name: "Ingredients" });
  expect(within(ingredients).getByRole("listitem").textContent).toBe("2 packages frozen vegetable dumplings");
});

test("a Recipe sheet's Keep, Mark cooked, Edit dinner and Cook sit at its foot, after the Steps, where a thumb reaches them", async () => {
  const user = userEvent.setup();
  const { client } = fakeClient({ get_week: () => ({ ok: true, value: proposedWeek() }) });
  render(() => <App client={client} />);

  await screen.findByRole("region", { name: "Monday, October 26" });
  await user.click(within(dinnerOn("Monday, October 26")).getByRole("button", { name: "Curry" }));
  const sheet = await screen.findByRole("dialog");
  await within(sheet).findByRole("button", { name: "Cook" });
  const steps = within(sheet).getByRole("list", { name: "Steps" });
  const foot = sheet.querySelector(".sheet-foot") as HTMLElement;

  expect(foot.parentElement).toBe(sheet);
  expect(steps.compareDocumentPosition(foot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  // Cook last, nearest the thumb.
  expect(
    within(foot)
      .getAllByRole("button")
      .map((button) => button.textContent),
  ).toEqual(["Keep", "Mark cooked", "Edit dinner", "Cook"]);
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

test("a Recipe opened over the Week shows its photo under its title, and nothing in its place without one", async () => {
  const user = userEvent.setup();
  const withPhoto = fakeClient();
  const { unmount } = render(() => <App client={withPhoto.client} />);

  const tuesday = await screen.findByRole("region", { name: "Tuesday, October 27" });
  await user.click(within(tuesday).getByRole("button", { name: "Pasta" }));
  const sheet = await screen.findByRole("dialog", { name: "Pasta" });
  const photo = await within(sheet).findByRole("img", { name: "Photo of Pasta" });
  expect(photo.getAttribute("src")).toBe("/photos/1?v=photos/pasta");
  expect(precedes(within(sheet).getByRole("heading", { name: "Pasta" }), photo)).toBe(true);
  expect(precedes(photo, within(sheet).getByRole("list", { name: "Ingredients" }))).toBe(true);
  unmount();

  const withoutPhoto = fakeClient({ get_recipe: () => ({ ok: true, value: { ...pastaRecipe, photoKey: null } }) });
  render(() => <App client={withoutPhoto.client} />);
  const again = await screen.findByRole("region", { name: "Tuesday, October 27" });
  await user.click(within(again).getByRole("button", { name: "Pasta" }));
  const bare = await screen.findByRole("dialog", { name: "Pasta" });
  await within(bare).findByRole("list", { name: "Ingredients" });
  expect(bare.querySelector(".photo")).toBeNull();
});

test("a Recipe opened over the Week shows its chips as its page does, but not its tags", async () => {
  const user = userEvent.setup();
  const everyChip = {
    ...pastaRecipe,
    readyMade: true,
    recurring: { weekday: "friday" },
    yieldsLeftovers: true,
    tags: ["quick"],
  };
  const { client } = fakeClient({ get_recipe: () => ({ ok: true, value: everyChip }) });
  render(() => <App client={client} />);

  const tuesday = await screen.findByRole("region", { name: "Tuesday, October 27" });
  await user.click(within(tuesday).getByRole("button", { name: "Pasta" }));

  const sheet = await screen.findByRole("dialog", { name: "Pasta" });
  const chips = await within(sheet).findByText("Ready-made");
  expect([...(chips.closest(".chips")?.querySelectorAll(".chip") ?? [])].map((chip) => chip.textContent)).toEqual([
    "Ready-made",
    "Every Friday",
    "Yields Leftovers",
  ]);
});

test("a Recipe opened over the Week without chips shows none", async () => {
  const user = userEvent.setup();
  const { client } = fakeClient();
  render(() => <App client={client} />);

  const tuesday = await screen.findByRole("region", { name: "Tuesday, October 27" });
  await user.click(within(tuesday).getByRole("button", { name: "Pasta" }));

  const sheet = await screen.findByRole("dialog", { name: "Pasta" });
  await within(sheet).findByRole("list", { name: "Steps" });
  expect(sheet.querySelector(".chips")).toBeNull();
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
  await user.click(within(tuesday).getByRole("button", { name: "Breakfast: Pasta" }));
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

test("editing a dinner sends what changed in one change to the Slot, with no Lock to set", async () => {
  const { client, calls } = fakeClient();
  const user = userEvent.setup();
  render(() => <App client={client} />);
  const tuesday = await screen.findByRole("region", { name: "Tuesday, October 27" });

  await user.click(within(tuesday).getByRole("button", { name: "Pasta" }));
  await user.click(
    within(await screen.findByRole("dialog", { name: "Pasta" })).getByRole("button", { name: "Edit dinner" }),
  );
  // The Recipe's sheet gives way to the Slot form's, which fits the screen with Save at its foot.
  expect(screen.queryByRole("dialog", { name: "Pasta" })).toBeNull();
  expect(screen.getByRole("dialog", { name: "Edit dinner" })).toBeTruthy();
  const form = within(tuesday).getByRole("form", { name: "Dinner" });
  await chooseRecipe(user, form, "Curry");
  await user.click(within(form).getByRole("checkbox", { name: "Everyone" }));
  await user.click(within(form).getByRole("checkbox", { name: "Alex" }));
  expect(within(form).queryByRole("checkbox", { name: "Locked" })).toBeNull();
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
  ]);
});

test("a dinner's Recipe shows in Edit dinner, and Choose a Recipe picks another from the Recipes", async () => {
  const { client, calls } = fakeClient();
  const user = userEvent.setup();
  render(() => <App client={client} />);
  const tuesday = await screen.findByRole("region", { name: "Tuesday, October 27" });
  await user.click(within(tuesday).getByRole("button", { name: "Pasta" }));
  await user.click(
    within(await screen.findByRole("dialog", { name: "Pasta" })).getByRole("button", { name: "Edit dinner" }),
  );
  const form = within(tuesday).getByRole("form", { name: "Dinner" });

  await user.click(within(form).getByRole("button", { name: "Recipe Pasta" }));
  const picker = await screen.findByRole("dialog", { name: "Choose a Recipe" });
  // The Recipe chosen already is marked among the others.
  expect((await within(picker).findByRole("button", { name: "Pasta" })).getAttribute("aria-current")).toBe("true");
  expect(within(picker).getByRole("button", { name: "Curry" }).getAttribute("aria-current")).toBeNull();
  await user.click(within(picker).getByRole("button", { name: "Curry" }));

  expect(screen.queryByRole("dialog", { name: "Choose a Recipe" })).toBeNull();
  expect(within(form).getByRole("button", { name: "Recipe Curry" })).toBeTruthy();
  await user.click(within(form).getByRole("button", { name: "Save" }));
  await vi.waitFor(() => expect(within(tuesday).queryByRole("form")).toBeNull());
  expect(writes(calls)).toEqual([
    {
      name: "set_slot",
      input: { date: "2026-10-27", meal: "dinner", kind: "recipe", recipeId: 2, note: "Use the fresh basil" },
    },
  ]);
});

test("Choose a Recipe finds what Search Recipes is typed for, says when nothing matches, and closes keeping the Recipe", async () => {
  const { client, calls } = fakeClient({
    search_recipes: ({ query }) =>
      query === "cur" ? { ok: true, value: [curry] } : query === "lasagne" ? { ok: true, value: [] } : undefined,
  });
  const user = userEvent.setup();
  render(() => <App client={client} />);
  const monday = await screen.findByRole("region", { name: "Monday, October 26" });
  await user.click(within(monday).getByRole("button", { name: "Choose a dinner" }));
  const form = within(monday).getByRole("form", { name: "Dinner" });
  await user.selectOptions(within(form).getByRole("combobox", { name: "What" }), "A Recipe");

  await user.click(within(form).getByRole("button", { name: "Recipe Choose a Recipe" }));
  const picker = await screen.findByRole("dialog", { name: "Choose a Recipe" });
  const search = within(picker).getByRole("searchbox", { name: "Search Recipes" });
  expect(document.activeElement).toBe(search);
  await within(picker).findByRole("button", { name: "Pasta" });
  await user.type(search, "cur");
  await vi.waitFor(() => expect(within(picker).queryByRole("button", { name: "Pasta" })).toBeNull());
  expect(within(picker).getByRole("button", { name: "Curry" })).toBeTruthy();
  expect(calls.filter((call) => call.name === "search_recipes").at(-1)?.input).toEqual({ query: "cur" });

  await user.clear(search);
  await user.type(search, "lasagne");
  expect(await within(picker).findByText("No Recipes match.")).toBeTruthy();
  await user.click(within(picker).getByRole("button", { name: "Close" }));

  expect(screen.queryByRole("dialog", { name: "Choose a Recipe" })).toBeNull();
  const field = within(form).getByRole("button", { name: "Recipe Choose a Recipe" });
  expect(document.activeElement).toBe(field);
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
      "Every Slot of the Week starting Monday, October 26 is emptied for good; meals already cooked stay.",
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

  const strip = within(tuesday).getByRole("button", { name: "Breakfast: Pasta" });
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
  await chooseRecipe(user, form, "Curry");
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
  await chooseRecipe(user, form, "Curry");
  await user.click(within(form).getByRole("button", { name: "Save" }));
  await user.type(await within(form).findByRole("textbox", { name: "Why it's safe for Robin (Peanut)" }), "Hers apart");
  await chooseRecipe(user, form, "Pasta");

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

  await vi.waitFor(() =>
    expect(writes(calls)).toEqual([
      { name: "set_use_up", input: { date: "2026-10-26", items: [] } },
      { name: "propose_week", input: { date: "2026-10-26" } },
    ]),
  );
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
  expect(screen.getByText("Re-roll changes only these dinners. Yours stay.")).toBeTruthy();

  goOffline();

  const useUp = screen.getByRole("button", { name: "Use it up" }) as HTMLButtonElement;
  for (const control of [reroll, useUp]) {
    expect(control.disabled).toBe(true);
    expect(description(control)).toBe("Needs a connection.");
  }
  expect(screen.queryByText(/Re-roll changes only these dinners/)).toBeNull();
});

/** This Week as proposed, with every dinner the Household's own: Pasta, chosen by hand, every day. */
function ownWeek(): Week {
  const week = proposedWeek();
  for (const slot of week.slots.filter((slot) => slot.meal === "dinner")) {
    Object.assign(slot, {
      kind: "recipe",
      recipe: { id: 1, title: "Pasta", baseServings: 4, photoKey: "photos/pasta" },
      reason: null,
    });
  }
  return week;
}

test("Re-roll is disabled, and says why under it, when every dinner is the Household's own", async () => {
  const { client } = fakeClient({ get_week: () => ({ ok: true, value: ownWeek() }) });
  render(() => <App client={client} />);

  const reroll = (await screen.findByRole("button", { name: "Re-roll" })) as HTMLButtonElement;
  expect(reroll.disabled).toBe(true);
  const reason = screen.getByText(
    "Every dinner is yours. To have Mise choose one, tap Change on its card, or open it and tap Edit dinner.",
  );
  expect(description(reroll)).toBe(
    "Every dinner is yours. To have Mise choose one, tap Change on its card, or open it and tap Edit dinner.",
  );
  // Under Re-roll and Use it up, which sit side by side.
  expect(precedes(reroll, screen.getByRole("button", { name: "Use it up" }))).toBe(true);
  expect(precedes(screen.getByRole("button", { name: "Use it up" }), reason)).toBe(true);
  expect(screen.queryByText(/Re-roll changes only these dinners/)).toBeNull();
});

test("Re-roll and Use it up sit side by side, and Re-roll's hint under them is led by the Pencilled chip", async () => {
  const { client } = fakeClient({ get_week: () => ({ ok: true, value: proposedWeek() }) });
  render(() => <App client={client} />);

  const reroll = await screen.findByRole("button", { name: "Re-roll" });
  const useUp = screen.getByRole("button", { name: "Use it up" });
  const hint = screen.getByText("Re-roll changes only these dinners. Yours stay.");
  expect(reroll.parentElement).toBe(useUp.parentElement);
  expect(precedes(useUp, hint)).toBe(true);
  expect(hint.textContent).toBe("PencilledRe-roll changes only these dinners. Yours stay.");
  // Neither outranks the Week: no primary until there is something to cook.
  expect(reroll.classList.contains("button-primary")).toBe(false);
});

test.each<[string, Record<string, Answer>]>([
  // The fake client's Week: Tuesday's dinner chosen by hand.
  ["not yet proposed", {}],
  ["proposed", { get_week: () => ({ ok: true, value: proposedWeek() }) }],
])("a Week %s offers no Grocery List button: the Groceries tab is the way to the list", async (_, answers) => {
  const { client } = fakeClient(answers);
  render(() => <App client={client} />);
  await screen.findByRole("region", { name: "Monday, October 26" });

  expect(screen.queryByRole("button", { name: "Grocery List" })).toBeNull();
  expect(screen.getByRole("button", { name: "Groceries" })).toBeTruthy();
});

/** Whether `a` comes before `b` in the document. */
function precedes(a: Node, b: Node): boolean {
  return Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
}

test("Re-roll is disabled when one dinner has nobody eating and the rest are the Household's own", async () => {
  const week = ownWeek();
  Object.assign(week.slots[2] as Slot, {
    kind: "unplanned",
    recipe: null,
    diners: [],
    dinersAreDefault: false,
    servings: 0,
    reason: { kind: "nobody_eating" },
  });
  const { client } = fakeClient({ get_week: () => ({ ok: true, value: week }) });
  render(() => <App client={client} />);

  const reroll = (await screen.findByRole("button", { name: "Re-roll" })) as HTMLButtonElement;
  expect(reroll.disabled).toBe(true);
  expect(description(reroll)).toBe(
    "Every dinner is yours. To have Mise choose one, tap Change on its card, or open it and tap Edit dinner.",
  );
});

test.each<[string, Partial<Slot>]>([
  ["is unplanned", { kind: "unplanned", recipe: null }],
  [
    "had no Recipe that fit",
    {
      kind: "unplanned",
      recipe: null,
      reason: { kind: "no_candidate", excluded: { conflict: 1, never: 0, course: 0, recent: 0, effort: 0 } },
    },
  ],
  ["is pencilled", { reason: { kind: "chosen", candidates: 3, factors: [] } }],
  // A Re-roll leaves it unplanned.
  [
    "is pencilled and nobody is eating it any more",
    { reason: { kind: "chosen", candidates: 3, factors: [] }, diners: [], dinersAreDefault: false, servings: 0 },
  ],
])("Re-roll is enabled when one dinner %s and the rest are the Household's own", async (_, tuesday) => {
  const week = ownWeek();
  Object.assign(week.slots[5] as Slot, tuesday);
  const { client, calls } = fakeClient({ get_week: () => ({ ok: true, value: week }) });
  const user = userEvent.setup();
  render(() => <App client={client} />);

  const reroll = (await screen.findByRole("button", { name: "Re-roll" })) as HTMLButtonElement;
  expect(reroll.disabled).toBe(false);
  expect(reroll.getAttribute("aria-describedby")).toBeNull();
  expect(screen.queryByText(/Every dinner is yours/)).toBeNull();
  await user.click(reroll);
  await vi.waitFor(() =>
    expect(writes(calls)).toEqual([{ name: "propose_week", input: { date: "2026-10-26", reroll: true } }]),
  );
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

test("the Week's Use it up shows under Re-roll, and changing it stores it; Re-roll sends no Items", async () => {
  const { client, calls } = fakeClient({
    get_week: () => ({ ok: true, value: { ...proposedWeek(), useUp: ["spinach"] } }),
  });
  const user = userEvent.setup();
  render(() => <App client={client} />);
  await screen.findByRole("region", { name: "Monday, October 26" });
  expect(screen.queryByRole("form", { name: "Use it up" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Propose again" })).toBeNull();

  await user.click(screen.getByRole("button", { name: "Use it up: spinach" }));
  const sheet = screen.getByRole("dialog", { name: "Use it up" });
  // The sheet takes the focus, not its field, so a phone doesn't open the keyboard and its predictive text.
  await vi.waitFor(() => expect(document.activeElement).toBe(sheet));
  const useUp = within(sheet).getByRole("form", { name: "Use it up" });
  const field = within(useUp).getByRole("combobox", { name: "Item on hand" });
  await user.type(field, "Rice{Enter}");
  await user.type(field, "baby spinach");
  await user.click(within(useUp).getByRole("button", { name: "Add" }));
  // Not an Item: nothing is added, and the form says why.
  await user.type(field, "moon cheese{Enter}");
  expect(within(useUp).getByRole("alert").textContent).toBe("No Item is called “moon cheese”.");
  await user.clear(field);
  expect(
    within(useUp)
      .getAllByRole("listitem")
      .map((item) => item.textContent),
  ).toEqual([expect.stringContaining("spinach"), expect.stringContaining("rice")]);
  await user.click(within(sheet).getByRole("button", { name: "Save" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Re-roll" }));

  // Cancelled or escaped, nothing is stored; opened again, it shows the Week's Use it up.
  await user.click(screen.getByRole("button", { name: "Use it up: spinach" }));
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Remove spinach" }));
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Use it up: spinach" }));
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Use it up: spinach" }));
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Remove spinach" }));
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Save" }));

  await vi.waitFor(() =>
    expect(writes(calls)).toEqual([
      { name: "set_use_up", input: { date: "2026-10-26", items: ["spinach", "rice"] } },
      { name: "propose_week", input: { date: "2026-10-26", reroll: true } },
      { name: "set_use_up", input: { date: "2026-10-26", items: [] } },
    ]),
  );
});

test("a Week with no Use it up says so under Re-roll, and names its Items once it has some", async () => {
  const { client } = fakeClient({
    get_week: () => ({ ok: true, value: { ...proposedWeek(), useUp: ["spinach", "rice"] } }),
  });
  render(() => <App client={client} />);

  expect(await screen.findByRole("button", { name: "Use it up: spinach, rice" })).toBeTruthy();
  cleanup();

  const { client: other } = fakeClient({ get_week: () => ({ ok: true, value: proposedWeek() }) });
  render(() => <App client={other} />);
  expect(await screen.findByRole("button", { name: "Use it up" })).toBeTruthy();
});

test("“Propose dinners” stores the Items picked, then proposes", async () => {
  const { client, calls } = fakeClient();
  const user = userEvent.setup();
  render(() => <App client={client} />);
  await screen.findByRole("region", { name: "Monday, October 26" });
  await user.click(screen.getByRole("button", { name: "Next Week" }));
  await screen.findByText("Nothing planned yet");

  await user.click(screen.getByRole("button", { name: "Propose dinners" }));
  const sheet = screen.getByRole("dialog", { name: "Use it up" });
  await user.type(within(sheet).getByRole("combobox", { name: "Item on hand" }), "spinach{Enter}");
  await user.click(within(sheet).getByRole("button", { name: "Propose dinners" }));

  await vi.waitFor(() =>
    expect(writes(calls)).toEqual([
      { name: "set_use_up", input: { date: "2026-11-02", items: ["spinach"] } },
      { name: "propose_week", input: { date: "2026-11-02" } },
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
  expect(within(monday).getByText("For 6, with Tuesday's Leftovers").closest(".chip")).toBeNull();
  const tuesday = screen.getByRole("region", { name: "Tuesday, October 27" });
  const dinner = within(tuesday).getByRole("region", { name: "Dinner" });
  expect(within(dinner).getByRole("heading", { name: "Leftovers of Curry" })).toBeTruthy();
  // Mise pencilled them: the card says so, and why is in the sheet its title opens.
  expect(within(dinner).getByText("Pencilled")).toBeTruthy();
  expect(within(dinner).queryByText("Leftovers of Monday's dinner, cooked for both.")).toBeNull();
  await userEvent.click(within(dinner).getByRole("button", { name: "Leftovers of Curry" }));
  expect(
    within(await screen.findByRole("dialog")).getByText("Leftovers of Monday's dinner, cooked for both."),
  ).toBeTruthy();
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
  expect(within(monday).getByText("For 6, with Tuesday's lunch Leftovers")).toBeTruthy();
  const tuesday = screen.getByRole("region", { name: "Tuesday, October 27" });
  expect(within(tuesday).getByText("For 8, with Leftovers on Wednesday and Thursday")).toBeTruthy();
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
  const cookFor = within(monday).getByText(/^\[Ƒöŕ 6/);
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

const roastChicken: RecipeSummary = { ...pasta, id: 3, title: "Roast chicken", photoKey: null };
const slotRecipe = ({ id, title }: RecipeSummary) => ({ id, title, baseServings: 4, photoKey: null, readyMade: false });

/**
 * The Week before this one: Monday's dinner a Curry, Saturday's lunch a Draft no search finds, and
 * Sunday's dinner a Roast chicken, cooked.
 */
function weekBefore(): Week {
  const week = emptyWeek("2026-10-19");
  Object.assign(week.slots[2] as Slot, { kind: "recipe", recipe: slotRecipe(curry) });
  Object.assign(week.slots[16] as Slot, {
    kind: "recipe",
    recipe: { ...slotRecipe(pasta), id: 9, title: "Imported stew" },
  });
  Object.assign(week.slots[20] as Slot, {
    kind: "recipe",
    recipe: slotRecipe(roastChicken),
    cookedAt: "2026-10-26T02:00:00.000Z",
  });
  return week;
}

/** This Week with Monday's breakfast a Curry, and Tuesday's dinner the Pasta. */
function curryAndPasta(): Week {
  const week = emptyWeek("2026-10-26");
  Object.assign(week.slots[0] as Slot, { kind: "recipe", recipe: slotRecipe(curry) });
  Object.assign(week.slots[5] as Slot, { kind: "recipe", recipe: slotRecipe(pasta) });
  return week;
}

/** A client whose Week is `thisWeek`, and whose Week before is `weekBefore()`. */
function fakeClientWithWeekBefore(answers: Record<string, Answer> = {}, thisWeek = curryAndPasta()) {
  return fakeClient({
    get_week: (input) => ({
      ok: true,
      value: typeof input.date === "string" && input.date < "2026-10-26" ? weekBefore() : thisWeek,
    }),
    search_recipes: () => ({ ok: true, value: [curry, pasta, roastChicken] }),
    ...answers,
  });
}

const optionNames = (select: HTMLElement) =>
  within(select)
    .getAllByRole("option")
    .map((option) => option.textContent);
const selectedName = (select: HTMLElement) =>
  within(select)
    .getAllByRole("option")
    .find((option) => (option as HTMLOptionElement).selected)?.textContent;

test("Leftovers offer the meals with a Recipe in the seven days before, newest first, into the Week before", async () => {
  const { client } = fakeClientWithWeekBefore();
  const user = userEvent.setup();
  render(() => <App client={client} />);
  const monday = await screen.findByRole("region", { name: "Monday, October 26" });

  await user.click(within(monday).getByRole("button", { name: "Choose a dinner" }));
  const form = within(monday).getByRole("form", { name: "Dinner" });
  expect(within(form).queryByRole("combobox", { name: "Leftovers of" })).toBeNull();
  await user.selectOptions(within(form).getByRole("combobox", { name: "What" }), "Leftovers");

  const of = within(form).getByRole("combobox", { name: "Leftovers of" });
  // Last Monday's dinner is a week back, Saturday's lunch a Draft, and Tuesday's dinner comes later.
  await vi.waitFor(() =>
    expect(optionNames(of)).toEqual([
      "Nothing planned here",
      "Monday's breakfast, Curry",
      "Sunday's dinner, Roast chicken",
    ]),
  );
  expect(selectedName(of)).toBe("Nothing planned here");
});

test("a lunch's Leftovers reach back to last week's dinner on the same day, less than seven days before", async () => {
  const { client } = fakeClientWithWeekBefore();
  const user = userEvent.setup();
  render(() => <App client={client} />);
  const monday = await screen.findByRole("region", { name: "Monday, October 26" });

  await user.click(within(monday).getByRole("button", { expanded: false }));
  await user.click(within(monday).getByRole("button", { name: "Choose a lunch" }));
  const form = within(monday).getByRole("form", { name: "Lunch" });
  await user.selectOptions(within(form).getByRole("combobox", { name: "What" }), "Leftovers");

  const of = within(form).getByRole("combobox", { name: "Leftovers of" });
  await vi.waitFor(() =>
    expect(optionNames(of)).toEqual([
      "Nothing planned here",
      "Monday's breakfast, Curry",
      "Sunday's dinner, Roast chicken",
      "Monday's dinner, Curry",
    ]),
  );
});

test("Leftovers of a meal picked are linked to it after the rest of the change, and of nothing unless one is", async () => {
  const { client, calls } = fakeClientWithWeekBefore({
    link_leftovers: () => ({ ok: true, value: emptyWeek("2026-10-26").slots[2] }),
  });
  const user = userEvent.setup();
  render(() => <App client={client} />);
  const monday = await screen.findByRole("region", { name: "Monday, October 26" });

  await user.click(within(monday).getByRole("button", { name: "Choose a dinner" }));
  let form = within(monday).getByRole("form", { name: "Dinner" });
  await user.selectOptions(within(form).getByRole("combobox", { name: "What" }), "Leftovers");
  const of = within(form).getByRole("combobox", { name: "Leftovers of" });
  await within(of).findByRole("option", { name: "Sunday's dinner, Roast chicken" });
  await user.selectOptions(of, "Sunday's dinner, Roast chicken");
  await user.click(within(form).getByRole("button", { name: "Save" }));

  await vi.waitFor(() => expect(within(monday).queryByRole("form")).toBeNull());
  expect(writes(calls)).toEqual([
    { name: "set_slot", input: { date: "2026-10-26", meal: "dinner", kind: "leftovers", note: null } },
    {
      name: "link_leftovers",
      input: { date: "2026-10-26", meal: "dinner", of: { date: "2026-10-25", meal: "dinner" } },
    },
  ]);

  calls.length = 0;
  await user.click(within(monday).getByRole("button", { name: "Choose a dinner" }));
  form = within(monday).getByRole("form", { name: "Dinner" });
  await user.selectOptions(within(form).getByRole("combobox", { name: "What" }), "Leftovers");
  await user.click(within(form).getByRole("button", { name: "Save" }));

  await vi.waitFor(() => expect(within(monday).queryByRole("form")).toBeNull());
  expect(writes(calls)).toEqual([
    { name: "set_slot", input: { date: "2026-10-26", meal: "dinner", kind: "leftovers", note: null } },
  ]);
});

test("linked Leftovers open with their meal chosen, even one further back; unchanged, they send nothing", async () => {
  const thisWeek = emptyWeek("2026-10-26");
  Object.assign(thisWeek.slots[8] as Slot, {
    kind: "leftovers",
    leftoversOf: { date: "2026-10-19", meal: "dinner", recipe: slotRecipe(curry) },
  });
  const { client, calls } = fakeClientWithWeekBefore(
    { link_leftovers: () => ({ ok: true, value: thisWeek.slots[8] }) },
    thisWeek,
  );
  const user = userEvent.setup();
  render(() => <App client={client} />);
  const wednesday = await screen.findByRole("region", { name: "Wednesday, October 28" });

  await user.click(within(wednesday).getByRole("button", { name: "Change dinner" }));
  let form = within(wednesday).getByRole("form", { name: "Dinner" });
  expect(selectedName(within(form).getByRole("combobox", { name: "Leftovers of" }))).toBe("Monday's dinner, Curry");
  await user.click(within(form).getByRole("button", { name: "Save" }));
  await vi.waitFor(() => expect(within(wednesday).queryByRole("form")).toBeNull());
  expect(writes(calls)).toEqual([]);

  await user.click(within(wednesday).getByRole("button", { name: "Change dinner" }));
  form = within(wednesday).getByRole("form", { name: "Dinner" });
  await user.selectOptions(within(form).getByRole("combobox", { name: "Leftovers of" }), "Nothing planned here");
  await user.click(within(form).getByRole("button", { name: "Save" }));

  await vi.waitFor(() => expect(within(wednesday).queryByRole("form")).toBeNull());
  expect(writes(calls)).toEqual([{ name: "link_leftovers", input: { date: "2026-10-28", meal: "dinner", of: null } }]);
});

test("Leftovers linked to a meal that isn't safe are refused, and linked anyway with a reason", async () => {
  const { client, calls } = fakeClientWithWeekBefore({
    link_leftovers: (input) =>
      input.overrides
        ? { ok: true, value: emptyWeek("2026-10-26").slots[2] }
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
  await user.selectOptions(within(form).getByRole("combobox", { name: "What" }), "Leftovers");
  await user.selectOptions(within(form).getByRole("combobox", { name: "Leftovers of" }), "Monday's breakfast, Curry");
  await user.click(within(form).getByRole("button", { name: "Save" }));

  const warning = await within(form).findByRole("alert");
  expect(warning.textContent).toContain("Not safe for Robin (Peanut, Allergy): Curry contains it.");
  await user.type(within(form).getByRole("textbox", { name: "Why it's safe for Robin (Peanut)" }), "Hers on the side");
  await user.click(within(form).getByRole("button", { name: "Save anyway" }));

  await vi.waitFor(() => expect(within(monday).queryByRole("form")).toBeNull());
  expect(writes(calls).at(-1)).toEqual({
    name: "link_leftovers",
    input: {
      date: "2026-10-26",
      meal: "dinner",
      of: { date: "2026-10-26", meal: "breakfast" },
      overrides: [{ who: 1, allergen: "peanut", reason: "Hers on the side" }],
    },
  });
});

test("a proposed Week shows why each dinner was chosen, with nothing to mark reviewed", async () => {
  const { client, calls } = fakeClient({ get_week: () => ({ ok: true, value: proposedWeek() }) });
  const user = userEvent.setup();
  render(() => <App client={client} />);

  // A pencilled Recipe says why in the sheet its title opens, with Keep at its foot.
  const monday = await screen.findByRole("region", { name: "Monday, October 26" });
  const dinner = within(monday).getByRole("region", { name: "Dinner" });
  await user.click(within(dinner).getByRole("button", { name: "Curry" }));
  const sheet = await screen.findByRole("dialog");
  await within(sheet).findByText(
    "Chosen from 12 Recipes that fit: not planned in the last 6 weeks; 30 of 45 minutes; uses up spinach; disliked by Alex.",
  );
  expect(within(sheet).getByRole("button", { name: "Keep" })).toBeTruthy();
  await user.keyboard("{Escape}");
  // A dinner with no Recipe to open says why on its card.
  const tuesday = screen.getByRole("region", { name: "Tuesday, October 27" });
  expect(
    within(tuesday).getByText(
      "No Recipe fits: 3 conflict with someone eating, 4 not a main dish, 2 planned within 2 weeks, 1 over the Effort Budget.",
    ),
  ).toBeTruthy();

  expect(screen.queryByText("This Week was proposed and hasn't been reviewed yet.")).toBeNull();
  expect(screen.queryByRole("button", { name: "Mark as reviewed" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Re-roll" }));

  await vi.waitFor(() =>
    expect(writes(calls)).toEqual([{ name: "propose_week", input: { date: "2026-10-26", reroll: true } }]),
  );
});

test("a Re-roll that changed nothing says so, and one that changed a dinner says nothing", async () => {
  let changed = false;
  const { client } = fakeClient({
    get_week: () => ({ ok: true, value: proposedWeek() }),
    propose_week: () => ({ ok: true, value: { week: proposedWeek(), changed } }),
  });
  const user = userEvent.setup();
  render(() => <App client={client} />);
  await screen.findByRole("region", { name: "Monday, October 26" });

  await user.click(screen.getByRole("button", { name: "Re-roll" }));

  const note = await screen.findByText("Nothing to re-roll: every dinner is yours, or has only one Recipe that fits.");
  expect(note.getAttribute("role")).toBe("status");
  expect(note.classList).toContain("banner-plum");
  changed = true;
  await user.click(screen.getByRole("button", { name: "Re-roll" }));
  await vi.waitFor(() => expect(screen.queryByText(/Nothing to re-roll/)).toBeNull());
});

test("a Re-roll that changed nothing names a Recurring Recipe's night as “Let Mise choose” does", async () => {
  const week = proposedWeek();
  const tacos = { id: 3, title: "Tacos", baseServings: 4, photoKey: null };
  Object.assign(week.slots[8] as Slot, {
    kind: "recipe",
    recipe: tacos,
    reason: { kind: "recurring", recurrence: { weekday: "wednesday" } },
  });
  const { client } = fakeClient({
    get_week: () => ({ ok: true, value: week }),
    propose_week: () => ({ ok: true, value: { week, changed: false } }),
  });
  const user = userEvent.setup();
  render(() => <App client={client} />);
  await screen.findByRole("region", { name: "Monday, October 26" });

  await user.click(screen.getByRole("button", { name: "Re-roll" }));

  expect(
    await screen.findByText(
      "Nothing to re-roll: every dinner is yours, or has only one Recipe that fits. " +
        "Wednesday is a recurring Tacos night: change the rule to change it.",
    ),
  ).toBeTruthy();
});

test("saving a Use it up that changed no dinner says nothing that fits uses its Items better", async () => {
  const { client } = fakeClient({
    get_week: () => ({ ok: true, value: proposedWeek() }),
    set_use_up: () => ({
      ok: true,
      value: { week: { ...proposedWeek(), useUp: ["spinach", "rice"] }, changed: false },
    }),
  });
  const user = userEvent.setup();
  render(() => <App client={client} />);
  await screen.findByRole("region", { name: "Monday, October 26" });

  await user.click(screen.getByRole("button", { name: "Use it up" }));
  const useUp = within(screen.getByRole("dialog")).getByRole("form", { name: "Use it up" });
  const field = within(useUp).getByRole("combobox", { name: "Item on hand" });
  await user.type(field, "spinach{Enter}");
  await user.type(field, "Rice{Enter}");
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Save" }));

  const note = await screen.findByText(
    "No dinner changed: nothing that fits uses spinach and rice better than what's planned.",
  );
  expect(note.getAttribute("role")).toBe("status");
  // The answer to the Save just tapped, not standing copy: a tinted note.
  expect(note.classList).toContain("banner-plum");
});

test("the Slot sheet shows the dinner's Recipe at once, searching the Recipes only once Choose a Recipe opens", async () => {
  const { client, calls } = fakeClient({ get_week: () => ({ ok: true, value: proposedWeek() }) });
  const user = userEvent.setup();
  render(() => <App client={client} />);
  await screen.findByRole("region", { name: "Monday, October 26" });

  await user.click(within(dinnerOn("Monday, October 26")).getByRole("button", { name: "Curry" }));
  await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Edit dinner" }));
  const form = within(dinnerOn("Monday, October 26")).getByRole("form", { name: "Dinner" });

  expect(within(form).getByRole("button", { name: "Recipe Curry" })).toBeTruthy();
  expect(calls.filter((call) => call.name === "search_recipes")).toEqual([]);
});

test("“Let Mise choose” shows in the Slot sheet of the Household's own dinners, and proposes that dinner", async () => {
  const week = proposedWeek();
  const tacos = { id: 3, title: "Tacos", baseServings: 4, photoKey: null };
  Object.assign(week.slots[8] as Slot, { kind: "recipe", recipe: tacos });
  const { client, calls } = fakeClient({ get_week: () => ({ ok: true, value: week }) });
  const user = userEvent.setup();
  render(() => <App client={client} />);

  const editDinner = async (day: HTMLElement, title: string) => {
    await user.click(within(day).getByRole("button", { name: title }));
    await user.click(
      // The fake client's Recipe is always Pasta, whichever is opened.
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Edit dinner" }),
    );
    return within(day).getByRole("form", { name: "Dinner" });
  };

  // Monday's dinner is pencilled: there is nothing to hand back.
  const monday = await screen.findByRole("region", { name: "Monday, October 26" });
  const pencilled = await editDinner(monday, "Curry");
  expect(within(pencilled).queryByRole("button", { name: "Let Mise choose" })).toBeNull();
  await user.click(within(pencilled).getByRole("button", { name: "Cancel" }));

  const wednesday = screen.getByRole("region", { name: "Wednesday, October 28" });
  const own = await editDinner(wednesday, "Tacos");
  await user.click(within(own).getByRole("button", { name: "Let Mise choose" }));

  await vi.waitFor(() => expect(within(wednesday).queryByRole("form")).toBeNull());
  expect(writes(calls)).toEqual([{ name: "propose_dinner", input: { date: "2026-10-28" } }]);
});

test("“Let Mise choose” on a Recurring Recipe's night says the rule is what to change", async () => {
  const week = proposedWeek();
  const tacos = { id: 3, title: "Tacos", baseServings: 4, photoKey: null };
  Object.assign(week.slots[8] as Slot, { kind: "recipe", recipe: tacos });
  const recurring = structuredClone(week);
  Object.assign(recurring.slots[8] as Slot, { reason: { kind: "recurring", recurrence: { weekday: "wednesday" } } });
  const { client } = fakeClient({
    get_week: () => ({ ok: true, value: week }),
    propose_dinner: () => ({ ok: true, value: { week: recurring, changed: false } }),
  });
  const user = userEvent.setup();
  render(() => <App client={client} />);
  const wednesday = await screen.findByRole("region", { name: "Wednesday, October 28" });

  await user.click(within(wednesday).getByRole("button", { name: "Tacos" }));
  await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Edit dinner" }));
  const form = within(wednesday).getByRole("form", { name: "Dinner" });
  await user.click(within(form).getByRole("button", { name: "Let Mise choose" }));

  expect((await within(form).findByRole("status")).textContent).toBe(
    "Wednesday is a recurring Tacos night: change the rule to change it.",
  );
});

test("only pencilled dinners carry the Pencilled chip; the Household's own dinners show none, nor a reason", async () => {
  const week = proposedWeek();
  const tacos = { id: 3, title: "Tacos", baseServings: 4, photoKey: null };
  // Wednesday chosen by hand, Thursday cooked, Friday eating out: no reason, so no line.
  Object.assign(week.slots[8] as Slot, { kind: "recipe", recipe: tacos });
  Object.assign(week.slots[11] as Slot, { kind: "recipe", recipe: tacos, cookedAt: "2026-10-30T02:00:00.000Z" });
  Object.assign(week.slots[14] as Slot, { kind: "eat_out" });
  const { client } = fakeClient({ get_week: () => ({ ok: true, value: week }) });
  render(() => <App client={client} />);

  const monday = await screen.findByRole("region", { name: "Monday, October 26" });
  const pencilled = within(monday).getByRole("region", { name: "Dinner" });
  expect(within(pencilled).getByText("Pencilled")).toBeTruthy();
  expect(within(pencilled).getByRole("heading", { name: "Curry" }).classList).toContain("dish-title-pencilled");
  // Why is in the Recipe's sheet, so the card stays one line of meta.
  expect(within(pencilled).queryByText(/^Chosen from 12 Recipes that fit/)).toBeNull();
  for (const day of ["Wednesday, October 28", "Thursday, October 29", "Friday, October 30"]) {
    const dinner = within(screen.getByRole("region", { name: day })).getByRole("region", { name: "Dinner" });
    expect(within(dinner).queryByText("Pencilled")).toBeNull();
    expect(within(dinner).queryByText(/Chosen from|kept as it was|No Recipe fits/)).toBeNull();
  }
});

/**
 * The proposed Week with more pencilled dinners: Leftovers of Monday's on Wednesday, Curry cooked on Thursday
 * as an earlier Proposer left it, and Curry for nobody on Friday.
 */
function pencilledWeek(): Week {
  const week = proposedWeek();
  const curry = (week.slots[2] as Slot).recipe;
  const chosen = (week.slots[2] as Slot).reason;
  Object.assign(week.slots[8] as Slot, {
    kind: "leftovers",
    leftoversOf: { date: "2026-10-26", meal: "dinner", recipe: curry },
    reason: { kind: "leftovers", of: "2026-10-26" },
  });
  Object.assign(week.slots[11] as Slot, {
    kind: "recipe",
    recipe: curry,
    reason: chosen,
    cookedAt: "2026-10-30T02:00:00.000Z",
  });
  Object.assign(week.slots[14] as Slot, { kind: "recipe", recipe: curry, reason: chosen, diners: [], servings: 0 });
  return week;
}

const dinnerOn = (day: string) =>
  within(screen.getByRole("region", { name: day })).getByRole("region", { name: "Dinner" });

test("Keep sits on the card of a pencilled dinner with a Recipe or Leftovers, and keeps it", async () => {
  const { client, calls } = fakeClient({ get_week: () => ({ ok: true, value: pencilledWeek() }) });
  const user = userEvent.setup();
  render(() => <App client={client} />);
  await screen.findByRole("region", { name: "Monday, October 26" });

  expect(within(dinnerOn("Wednesday, October 28")).getByRole("button", { name: "Keep" })).toBeTruthy();
  // No Recipe fit Tuesday's, so the next Proposal fills it anyway.
  expect(within(dinnerOn("Tuesday, October 27")).queryByRole("button", { name: "Keep" })).toBeNull();
  await user.click(within(dinnerOn("Monday, October 26")).getByRole("button", { name: "Keep" }));

  await vi.waitFor(() =>
    expect(writes(calls)).toEqual([{ name: "keep_slot", input: { date: "2026-10-26", meal: "dinner" } }]),
  );
});

test("Keep is absent on a cooked dinner and on one nobody is eating", async () => {
  const { client } = fakeClient({ get_week: () => ({ ok: true, value: pencilledWeek() }) });
  render(() => <App client={client} />);
  await screen.findByRole("region", { name: "Monday, October 26" });

  for (const day of ["Thursday, October 29", "Friday, October 30"]) {
    expect(within(dinnerOn(day)).queryByRole("button", { name: "Keep" })).toBeNull();
  }
});

test("the Slot sheet offers Keep under the same rule, and keeps what was typed", async () => {
  const { client, calls } = fakeClient({ get_week: () => ({ ok: true, value: pencilledWeek() }) });
  const user = userEvent.setup();
  render(() => <App client={client} />);
  await screen.findByRole("region", { name: "Monday, October 26" });

  await user.click(within(dinnerOn("Tuesday, October 27")).getByRole("button", { name: "Choose a dinner" }));
  const tuesday = within(dinnerOn("Tuesday, October 27")).getByRole("form", { name: "Dinner" });
  expect(within(tuesday).queryByRole("button", { name: "Keep" })).toBeNull();
  await user.click(within(tuesday).getByRole("button", { name: "Cancel" }));

  // The card offers Keep beside Cook; the form offers it too.
  expect(within(dinnerOn("Monday, October 26")).getByRole("button", { name: "Keep" })).toBeTruthy();
  await user.click(within(dinnerOn("Monday, October 26")).getByRole("button", { name: "Curry" }));
  await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Edit dinner" }));
  const monday = within(dinnerOn("Monday, October 26")).getByRole("form", { name: "Dinner" });
  // One Keep while the sheet is open: the sheet's.
  expect(within(dinnerOn("Monday, October 26")).getAllByRole("button", { name: "Keep" })).toHaveLength(1);
  await user.type(within(monday).getByRole("textbox", { name: "Note" }), "Make it spicy");
  await user.click(within(monday).getByRole("button", { name: "Keep" }));

  await vi.waitFor(() =>
    expect(writes(calls)).toEqual([{ name: "keep_slot", input: { date: "2026-10-26", meal: "dinner" } }]),
  );
  expect((within(monday).getByRole("textbox", { name: "Note" }) as HTMLInputElement).value).toBe("Make it spicy");
});

test("keeping a dinner in the Slot sheet offers “Let Mise choose” there at once", async () => {
  let kept = false;
  const fake = fakeClient({
    get_week: () => {
      const week = pencilledWeek();
      if (kept) (week.slots[2] as Slot).reason = null;
      return { ok: true, value: week };
    },
    keep_slot: () => {
      kept = true;
      queueMicrotask(() => fake.notify("plan"));
      return undefined;
    },
  });
  const user = userEvent.setup();
  render(() => <App client={fake.client} />);
  await screen.findByRole("region", { name: "Monday, October 26" });

  await user.click(within(dinnerOn("Monday, October 26")).getByRole("button", { name: "Curry" }));
  await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Edit dinner" }));
  const monday = within(dinnerOn("Monday, October 26")).getByRole("form", { name: "Dinner" });
  expect(within(monday).queryByRole("button", { name: "Let Mise choose" })).toBeNull();
  await user.click(within(monday).getByRole("button", { name: "Keep" }));

  expect(await within(monday).findByRole("button", { name: "Let Mise choose" })).toBeTruthy();
  expect(within(monday).queryByRole("button", { name: "Keep" })).toBeNull();
});

test("Effort Budgets are set for this Week and for every Week in one grid, with one Save", async () => {
  const { client, calls } = fakeClient({ get_week: () => ({ ok: true, value: proposedWeek() }) });
  const user = userEvent.setup();
  render(() => <App client={client} />);
  await screen.findByRole("region", { name: "Monday, October 26" });

  // Folded, they say what they are.
  expect(screen.getByText("30 · 45 · 45 · 45 · 60 · 120 · 90 min")).toBeTruthy();
  await user.click(screen.getByRole("heading", { level: 2, name: "Effort Budgets" }));
  const form = screen.getByRole("form", { name: "Effort Budgets" });
  const thisWeek = within(form).getByRole("group", { name: "This Week" });
  // This Week's Monday differs from every Week's, and says so.
  expect(within(thisWeek).getByRole("spinbutton", { name: "Monday" }).classList).toContain("budget-overridden");
  expect((within(thisWeek).getByRole("spinbutton", { name: "Monday" }) as HTMLInputElement).value).toBe("30");
  // Back to the default on Monday, and a lighter Friday.
  await user.clear(within(thisWeek).getByRole("spinbutton", { name: "Monday" }));
  await user.type(within(thisWeek).getByRole("spinbutton", { name: "Monday" }), "45");
  await user.clear(within(thisWeek).getByRole("spinbutton", { name: "Friday" }));
  await user.type(within(thisWeek).getByRole("spinbutton", { name: "Friday" }), "20");

  const everyWeek = within(form).getByRole("group", { name: "Every Week" });
  await user.clear(within(everyWeek).getByRole("spinbutton", { name: "Saturday" }));
  await user.type(within(everyWeek).getByRole("spinbutton", { name: "Saturday" }), "150");
  await user.click(within(form).getByRole("button", { name: "Save" }));

  await vi.waitFor(() =>
    expect(writes(calls)).toEqual([
      { name: "set_effort_budgets", input: { budgets: { saturday: 150 } } },
      { name: "set_week_effort_budgets", input: { date: "2026-10-26", budgets: { monday: null, friday: 20 } } },
    ]),
  );
});

test("a budget set to the same for this Week and every Week is no override for this Week", async () => {
  const { client, calls } = fakeClient({ get_week: () => ({ ok: true, value: proposedWeek() }) });
  const user = userEvent.setup();
  render(() => <App client={client} />);
  await screen.findByRole("region", { name: "Monday, October 26" });

  await user.click(screen.getByRole("heading", { level: 2, name: "Effort Budgets" }));
  const form = screen.getByRole("form", { name: "Effort Budgets" });
  for (const row of ["This Week", "Every Week"]) {
    const monday = within(within(form).getByRole("group", { name: row })).getByRole("spinbutton", { name: "Monday" });
    await user.clear(monday);
    await user.type(monday, "60");
  }
  await user.click(within(form).getByRole("button", { name: "Save" }));

  await vi.waitFor(() =>
    expect(writes(calls)).toEqual([
      { name: "set_effort_budgets", input: { budgets: { monday: 60 } } },
      { name: "set_week_effort_budgets", input: { date: "2026-10-26", budgets: { monday: null } } },
    ]),
  );
});

test("Effort Budgets run in the Week's own order of days, as its cards do", async () => {
  const { client } = fakeClient({ get_week: () => ({ ok: true, value: emptyWeek("2026-10-25") }) });
  const user = userEvent.setup();
  render(() => <App client={client} />);
  await screen.findByRole("region", { name: "Sunday, October 25" });

  await user.click(screen.getByRole("heading", { level: 2, name: "Effort Budgets" }));
  const thisWeek = within(screen.getByRole("form", { name: "Effort Budgets" })).getByRole("group", {
    name: "This Week",
  });
  expect(
    within(thisWeek)
      .getAllByRole("spinbutton")
      .map((cell) => cell.getAttribute("aria-label")),
  ).toEqual(["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]);
  expect(document.querySelector(".budget-days")?.textContent).toBe("SMTWTFS");
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

/** A button's name: its label where its text is shortened or an icon, as at a dinner card's end. */
const buttonName = (button: HTMLElement) => button.getAttribute("aria-label") ?? button.textContent;

/** What a dinner card offers besides opening its Recipe from its title, by name. */
const dinnerActions = (day: string) => {
  const dinner = within(screen.getByRole("region", { name: day })).getByRole("region", { name: "Dinner" });
  return within(dinner)
    .queryAllByRole("button")
    .map(buttonName)
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
  // The one exception to one primary a screen: beside the Week's own, each dinner card's Cook is its card's.
  expect(primaries()).toEqual(["Propose dinners", "Cook"]);
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
    expect(actions.map(buttonName)).toEqual([expect.stringMatching(/^\[Çĥàñĝé đîññéŕ ·+\]$/)]);
    // Shortened to fit the card's end, it still says Change.
    expect(actions.map((button) => button.textContent)).toEqual([expect.stringMatching(/^\[Çĥàñĝé ·+\]$/)]);
  }
});

test("Clear shows when a Week's only changes are on unplanned Slots, or Leftovers linked to one", async () => {
  for (const change of [
    { note: "Picnic" },
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

  expect(within(monday).getByText("Mon 26")).toBeTruthy();
  expect(within(monday).getByRole("heading", { name: "Nothing planned" })).toBeTruthy();
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

test("a cooked dinner's rating sits at its Recipe sheet's foot, with its note and Rate once a choice is picked", async () => {
  const cooked = emptyWeek("2026-10-26");
  Object.assign(cooked.slots[5] as Slot, {
    kind: "recipe",
    recipe: { id: 1, title: "Pasta", baseServings: 4, photoKey: null },
    cookedAt: "2026-10-27T02:00:00.000Z",
  });
  const { client } = fakeClient({ get_week: () => ({ ok: true, value: cooked }) });
  const user = userEvent.setup();
  render(() => <App client={client} />);
  const tuesday = await screen.findByRole("region", { name: "Tuesday, October 27" });
  await user.click(within(tuesday).getByRole("button", { name: "Pasta" }));
  const sheet = await screen.findByRole("dialog", { name: "Pasta" });
  await within(sheet).findByRole("button", { name: "Cook" });
  const foot = sheet.querySelector(".sheet-foot") as HTMLElement;

  const form = within(foot).getByRole("form", { name: "How was it?" });
  expect(within(form).getAllByRole("radio")).toHaveLength(3);
  expect(within(form).queryByRole("textbox")).toBeNull();
  expect(
    within(foot)
      .getAllByRole("button")
      .map((button) => button.textContent),
  ).toEqual(["Not cooked after all", "Edit dinner", "Cook"]);

  await user.click(within(form).getByRole("radio", { name: "Meh" }));
  expect(within(form).getByRole("textbox", { name: "Note (optional)" })).toBeTruthy();
  expect(
    within(foot)
      .getAllByRole("button")
      .map((button) => button.textContent),
  ).toEqual(["Rate", "Not cooked after all", "Edit dinner", "Cook"]);
});

test("a rating being written at the Recipe sheet's foot survives the Week being fetched again", async () => {
  const cooked = emptyWeek("2026-10-26");
  Object.assign(cooked.slots[5] as Slot, {
    kind: "recipe",
    recipe: { id: 1, title: "Pasta", baseServings: 4, photoKey: null },
    cookedAt: "2026-10-27T02:00:00.000Z",
  });
  const fake = fakeClient({ get_week: () => ({ ok: true, value: structuredClone(cooked) }) });
  const user = userEvent.setup();
  render(() => <App client={fake.client} />);
  const tuesday = await screen.findByRole("region", { name: "Tuesday, October 27" });
  await user.click(within(tuesday).getByRole("button", { name: "Pasta" }));
  const sheet = await screen.findByRole("dialog", { name: "Pasta" });
  const form = await within(sheet).findByRole("form", { name: "How was it?" });
  await user.click(within(form).getByRole("radio", { name: "Meh" }));
  await user.type(within(form).getByRole("textbox", { name: "Note (optional)" }), "A bit dry");

  const fetched = fake.calls.filter((call) => call.name === "get_week").length;
  fake.notify("plan");
  await vi.waitFor(() => expect(fake.calls.filter((call) => call.name === "get_week").length).toBeGreaterThan(fetched));
  await new Promise((resolve) => setTimeout(resolve));

  const after = within(screen.getByRole("dialog", { name: "Pasta" })).getByRole("form", { name: "How was it?" });
  expect((within(after).getByRole("radio", { name: "Meh" }) as HTMLInputElement).checked).toBe(true);
  expect((within(after).getByRole("textbox", { name: "Note (optional)" }) as HTMLInputElement).value).toBe("A bit dry");
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

test("offline, a cooked dinner's Staples stay shown, but marking one low or out says it needs a connection", async () => {
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
  const { client, calls, goOffline } = fakeClient({
    get_week: () => ({ ok: true, value: cooked }),
    list_staples: (input) => ({ ok: true, value: input.usedBy === 1 ? [oil] : [] }),
  });
  const user = userEvent.setup();
  render(() => <App client={client} />);
  const tuesday = await screen.findByRole("region", { name: "Tuesday, October 27" });
  await user.click(within(tuesday).getByRole("button", { name: "Pasta" }));
  const sheet = await screen.findByRole("dialog", { name: "Pasta" });
  const runOut = await within(sheet).findByRole("group", { name: "Anything run out?" });

  goOffline();

  for (const name of ["Olive oil: Low", "Olive oil: Out"]) {
    const mark = within(runOut).getByRole("button", { name }) as HTMLButtonElement;
    expect(mark.disabled, name).toBe(true);
    expect(document.getElementById(String(mark.getAttribute("aria-describedby")))?.textContent, name).toBe(
      "Needs a connection.",
    );
  }
  expect(within(sheet).queryByRole("alert")).toBeNull();
  expect(writes(calls)).toEqual([]);
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
  ).toEqual(["No breakfast or lunch"]);
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

test("offline, a Recipe planned this Week opens from this device though it was never opened", async () => {
  const user = userEvent.setup();
  const online = fakeClient();
  render(() => <App client={online.client} />);
  await screen.findByRole("region", { name: "Tuesday, October 27" });
  await vi.waitFor(() => expect(online.calls.some((call) => call.name === "get_recipe")).toBe(true));
  // Let the answer arrive before the app closes.
  await new Promise((resolve) => setTimeout(resolve));
  cleanup();

  const offline = fakeClient();
  offline.goOffline();
  render(() => <App client={offline.client} />);
  const tuesday = await screen.findByRole("region", { name: "Tuesday, October 27" });
  await user.click(within(tuesday).getByRole("button", { name: "Pasta" }));
  const sheet = await screen.findByRole("dialog", { name: "Pasta" });
  expect(within(sheet).getByRole("list", { name: "Ingredients" })).toBeTruthy();
  expect(within(sheet).queryByText("Loading…")).toBeNull();
  await user.click(within(sheet).getByRole("button", { name: "Close the Recipe" }));

  await user.click(within(tuesday).getByRole("button", { name: "Cook" }));
  const kitchen = await screen.findByRole("region", { name: "Kitchen mode" });
  expect(within(kitchen).getByText("Boil the spaghetti.")).toBeTruthy();
  await user.click(within(kitchen).getByRole("button", { name: "Leave kitchen mode" }));
  cleanup();

  window.history.replaceState(null, "", "/?recipe=1");
  onTestFinished(() => window.history.replaceState(null, "", "/"));
  render(() => <App client={offline.client} />);
  expect(await screen.findByRole("heading", { name: "Pasta" })).toBeTruthy();
  expect(screen.getByText("Boil the spaghetti.")).toBeTruthy();
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

/** Next Week with Curry for Tuesday's dinner. */
function nextWeekWithCurry(): Week {
  const week = emptyWeek("2026-11-02");
  Object.assign(week.slots[5] as Slot, {
    kind: "recipe",
    recipe: { id: 2, title: "Curry", baseServings: 4, photoKey: null },
    servings: 3,
    cookFor: 3,
  });
  return week;
}

const curryRecipe: Recipe = { ...pastaRecipe, ...curry, steps: ["Simmer the curry."] };

/** Answers next Week as having Curry on Tuesday. */
const withCurryNextWeek: Record<string, Answer> = {
  get_week: (input) => (input.date === "2026-11-02" ? { ok: true, value: nextWeekWithCurry() } : undefined),
  get_recipe: (input) => (input.id === 2 ? { ok: true, value: curryRecipe } : undefined),
};

/**
 * Opens the app online on Monday, October 26, until both Weeks and every planned Recipe are kept,
 * then closes it.
 */
async function loadOnce(answers: Record<string, Answer> = {}) {
  vi.setSystemTime(new Date("2026-10-26T12:00:00-07:00"));
  const online = fakeClient(answers);
  render(() => <App client={online.client} />);
  await screen.findByRole("region", { name: "Tuesday, October 27" });
  await vi.waitFor(() => expect(online.calls.filter((call) => call.name === "get_recipe").length).toBeGreaterThan(0));
  // Let the answers arrive before the app closes.
  await new Promise((resolve) => setTimeout(resolve));
  cleanup();
}

test("offline, next Week opens read-only as last loaded, and its Recipes open from this device", async () => {
  const user = userEvent.setup();
  await loadOnce(withCurryNextWeek);

  const offline = fakeClient();
  offline.goOffline();
  render(() => <App client={offline.client} />);
  await screen.findByRole("region", { name: "Tuesday, October 27" });
  await user.click(screen.getByRole("button", { name: "Next Week" }));

  const tuesday = await screen.findByRole("region", { name: "Tuesday, November 3" });
  expect(within(tuesday).getByRole("heading", { name: "Curry" })).toBeTruthy();
  expect((screen.getByRole("button", { name: "Propose dinners" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole("alert")).toBeNull();
  const monday = screen.getByRole("region", { name: "Monday, November 2" });
  expect(within(monday).queryByRole("button", { name: "Choose a dinner" })).toBeNull();

  await user.click(within(tuesday).getByRole("button", { name: "Curry" }));
  const sheet = await screen.findByRole("dialog", { name: "Curry" });
  expect(within(sheet).getByRole("list", { name: "Ingredients" })).toBeTruthy();
  expect(within(sheet).queryByText("Loading…")).toBeNull();
  expect(within(sheet).queryByRole("button", { name: "Edit dinner" })).toBeNull();
  await user.click(within(sheet).getByRole("button", { name: "Close the Recipe" }));

  await user.click(within(tuesday).getByRole("button", { name: "Cook" }));
  const kitchen = await screen.findByRole("region", { name: "Kitchen mode" });
  expect(within(kitchen).getByText("Simmer the curry.")).toBeTruthy();
});

test("offline, with no next Week kept, next Week says it needs a connection", async () => {
  const user = userEvent.setup();
  const online = fakeClient({
    get_week: (input) =>
      input.date === "2026-11-02" ? { ok: false, error: { code: "not_found", message: "No" } } : undefined,
  });
  render(() => <App client={online.client} />);
  await screen.findByRole("region", { name: "Tuesday, October 27" });
  cleanup();

  const offline = fakeClient();
  offline.goOffline();
  render(() => <App client={offline.client} />);
  await screen.findByRole("region", { name: "Tuesday, October 27" });
  await user.click(screen.getByRole("button", { name: "Next Week" }));

  const next = await screen.findByRole("region", { name: "The Week" });
  expect(within(next).getByText("Needs a connection.")).toBeTruthy();
  expect(within(next).queryByText("Loading the Week…")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});

test("offline into a new Week, the Week kept as next shows as this one, and the one ended isn't shown", async () => {
  const user = userEvent.setup();
  await loadOnce(withCurryNextWeek);
  vi.setSystemTime(new Date("2026-11-03T12:00:00-08:00"));

  const offline = fakeClient();
  offline.goOffline();
  render(() => <App client={offline.client} />);

  const tuesday = await screen.findByRole("region", { name: "Tuesday, November 3" });
  expect(within(tuesday).getByRole("heading", { name: "Curry" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "This Week" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.queryByRole("region", { name: "Tuesday, October 27" })).toBeNull();

  await user.click(screen.getByRole("button", { name: "Next Week" }));
  expect(within(await screen.findByRole("region", { name: "The Week" })).getByText("Needs a connection.")).toBeTruthy();
});

test("online, next Week waits for this Week to answer, even with one kept", async () => {
  await loadOnce(withCurryNextWeek);

  let answer: (result: ToolResult<unknown>) => void = () => {};
  const { client } = fakeClient({
    get_week: (input) => (input.date ? undefined : new Promise((resolve) => (answer = resolve))),
  });
  render(() => <App client={client} />);
  await screen.findByRole("region", { name: "Tuesday, October 27" });
  expect((screen.getByRole("button", { name: "Next Week" }) as HTMLButtonElement).disabled).toBe(true);

  answer({ ok: true, value: emptyWeek("2026-10-26") });
  await vi.waitFor(() =>
    expect((screen.getByRole("button", { name: "Next Week" }) as HTMLButtonElement).disabled).toBe(false),
  );
});

test("back online on next Week as kept, it stays shown until it has loaded again", async () => {
  const user = userEvent.setup();
  await loadOnce(withCurryNextWeek);

  let answer: (result: ToolResult<unknown>) => void = () => {};
  const fake = fakeClient({
    get_week: (input) => (input.date === "2026-11-02" ? new Promise((resolve) => (answer = resolve)) : undefined),
  });
  fake.goOffline();
  render(() => <App client={fake.client} />);
  await screen.findByRole("region", { name: "Tuesday, October 27" });
  await user.click(screen.getByRole("button", { name: "Next Week" }));
  await screen.findByRole("region", { name: "Tuesday, November 3" });

  fake.goOnline();
  await vi.waitFor(() => expect(fake.calls.some((call) => call.input.date === "2026-11-02")).toBe(true));
  expect(screen.getByRole("region", { name: "Tuesday, November 3" })).toBeTruthy();

  answer({ ok: true, value: emptyWeek("2026-11-02") });
  await vi.waitFor(() =>
    expect(
      within(screen.getByRole("region", { name: "Tuesday, November 3" })).queryByRole("heading", { name: "Curry" }),
    ).toBeNull(),
  );
});

test("the Week's dates are its title, with no overline and no day rail, and the Pencilled chip marks the dinners a Re-roll may change", async () => {
  const week = pencilledWeek();
  // Nobody is eating Saturday's, so Mise planned nothing a Re-roll would change.
  Object.assign(week.slots[17] as Slot, { diners: [], servings: 0, reason: { kind: "nobody_eating" } });
  const { client } = fakeClient({ get_week: () => ({ ok: true, value: week }) });
  render(() => <App client={client} />);
  await screen.findByRole("region", { name: "Monday, October 26" });

  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Oct 26 to Nov 1");
  expect(screen.queryByText(/Mise · This week/i)).toBeNull();
  const header = document.querySelector(".week-screen .page-header") as HTMLElement;
  expect(within(header).queryByRole("navigation")).toBeNull();
  const marked = screen
    .getAllByRole("region")
    .filter((region) => region.classList.contains("day"))
    .filter((day) => within(day).queryByText("Pencilled"))
    .map((day) => day.getAttribute("aria-label"));
  // Every dinner a Re-roll could change; Sunday's is the Household's own.
  expect(marked).toEqual(["Monday, October 26", "Tuesday, October 27", "Wednesday, October 28", "Friday, October 30"]);
  // Pencilled, but cooked on Thursday and left unplanned on Saturday: the chip would promise a Re-roll changes them.
  for (const day of ["Thursday, October 29", "Saturday, October 31"]) {
    expect(within(dinnerOn(day)).queryByText("Pencilled")).toBeNull();
    expect(within(dinnerOn(day)).getByRole("heading").classList).not.toContain("dish-title-pencilled");
  }
});

/** The days the Week scrolled into view, in order, by name; jsdom has no scrolling of its own. */
function watchScrolling() {
  const scrolled: (string | null)[] = [];
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this.getAttribute("aria-label"));
  };
  onTestFinished(() => {
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });
  return scrolled;
}

test("This Week opens at Tonight, again on coming back from Next Week, but not when it refreshes", async () => {
  vi.setSystemTime(new Date("2026-10-28T12:00:00-07:00"));
  const scrolled = watchScrolling();
  // Once the plan has changed, Wednesday's dinner is Curry.
  let changed = false;
  const fake = fakeClient({
    get_week: (input) => {
      if (input.date || !changed) return undefined;
      const week = emptyWeek("2026-10-26");
      Object.assign(week.slots[8] as Slot, { kind: "recipe", recipe: { ...curry, baseServings: 4 } });
      return { ok: true, value: week };
    },
  });
  const user = userEvent.setup();
  render(() => <App client={fake.client} />);
  await screen.findByRole("region", { name: "Wednesday, October 28" });
  await vi.waitFor(() => expect(scrolled).toEqual(["Wednesday, October 28"]));

  // A change to the plan fetches the Week again; where the Household has scrolled to stays.
  changed = true;
  fake.notify("plan");
  await within(dinnerOn("Wednesday, October 28")).findByRole("heading", { name: "Curry" });
  expect(scrolled).toEqual(["Wednesday, October 28"]);

  await user.click(screen.getByRole("button", { name: "Next Week" }));
  await screen.findByRole("region", { name: "Tuesday, November 3" });
  await user.click(screen.getByRole("button", { name: "This Week" }));
  await screen.findByRole("region", { name: "Wednesday, October 28" });
  await vi.waitFor(() => expect(scrolled).toEqual(["Wednesday, October 28", "Wednesday, October 28"]));
});

test("This Week opens at its top while nothing is planned, and on its first day", async () => {
  vi.setSystemTime(new Date("2026-10-28T12:00:00-07:00"));
  const scrolled = watchScrolling();
  const { client } = fakeClient({ get_week: () => ({ ok: true, value: emptyWeek("2026-10-26") }) });
  render(() => <App client={client} />);
  await screen.findByRole("button", { name: "Propose dinners" });
  expect(scrolled).toEqual([]);
  cleanup();

  // Monday's dinner is first under the header, so the title, the switch and Re-roll stay in view.
  vi.setSystemTime(new Date("2026-10-26T12:00:00-07:00"));
  render(() => <App client={fakeClient().client} />);
  await screen.findByRole("region", { name: "Tuesday, October 27" });
  expect(screen.getByRole("region", { name: "Monday, October 26" }).getAttribute("aria-current")).toBe("date");
  expect(scrolled).toEqual([]);
});

test("This Week kept on this device opens at Tonight offline, and online waits for the household's", async () => {
  await loadOnce();
  vi.setSystemTime(new Date("2026-10-28T12:00:00-07:00"));
  const scrolled = watchScrolling();

  const offline = fakeClient();
  offline.goOffline();
  render(() => <App client={offline.client} />);
  await screen.findByRole("region", { name: "Wednesday, October 28" });
  await vi.waitFor(() => expect(scrolled).toEqual(["Wednesday, October 28"]));
  cleanup();
  scrolled.length = 0;

  // The kept Week may be out of date: nothing planned on it any more, or a notification opening Next Week.
  let answer: (result: ToolResult<unknown>) => void = () => {};
  const { client } = fakeClient({
    get_week: (input) => (input.date ? undefined : new Promise((resolve) => (answer = resolve))),
  });
  render(() => <App client={client} />);
  await screen.findByRole("region", { name: "Wednesday, October 28" });
  expect(scrolled).toEqual([]);
  answer({ ok: true, value: emptyWeek("2026-10-26") });
  await screen.findByRole("button", { name: "Propose dinners" });
  expect(scrolled).toEqual([]);
});

test("today's day is marked as the date it is, and a Week without today marks none", async () => {
  vi.setSystemTime(new Date("2026-10-28T12:00:00-07:00"));
  const { client } = fakeClient(withCurryNextWeek);
  const user = userEvent.setup();
  render(() => <App client={client} />);
  await screen.findByRole("region", { name: "Wednesday, October 28" });
  const marked = () =>
    screen
      .getAllByRole("region")
      .filter((region) => region.getAttribute("aria-current") === "date")
      .map((region) => region.getAttribute("aria-label"));

  expect(marked()).toEqual(["Wednesday, October 28"]);

  await user.click(screen.getByRole("button", { name: "Next Week" }));
  await screen.findByRole("region", { name: "Tuesday, November 3" });
  expect(marked()).toEqual([]);
});

test("the Slot form is a sheet: Guests step either side, their Constraints show once there are Guests, and Escape closes it", async () => {
  const { client, calls } = fakeClient({ get_week: () => ({ ok: true, value: emptyWeek("2026-10-26") }) });
  const user = userEvent.setup();
  render(() => <App client={client} />);
  const monday = await screen.findByRole("region", { name: "Monday, October 26" });

  await user.click(within(monday).getByRole("button", { name: "Choose a dinner" }));
  const sheet = screen.getByRole("dialog", { name: "Edit dinner" });
  const form = within(sheet).getByRole("form", { name: "Dinner" });
  // It opens on its first field, What, and only its foot says Cancel.
  await vi.waitFor(() => expect(document.activeElement).toBe(within(form).getByRole("combobox", { name: "What" })));
  expect(within(sheet).getAllByRole("button", { name: "Cancel" })).toHaveLength(1);
  expect(within(sheet).getByRole("button", { name: "Close" })).toBeTruthy();
  expect(within(form).queryByRole("group", { name: "Guests' Constraints" })).toBeNull();
  expect((within(form).getByRole("button", { name: "One Guest fewer" }) as HTMLButtonElement).disabled).toBe(true);
  await user.click(within(form).getByRole("button", { name: "One Guest more" }));
  await user.click(within(form).getByRole("button", { name: "One Guest more" }));
  await user.click(within(form).getByRole("button", { name: "One Guest fewer" }));
  expect((within(form).getByRole("spinbutton", { name: "Guests" }) as HTMLInputElement).value).toBe("1");
  expect(within(form).getByRole("group", { name: "Guests' Constraints" })).toBeTruthy();

  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(writes(calls)).toEqual([]);
});

test("unticking someone from Everyone starts from everyone else", async () => {
  const { client, calls } = fakeClient();
  const user = userEvent.setup();
  render(() => <App client={client} />);
  const monday = await screen.findByRole("region", { name: "Monday, October 26" });

  await user.click(within(monday).getByRole("button", { name: "Choose a dinner" }));
  const form = within(monday).getByRole("form", { name: "Dinner" });
  expect((within(form).getByRole("checkbox", { name: "Alex" }) as HTMLInputElement).checked).toBe(true);
  await user.click(within(form).getByRole("checkbox", { name: "Alex" }));
  expect((within(form).getByRole("checkbox", { name: "Everyone" }) as HTMLInputElement).checked).toBe(false);
  await user.click(within(form).getByRole("button", { name: "Save" }));

  await vi.waitFor(() =>
    expect(writes(calls)).toEqual([
      {
        name: "set_slot",
        input: { date: "2026-10-26", meal: "dinner", kind: "unplanned", note: null, diners: [1, 3] },
      },
    ]),
  );
});

test("breakfast and lunch unfold to a line each: the meal, what's planned and its one action", async () => {
  const { client } = fakeClient();
  const user = userEvent.setup();
  render(() => <App client={client} />);
  const tuesday = await screen.findByRole("region", { name: "Tuesday, October 27" });

  await user.click(within(tuesday).getByRole("button", { name: "No breakfast or lunch" }));
  const breakfast = within(tuesday).getByRole("region", { name: "Breakfast" });
  expect(breakfast.textContent).toBe("BreakfastNothing plannedChoose a breakfast");
  // A line, with no thumb.
  expect(breakfast.querySelector(".thumb")).toBeNull();
});

test("a cooked breakfast says so on its line, offline too, where it can't be rated", async () => {
  const week = emptyWeek("2026-10-26");
  Object.assign(week.slots[3] as Slot, {
    kind: "recipe",
    recipe: { id: 1, title: "Pasta", baseServings: 4, photoKey: null },
    cookedAt: "2026-10-27T15:00:00.000Z",
  });
  const { client, goOffline } = fakeClient({ get_week: () => ({ ok: true, value: week }) });
  const user = userEvent.setup();
  render(() => <App client={client} />);
  const tuesday = await screen.findByRole("region", { name: "Tuesday, October 27" });

  await user.click(within(tuesday).getByRole("button", { name: /^Breakfast: Pasta/ }));
  const breakfast = within(tuesday).getByRole("region", { name: "Breakfast" });
  expect(within(breakfast).getByText("Cooked")).toBeTruthy();
  expect(within(breakfast).getByRole("button", { name: "Rate it" })).toBeTruthy();

  goOffline();
  await vi.waitFor(() => expect(within(breakfast).queryByRole("button", { name: "Rate it" })).toBeNull());
  expect(within(breakfast).getByText("Cooked")).toBeTruthy();
});
