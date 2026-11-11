import {
  DEFAULT_EFFORT_BUDGETS,
  type Household,
  ITEMS,
  type Member,
  type Recipe,
  type RecipeSummary,
  type Slot,
  STORE_SECTIONS,
  type ToolResult,
} from "@mise/domain";
import { render, screen, waitFor, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { App } from "../src/App";
import { createFakeClient } from "./fakeClient";
import { primaries } from "./primaries";
import { emptyWeek, weekStore } from "./weeks";

// Today is Wednesday 11 November: This Week runs Monday 9 to Sunday 15, Next Week 16 to 22.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-11T20:00:00Z"));
});
afterEach(() => vi.useRealTimers());

const robin: Member = { id: 1, name: "Robin", email: null, constraints: [] };
const alex: Member = { id: 2, name: "Alex", email: null, constraints: [] };

const household: Household = {
  name: "The Tremblays",
  timezone: "America/Vancouver",
  dinnerTime: "18:00",
  weekStartsOn: "monday",
  weekStartChanges: [],
  units: "metric",
  locale: "en-CA",
  voiceMinutesPerDay: 30,
  members: [robin, alex],
  effortBudgets: DEFAULT_EFFORT_BUDGETS,
  storeSections: [...STORE_SECTIONS],
};

const noodles: Recipe = {
  id: 7,
  title: "Sesame noodles",
  baseServings: 4,
  ingredients: [
    { raw: "250 g noodles", amount: { min: 250, max: 250 }, unit: "g", name: "noodles", note: null, item: null },
  ],
  steps: ["Boil the noodles."],
  tags: [],
  effortMinutes: 25,
  cuisine: null,
  mainProtein: null,
  course: "main",
  readyMade: false,
  recurring: null,
  yieldsLeftovers: false,
  prepAhead: null,
  notes: null,
  photoKey: null,
  allergens: { kind: "known", allergens: ["sesame"] },
  source: { kind: "manual" },
  importedPreference: null,
  createdAt: "2026-10-21T12:00:00.000Z",
  updatedAt: "2026-10-21T12:00:00.000Z",
  editedInAppAt: null,
  draft: false,
  lastCookedAt: null,
  cookCount: 0,
};

const summaryOf = (recipe: Recipe): RecipeSummary => ({
  id: recipe.id,
  title: recipe.title,
  tags: recipe.tags,
  effortMinutes: recipe.effortMinutes,
  cuisine: recipe.cuisine,
  mainProtein: recipe.mainProtein,
  course: recipe.course,
  readyMade: recipe.readyMade,
  allergens: recipe.allergens,
  photoKey: recipe.photoKey,
});

const dish = (id: number, title: string) => ({ id, title, baseServings: 4, photoKey: null, readyMade: false });
const pencil: Slot["reason"] = { kind: "chosen", candidates: 12, factors: [] };

/**
 * This Week as proposed: Wednesday's dinner is the Household's own Lemon chicken, Thursday's a pencilled
 * Chickpea curry for two and two Guests, Friday's nothing planned, Saturday's eating out and Sunday's a
 * pencilled Shakshuka. Next Week isn't proposed yet; its Wednesday dinner is the Household's own Fish tacos.
 */
function weeks() {
  const weeks = weekStore({ ...emptyWeek("2026-11-09", [1, 2]), proposalSeed: 3 }, emptyWeek("2026-11-16", [1, 2]));
  const { set } = weeks;
  set("2026-11-11", "dinner", { kind: "recipe", recipe: dish(1, "Lemon chicken") });
  set("2026-11-12", "dinner", {
    kind: "recipe",
    recipe: dish(2, "Chickpea curry"),
    reason: pencil,
    guests: 2,
    servings: 4,
  });
  set("2026-11-14", "dinner", { kind: "eat_out" });
  set("2026-11-15", "dinner", { kind: "recipe", recipe: dish(3, "Shakshuka"), reason: pencil });
  set("2026-11-18", "dinner", { kind: "recipe", recipe: dish(4, "Fish tacos") });
  return weeks;
}

type Answer = (input: Record<string, unknown>) => ToolResult<unknown> | undefined;

/**
 * A client over `recipe` and the two Weeks, recording every tool call made. `set_slot` plans a Recipe as
 * the household does: the Slot becomes the Household's own, and the plan's change notice follows.
 */
function fakeClient(recipe: Recipe = noodles, answers: Record<string, Answer> = {}) {
  const store = weeks();
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const fake = createFakeClient(async (name: string, input: Record<string, unknown>) => {
    calls.push({ name, input });
    const answer = answers[name]?.(input);
    if (answer) return answer;
    switch (name) {
      case "get_household":
        return { ok: true, value: household };
      case "get_caller":
        return { ok: true, value: null };
      case "get_week":
        return { ok: true, value: store.get(input.date as string | undefined) };
      case "search_recipes":
        return { ok: true, value: [summaryOf(recipe)] };
      case "get_recipe":
        return { ok: true, value: recipe };
      case "list_items":
        return { ok: true, value: ITEMS };
      case "list_unresolved_ingredients":
      case "list_suggestions":
      case "list_drafts":
      case "list_import_flags":
      case "list_untagged_recipes":
        return { ok: true, value: [] };
      case "set_slot": {
        const slot = store.set(String(input.date), input.meal as Slot["meal"], {
          kind: "recipe",
          recipe: dish(recipe.id, recipe.title),
          reason: null,
        });
        queueMicrotask(() => fake.notify("plan"));
        return { ok: true, value: structuredClone(slot) };
      }
      default:
        throw new Error(`Unexpected tool ${name}`);
    }
  });
  return { ...fake, calls, weeks: store };
}

async function openRecipe(client: ReturnType<typeof fakeClient>["client"]) {
  const user = userEvent.setup();
  render(() => <App client={client} />);
  await user.click(await screen.findByRole("button", { name: "Recipes" }));
  await user.click(await screen.findByRole("button", { name: "Sesame noodles" }));
  await screen.findByRole("heading", { name: "Sesame noodles", level: 1 });
  return user;
}

async function openSheet(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Plan it" }));
  return screen.findByRole("dialog", { name: "Which day?" });
}

/** The day's row in the sheet, by the day its overline names. */
function row(sheet: HTMLElement, day: string) {
  return within(sheet).getByRole("button", { name: new RegExp(day) });
}

const slotSets = (calls: { name: string; input: Record<string, unknown> }[]) =>
  calls.filter((call) => call.name === "set_slot").map((call) => call.input);

test("Plan it shows under Cook as a secondary, and the sheet lists This Week's dinners from today on", async () => {
  const fake = fakeClient();
  const user = await openRecipe(fake.client);

  const planIt = await screen.findByRole("button", { name: "Plan it" });
  expect(planIt.classList.contains("button-secondary")).toBe(true);
  const cook = screen.getByRole("button", { name: "Cook in kitchen mode" });
  expect(cook.compareDocumentPosition(planIt) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(primaries()).toEqual(["Cook in kitchen mode"]);

  const sheet = await openSheet(user);
  expect(within(sheet).getByText("Sesame noodles").classList.contains("overline")).toBe(true);
  expect(within(sheet).getByRole("button", { name: "This Week", pressed: true })).toBeTruthy();
  expect(within(sheet).getByRole("button", { name: "Dinner", pressed: true })).toBeTruthy();
  await waitFor(() => expect(within(sheet).getAllByRole("listitem")).toHaveLength(5));
  const days = within(sheet)
    .getAllByRole("listitem")
    .map((item) => item.querySelector(".overline")?.textContent);
  expect(days).toEqual(["Tonight · Wed 11", "Thu 12", "Fri 13", "Sat 14", "Sun 15"]);

  const thursday = row(sheet, "Thu 12");
  expect(within(thursday).getByText("Pencilled")).toBeTruthy();
  expect(within(thursday).getByText("Chickpea curry").classList.contains("dish-title-pencilled")).toBe(true);
  // The Diners, as the Week's day counts them; its Guests are said on the Week.
  expect(within(thursday).getByText("2 eating")).toBeTruthy();
  const friday = row(sheet, "Fri 13");
  expect(within(friday).getByText("Nothing planned").classList.contains("dish-title-none")).toBe(true);
  expect(friday.querySelector(".thumb-dashed")).toBeTruthy();
  expect(row(sheet, "Sat 14").querySelector(".thumb-solid")).toBeTruthy();
});

test("a day with nothing planned is planned in one tap, keeping who's eating, and the page says where it is", async () => {
  const fake = fakeClient();
  const user = await openRecipe(fake.client);
  const sheet = await openSheet(user);

  await waitFor(() => row(sheet, "Fri 13"));
  await user.click(row(sheet, "Fri 13"));

  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Which day?" })).toBeNull());
  expect(slotSets(fake.calls)).toEqual([{ date: "2026-11-13", meal: "dinner", kind: "recipe", recipeId: 7 }]);
  const banner = (await screen.findByText("On the plan: dinner on Fri 13.")).closest(".banner") as HTMLElement;
  expect(banner.classList.contains("banner-plum")).toBe(true);
  expect(screen.getByRole("heading", { name: "Sesame noodles", level: 1 })).toBeTruthy();
});

test("a pencilled dinner is replaced in one tap: Mise chose it", async () => {
  const fake = fakeClient();
  const user = await openRecipe(fake.client);
  const sheet = await openSheet(user);

  await waitFor(() => row(sheet, "Thu 12"));
  await user.click(row(sheet, "Thu 12"));

  await waitFor(() => expect(slotSets(fake.calls)).toEqual([expect.objectContaining({ date: "2026-11-12" })]));
  expect(await screen.findByText("On the plan: dinner on Thu 12.")).toBeTruthy();
});

test("a dinner of the Household's own asks once more before it is replaced", async () => {
  const fake = fakeClient();
  const user = await openRecipe(fake.client);
  const sheet = await openSheet(user);

  await waitFor(() => row(sheet, "Wed 11"));
  await user.click(row(sheet, "Wed 11"));

  expect(within(sheet).getByText("Lemon chicken is yours. Replace it with Sesame noodles?")).toBeTruthy();
  expect(slotSets(fake.calls)).toEqual([]);
  expect(primaries()).toContain("Replace Lemon chicken");
  await user.click(within(sheet).getByRole("button", { name: "Cancel" }));
  expect(within(sheet).queryByText("Lemon chicken is yours. Replace it with Sesame noodles?")).toBeNull();

  await user.click(row(sheet, "Sat 14"));
  expect(within(sheet).getByText("Eating out is yours. Replace it with Sesame noodles?")).toBeTruthy();
  await user.click(within(sheet).getByRole("button", { name: "Replace Eating out" }));

  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Which day?" })).toBeNull());
  expect(slotSets(fake.calls)).toEqual([{ date: "2026-11-14", meal: "dinner", kind: "recipe", recipeId: 7 }]);
});

test("a cooked dinner can't be picked", async () => {
  const fake = fakeClient();
  fake.weeks.set("2026-11-11", "dinner", { cookedAt: "2026-11-11T19:00:00.000Z" });
  const user = await openRecipe(fake.client);
  const sheet = await openSheet(user);

  await waitFor(() => row(sheet, "Wed 11"));
  expect((row(sheet, "Wed 11") as HTMLButtonElement).disabled).toBe(true);
  expect(within(row(sheet, "Wed 11")).getByText("Cooked")).toBeTruthy();
  expect((row(sheet, "Thu 12") as HTMLButtonElement).disabled).toBe(false);
});

test("a refused Conflict asks for a reason, and Save anyway plans it with the Override", async () => {
  const robinsSesame = { who: 1, allergen: "sesame", constraint: "allergy", cause: "contains" } as const;
  const fake = fakeClient(noodles, {
    set_slot: (input) =>
      input.overrides
        ? undefined
        : {
            ok: false,
            error: {
              code: "constraint_conflict",
              message: "Refused",
              conflicts: [{ date: "2026-11-13", meal: "dinner", ...robinsSesame }],
            },
          },
  });
  const user = await openRecipe(fake.client);
  const sheet = await openSheet(user);
  await waitFor(() => row(sheet, "Fri 13"));

  await user.click(row(sheet, "Fri 13"));
  const refusal = await screen.findByRole("dialog", { name: "Robin can't eat this" });
  await user.click(within(refusal).getByRole("button", { name: "Change it" }));
  expect(screen.queryByRole("dialog", { name: "Robin can't eat this" })).toBeNull();
  expect(screen.getByRole("dialog", { name: "Which day?" })).toBeTruthy();

  await user.click(row(sheet, "Fri 13"));
  const again = await screen.findByRole("dialog", { name: "Robin can't eat this" });
  await user.type(within(again).getByRole("textbox", { name: /Why it's safe for Robin/ }), "Sesame-free sauce");
  await user.click(within(again).getByRole("button", { name: "Save anyway" }));

  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Which day?" })).toBeNull());
  expect(slotSets(fake.calls).at(-1)).toEqual({
    date: "2026-11-13",
    meal: "dinner",
    kind: "recipe",
    recipeId: 7,
    overrides: [{ who: 1, allergen: "sesame", reason: "Sesame-free sauce" }],
  });
});

test("On the plan lists every meal it's in from today to the end of Next Week, and leads to the Week holding the first", async () => {
  const fake = fakeClient();
  fake.weeks.set("2026-11-09", "dinner", { kind: "recipe", recipe: dish(7, "Sesame noodles") });
  fake.weeks.set("2026-11-18", "lunch", { kind: "recipe", recipe: dish(7, "Sesame noodles") });
  fake.weeks.set("2026-11-20", "dinner", {
    kind: "recipe",
    recipe: dish(7, "Sesame noodles"),
    reason: pencil,
  });
  const user = await openRecipe(fake.client);

  const line = await screen.findByText("On the plan: lunch on Wed 18 and dinner on Fri 20.");
  const banner = line.closest(".banner") as HTMLElement;
  const cook = screen.getByRole("button", { name: "Cook in kitchen mode" });
  expect(banner.compareDocumentPosition(cook) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

  await user.click(within(banner).getByRole("button", { name: "Show the Week" }));

  expect(await screen.findByRole("button", { name: "Next Week", pressed: true })).toBeTruthy();
});

test("On the plan names This Week's days before Next Week's, and leads to This Week when it holds the first", async () => {
  const fake = fakeClient();
  fake.weeks.set("2026-11-13", "dinner", { kind: "recipe", recipe: dish(7, "Sesame noodles") });
  fake.weeks.set("2026-11-18", "lunch", { kind: "recipe", recipe: dish(7, "Sesame noodles") });
  const user = await openRecipe(fake.client);

  const banner = (await screen.findByText("On the plan: dinner on Fri 13 and lunch on Wed 18.")).closest(
    ".banner",
  ) as HTMLElement;
  await user.click(within(banner).getByRole("button", { name: "Show the Week" }));

  expect(await screen.findByRole("button", { name: "This Week", pressed: true })).toBeTruthy();
});

test("the sheet opens on Next Week once This Week has no day left to plan", async () => {
  const fake = fakeClient();
  for (const date of ["2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15"])
    fake.weeks.set(date, "dinner", { cookedAt: `${date}T19:00:00.000Z` });
  const user = await openRecipe(fake.client);

  const sheet = await openSheet(user);

  expect(within(sheet).getByRole("button", { name: "Next Week", pressed: true })).toBeTruthy();
  expect(within(sheet).getAllByRole("listitem")).toHaveLength(7);
});

test("Next Week, not yet proposed, says a dinner planned there stays yours", async () => {
  const fake = fakeClient({ ...noodles, course: "breakfast" });
  const user = await openRecipe(fake.client);
  const sheet = await openSheet(user);

  expect(within(sheet).getByRole("button", { name: "Breakfast", pressed: true })).toBeTruthy();
  const note = "Mise hasn't proposed Next Week yet. A dinner you plan here stays yours when it does.";
  expect(within(sheet).queryByText(note)).toBeNull();
  await user.click(within(sheet).getByRole("button", { name: "Next Week" }));

  // A Proposal fills dinners only, so only Dinner says so.
  await waitFor(() => expect(within(sheet).getAllByRole("listitem")).toHaveLength(7));
  expect(within(sheet).queryByText(note)).toBeNull();
  await user.click(within(sheet).getByRole("button", { name: "Dinner" }));
  expect(within(sheet).getByText(note)).toBeTruthy();
  await user.click(within(sheet).getByRole("button", { name: "Breakfast" }));
  await user.click(row(sheet, "Mon 16"));

  await waitFor(() =>
    expect(slotSets(fake.calls)).toEqual([{ date: "2026-11-16", meal: "breakfast", kind: "recipe", recipeId: 7 }]),
  );
});

test("Plan it is disabled offline, with the reason under it", async () => {
  const fake = fakeClient();
  await openRecipe(fake.client);
  fake.goOffline();

  const planIt = await screen.findByRole("button", { name: "Plan it" });
  await waitFor(() => expect((planIt as HTMLButtonElement).disabled).toBe(true));
  const reason = document.getElementById(planIt.getAttribute("aria-describedby") ?? "");
  expect(reason?.textContent).toBe("Needs a connection.");
});

test("a Draft Recipe has no Plan it and no On the plan line: it is never planned", async () => {
  const fake = fakeClient({ ...noodles, draft: true });
  fake.weeks.set("2026-11-13", "dinner", { kind: "recipe", recipe: dish(7, "Sesame noodles") });
  await openRecipe(fake.client);
  // Long enough for both Weeks to load, as they would for a Recipe that isn't a Draft.
  await new Promise((resolve) => setTimeout(resolve, 20));

  expect(screen.getByRole("button", { name: "Cook in kitchen mode" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Plan it" })).toBeNull();
  expect(screen.queryByText(/On the plan/)).toBeNull();
});
