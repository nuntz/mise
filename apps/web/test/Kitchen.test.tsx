import {
  addDays,
  DEFAULT_EFFORT_BUDGETS,
  type Household,
  MEALS,
  parseIngredient,
  type Recipe,
  type Slot,
  STORE_SECTIONS,
  type Week,
} from "@mise/domain";
import { render, screen, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "../src/App";
import type { MiseClient } from "../src/client";
import { saveRecipe } from "../src/offline";
import { createFakeClient } from "./fakeClient";

const household: Household = {
  name: "The Tremblays",
  timezone: "America/Vancouver",
  dinnerTime: "18:00",
  weekStartsOn: "monday",
  weekStartChanges: [],
  units: "metric",
  locale: "en-CA",
  members: [{ id: 1, name: "Robin", email: null, constraints: [] }],
  effortBudgets: DEFAULT_EFFORT_BUDGETS,
  storeSections: [...STORE_SECTIONS],
};

const curry: Recipe = {
  id: 2,
  title: "Curry",
  baseServings: 4,
  ingredients: ["2 cloves garlic, minced", "1 cup rice", "400 ml coconut milk", "salt to taste"].map((raw) =>
    parseIngredient(raw),
  ),
  steps: ["Fry the garlic.", "Add the coconut milk and simmer.", "Serve over the rice."],
  tags: [],
  effortMinutes: 40,
  cuisine: null,
  mainProtein: null,
  course: null,
  readyMade: false,
  recurring: null,
  yieldsLeftovers: true,
  prepAhead: null,
  notes: null,
  photoKey: null,
  allergens: { kind: "known", allergens: [] },
  source: { kind: "manual" },
  importedPreference: null,
  createdAt: "2026-10-21T12:00:00.000Z",
  updatedAt: "2026-10-21T12:00:00.000Z",
  editedInAppAt: null,
  draft: false,
  lastCookedAt: null,
  cookCount: 0,
};

/** This Week, with Monday's dinner the Curry cooked for 6: 4 eating and Tuesday's Leftovers. */
function week(): Week {
  const startDate = "2026-10-26";
  const slots = Array.from({ length: 7 }, (_, day) => addDays(startDate, day)).flatMap((date) =>
    MEALS.map(
      (meal): Slot => ({
        date,
        meal,
        kind: "unplanned",
        recipe: null,
        note: null,
        diners: [1],
        dinersAreDefault: true,
        guests: 0,
        guestConstraints: [],
        servings: 1,
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
  );
  Object.assign(slots[2] as Slot, {
    kind: "recipe",
    recipe: { id: 2, title: "Curry", baseServings: 4, photoKey: null },
    servings: 4,
    cookFor: 6,
    leftovers: [{ date: "2026-10-27", meal: "dinner" }],
  });
  return {
    startDate,
    endDate: addDays(startDate, 6),
    slots,
    effortBudgets: DEFAULT_EFFORT_BUDGETS,
    effortBudgetOverrides: {},
    proposalSeed: null,
    reviewed: false,
  };
}

function fakeClient(): MiseClient {
  return createFakeClient(async (name: string) => {
    switch (name) {
      case "get_household":
        return { ok: true, value: household };
      case "get_week":
        return { ok: true, value: week() };
      case "get_recipe":
        return { ok: true, value: curry };
      case "search_recipes":
        return { ok: true, value: [] };
      default:
        throw new Error(`Unexpected tool ${name}`);
    }
  }).client;
}

/** A screen wake lock the test can watch. */
function fakeWakeLock() {
  const release = vi.fn(async () => {});
  const request = vi.fn(async () => ({ release, released: false, type: "screen" }));
  Object.defineProperty(navigator, "wakeLock", { value: { request }, configurable: true });
  return { request, release };
}

afterEach(() => {
  Reflect.deleteProperty(navigator, "wakeLock");
});

async function cookMonday() {
  const user = userEvent.setup();
  render(() => <App client={fakeClient()} />);
  const monday = await screen.findByRole("region", { name: "Monday, October 26" });
  await user.click(within(monday).getByRole("button", { name: "Cook" }));
  const kitchen = await screen.findByRole("region", { name: "Kitchen mode" });
  await within(kitchen).findByRole("heading", { name: "Curry" });
  return { user, kitchen };
}

test("kitchen mode loads its Recipe when another was the last one viewed", async () => {
  saveRecipe({ ...curry, id: 7, title: "Toast", steps: ["Butter it."] });
  const { kitchen } = await cookMonday();

  expect(within(kitchen).getByText("Fry the garlic.")).toBeTruthy();
});

test("kitchen mode walks the Recipe one step at a time", async () => {
  const { user, kitchen } = await cookMonday();

  expect(within(kitchen).getByText("Step 1 of 3")).toBeTruthy();
  expect(within(kitchen).getByText("Fry the garlic.")).toBeTruthy();
  expect(within(kitchen).queryByText("Add the coconut milk and simmer.")).toBeNull();
  // The first step has nowhere to go back to.
  expect(within(kitchen).queryByRole("button", { name: "Previous step" })).toBeNull();

  await user.click(within(kitchen).getByRole("button", { name: "Next step" }));
  expect(within(kitchen).getByText("Step 2 of 3")).toBeTruthy();
  expect(within(kitchen).getByText("Add the coconut milk and simmer.")).toBeTruthy();

  await user.click(within(kitchen).getByRole("button", { name: "Previous step" }));
  expect(within(kitchen).getByText("Fry the garlic.")).toBeTruthy();

  await user.click(within(kitchen).getByRole("button", { name: "Next step" }));
  await user.click(within(kitchen).getByRole("button", { name: "Next step" }));
  expect(within(kitchen).getByText("Serve over the rice.")).toBeTruthy();
  await user.click(within(kitchen).getByRole("button", { name: "Finish" }));

  expect(screen.queryByRole("region", { name: "Kitchen mode" })).toBeNull();
  expect(screen.getByRole("region", { name: "Monday, October 26" })).toBeTruthy();
});

test("Previous back to the first step by keyboard leaves focus on Next, not the page", async () => {
  const { user, kitchen } = await cookMonday();
  await user.click(within(kitchen).getByRole("button", { name: "Next step" }));

  within(kitchen).getByRole("button", { name: "Previous step" }).focus();
  await user.keyboard("{Enter}");

  expect(within(kitchen).getByText("Step 1 of 3")).toBeTruthy();
  expect(document.activeElement).toBe(within(kitchen).getByRole("button", { name: "Next step" }));
});

test("step progress shows as dots as well as in words, the current one filled", async () => {
  const { user, kitchen } = await cookMonday();
  // The dots repeat "Step 1 of 3" for the eye; a screen reader hears it once.
  const dots = kitchen.querySelector(".step-dots");
  const filled = () => Array.from(dots?.children ?? []).map((dot) => dot.classList.contains("step-dot-current"));

  expect(dots?.getAttribute("aria-hidden")).toBe("true");
  expect(filled()).toEqual([true, false, false]);
  await user.click(within(kitchen).getByRole("button", { name: "Next step" }));
  expect(filled()).toEqual([false, true, false]);
});

test("the Ingredients are one tap away, scaled to what the dinner is cooked for, Leftovers included", async () => {
  const { user, kitchen } = await cookMonday();

  await user.click(within(kitchen).getByRole("button", { name: "Ingredients" }));
  const list = within(kitchen).getByRole("list", { name: "Ingredients" });
  expect(within(kitchen).getByText("For 6. The Recipe makes 4.")).toBeTruthy();
  expect(
    within(list)
      .getAllByRole("listitem")
      .map((item) => item.textContent),
  ).toEqual(["3 cloves garlic, minced", "1½ cups rice", "600 ml coconut milk", "salt to taste"]);

  // Back to the step being cooked.
  await user.click(within(kitchen).getByRole("button", { name: "Back to the steps" }));
  expect(within(kitchen).getByText("Fry the garlic.")).toBeTruthy();
});

test("kitchen mode keeps the screen awake until it is left", async () => {
  const { request, release } = fakeWakeLock();
  const { user, kitchen } = await cookMonday();

  await vi.waitFor(() => expect(request).toHaveBeenCalledWith("screen"));
  expect(release).not.toHaveBeenCalled();

  await user.click(within(kitchen).getByRole("button", { name: "Leave kitchen mode" }));
  await vi.waitFor(() => expect(release).toHaveBeenCalled());
});

test("kitchen mode is high contrast", async () => {
  const { kitchen } = await cookMonday();
  expect(kitchen.closest("[data-theme]")?.getAttribute("data-theme")).toBe("kitchen");
});
