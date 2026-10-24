import {
  addDays,
  DEFAULT_EFFORT_BUDGETS,
  type Household,
  ITEMS,
  MEALS,
  type Member,
  type RecipeSummary,
  type Slot,
  STORE_SECTIONS,
  type Staple,
  type ToolResult,
  type Week,
} from "@mise/domain";
import { cleanup, render, screen, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { App } from "../src/App";
import type { MiseClient } from "../src/client";
import { createFakeClient } from "./fakeClient";

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
  allergens: { kind: "known", allergens: ["wheat"] },
  photoKey: "photos/pasta",
};
const curry: RecipeSummary = { ...pasta, id: 2, title: "Curry", photoKey: null };

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
    reason: { kind: "no_candidate", excluded: { conflict: 3, never: 0, recent: 2, effort: 1 } },
  });
  return {
    ...week,
    proposalSeed: 7,
    reviewed: false,
    effortBudgetOverrides: { monday: 30 },
    effortBudgets: { ...DEFAULT_EFFORT_BUDGETS, monday: 30 },
  };
}

type Answer = (input: Record<string, unknown>) => ToolResult<unknown> | undefined;

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
  const { client, notify } = createFakeClient(async (name: string, input: Record<string, unknown>) => {
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
  return { client, calls, notify };
}

const writes = (calls: { name: string; input: unknown }[]) =>
  calls.filter(
    (call) =>
      ![
        "get_household",
        "get_week",
        "get_grocery_list",
        "search_recipes",
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

  const otherMeals = within(tuesday).getByText("Breakfast and lunch").closest("details");
  expect(otherMeals?.open).toBe(false);
  expect(within(screen.getByRole("region", { name: "Monday, October 26" })).getByText("Nothing planned")).toBeTruthy();
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

test("editing a dinner sends what changed in one change to the Slot, then the Lock", async () => {
  const { client, calls } = fakeClient();
  const user = userEvent.setup();
  render(() => <App client={client} />);
  const tuesday = await screen.findByRole("region", { name: "Tuesday, October 27" });

  await user.click(within(tuesday).getByRole("button", { name: "Edit Dinner" }));
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

test("Guests and their Constraints are set on the Slot", async () => {
  const { client, calls } = fakeClient();
  const user = userEvent.setup();
  render(() => <App client={client} />);
  const monday = await screen.findByRole("region", { name: "Monday, October 26" });

  await user.click(within(monday).getByRole("button", { name: "Edit Dinner" }));
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

  await user.click(within(wednesday).getByRole("button", { name: "Who's eating today" }));
  const form = within(wednesday).getByRole("form", { name: "Who's eating today" });
  await user.click(within(form).getByRole("checkbox", { name: "Everyone" }));
  await user.click(within(form).getByRole("checkbox", { name: "Robin" }));
  await user.click(within(form).getByRole("button", { name: "Save" }));

  await vi.waitFor(() =>
    expect(writes(calls)).toEqual([{ name: "set_diners", input: { date: "2026-10-28", diners: [2, 3] } }]),
  );
});

test("clearing the Week asks first", async () => {
  const { client, calls } = fakeClient();
  const user = userEvent.setup();
  const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
  render(() => <App client={client} />);
  await screen.findByRole("region", { name: "Monday, October 26" });

  await user.click(screen.getByRole("button", { name: "Clear this Week" }));
  await user.click(screen.getByRole("button", { name: "Clear this Week" }));

  expect(confirm).toHaveBeenCalledTimes(2);
  await vi.waitFor(() =>
    expect(writes(calls)).toEqual([{ name: "clear_week", input: { date: "2026-10-26", confirm: true } }]),
  );
  confirm.mockRestore();
});

const robinsPeanut = { who: 1, allergen: "peanut", constraint: "allergy", cause: "contains" } as const;

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

  await user.click(within(monday).getByRole("button", { name: "Edit Dinner" }));
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

  await user.click(within(tuesday).getByRole("button", { name: "Who's eating today" }));
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

  await user.click(within(monday).getByRole("button", { name: "Edit Dinner" }));
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

  await vi.waitFor(() => expect(writes(calls)).toEqual([{ name: "propose_week", input: { date: "2026-10-26" } }]));
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
  expect(within(monday).getByText("Cook for 6, with Tuesday's Leftovers.")).toBeTruthy();
  const tuesday = screen.getByRole("region", { name: "Tuesday, October 27" });
  const dinner = within(tuesday).getByRole("region", { name: "Dinner" });
  expect(within(dinner).getByRole("heading", { name: "Leftovers of Curry" })).toBeTruthy();
  expect(within(dinner).getByText("Leftovers of Monday's dinner, cooked for both.")).toBeTruthy();
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
      "No Recipe fits: 3 conflict with someone eating, 2 planned within 2 weeks, 1 over the Effort Budget.",
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

  await user.click(screen.getByText("Effort Budgets"));
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

test("a dinner with a Recipe can be marked cooked; one without has nothing to cook", async () => {
  const { client, calls } = fakeClient();
  const user = userEvent.setup();
  render(() => <App client={client} />);
  const tuesday = await screen.findByRole("region", { name: "Tuesday, October 27" });
  const monday = screen.getByRole("region", { name: "Monday, October 26" });

  expect(within(monday).queryByRole("button", { name: "Mark cooked" })).toBeNull();
  const dinner = within(tuesday).getByRole("region", { name: "Dinner" });
  await user.click(within(dinner).getByRole("button", { name: "Mark cooked" }));

  expect(writes(calls)).toEqual([{ name: "mark_cooked", input: { date: "2026-10-27", meal: "dinner" } }]);
});

test("a cooked dinner shows its Ratings, asks for one, and can be unmarked", async () => {
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
  const dinner = within(tuesday).getByRole("region", { name: "Dinner" });

  expect(within(dinner).getByText("Cooked")).toBeTruthy();
  expect(within(dinner).getByText("Robin: Meh. Too salty")).toBeTruthy();
  expect(within(dinner).getByText("Someone: Again")).toBeTruthy();
  expect(within(dinner).queryByRole("button", { name: "Mark cooked" })).toBeNull();

  const form = within(dinner).getByRole("form", { name: "How was it?" });
  await user.click(within(form).getByRole("radio", { name: "Never again" }));
  await user.type(within(form).getByRole("textbox", { name: "Note (optional)" }), "Nobody ate it");
  await user.click(within(form).getByRole("button", { name: "Rate" }));
  await user.click(within(dinner).getByRole("button", { name: "Not cooked after all" }));

  expect(writes(calls)).toEqual([
    {
      name: "rate_recipe",
      input: { date: "2026-10-27", meal: "dinner", rating: "never", note: "Nobody ate it" },
    },
    { name: "mark_cooked", input: { date: "2026-10-27", meal: "dinner", cooked: false } },
  ]);
});

test("a cooked dinner asks whether any Staple its Recipe uses has run out", async () => {
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
  const dinner = within(tuesday).getByRole("region", { name: "Dinner" });

  const runOut = await within(dinner).findByRole("group", { name: "Anything run out?" });
  await user.click(within(runOut).getByRole("button", { name: "olive oil: Out" }));

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
  const dinner = within(tuesday).getByRole("region", { name: "Dinner" });

  await user.click(within(dinner).getByRole("button", { name: "Mark cooked" }));

  const runOut = await within(dinner).findByRole("group", { name: "Anything run out?" });
  expect(within(runOut).getByRole("button", { name: "salt: Out" })).toBeTruthy();
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
  expect(within(tuesday).queryByRole("button", { name: "Edit Dinner" })).toBeNull();
  expect(within(tuesday).queryByRole("button", { name: "Mark cooked" })).toBeNull();
  expect((screen.getByRole("button", { name: "Propose dinners" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole("alert")).toBeNull();
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
