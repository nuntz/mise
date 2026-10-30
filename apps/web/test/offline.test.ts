import {
  addDays,
  currentWeek,
  DEFAULT_EFFORT_BUDGETS,
  type HouseholdClock,
  type LocalDate,
  MEALS,
  type Recipe,
  type RecipeId,
  type Slot,
  type ToolResult,
  type Week,
} from "@mise/domain";
import { createRoot } from "solid-js";
import { afterEach, expect, test } from "vitest";
import { keepPlannedRecipes, savedRecipe, saveRecipe } from "../src/offline";
import { createFakeClient } from "./fakeClient";

const household: HouseholdClock = {
  timezone: "America/Toronto",
  weekStartsOn: "monday",
  weekStartChanges: [],
};
const thisWeek = currentWeek(new Date(), household).startDate;
const nextWeek = addDays(thisWeek, 7);

function recipe(id: RecipeId, title: string): Recipe {
  return {
    id,
    title,
    tags: [],
    effortMinutes: 20,
    cuisine: null,
    mainProtein: null,
    course: null,
    readyMade: false,
    allergens: { kind: "known", allergens: [] },
    photoKey: null,
    baseServings: 4,
    ingredients: [],
    steps: [],
    recurring: null,
    yieldsLeftovers: false,
    prepAhead: null,
    notes: null,
    source: { kind: "manual" },
    importedPreference: null,
    createdAt: "2026-10-21T12:00:00.000Z",
    updatedAt: "2026-10-21T12:00:00.000Z",
    editedInAppAt: null,
    draft: false,
    lastCookedAt: null,
    cookCount: 0,
  };
}

const dal = recipe(1, "Dal");
const tacos = recipe(2, "Tacos");
const curry = recipe(3, "Curry");
const soup = recipe(4, "Soup");

const slotRecipe = ({ id, title, baseServings, photoKey, readyMade }: Recipe) => ({
  id,
  title,
  baseServings,
  photoKey,
  readyMade,
});

/** A Week starting `startDate` with `planned` dinners on its first days, in order. */
function week(startDate: LocalDate, planned: Partial<Slot>[] = []): Week {
  const dinners = planned.map((slot, day) => ({ ...slot, date: addDays(startDate, day) }));
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
          diners: [],
          dinersAreDefault: true,
          guests: 0,
          guestConstraints: [],
          servings: 0,
          cookFor: 0,
          leftoversOf: null,
          leftovers: [],
          locked: false,
          conflicts: [],
          reason: null,
          cookedAt: null,
          ratings: [],
          ...(meal === "dinner" ? dinners.find((dinner) => dinner.date === date) : {}),
        }),
      ),
    ),
    effortBudgets: DEFAULT_EFFORT_BUDGETS,
    effortBudgetOverrides: {},
    proposalSeed: null,
    reviewed: false,
  };
}

const cooking = (cooked: Recipe): Partial<Slot> => ({ kind: "recipe", recipe: slotRecipe(cooked) });
const leftoversOf = (cooked: Recipe): Partial<Slot> => ({
  kind: "leftovers",
  leftoversOf: { date: "2026-01-01", meal: "dinner", recipe: slotRecipe(cooked) },
});

type Answers = {
  weeks: Record<LocalDate, Week | "fails">;
  recipes: Recipe[];
  /** Answered with an error. */
  failing?: RecipeId[];
  /** Never answered: the call rejects, as one does when it times out. */
  timingOut?: RecipeId[];
};

/** Keeps the planned Recipes the way the app does, answering from `answers`, which a test may change. */
function keep(answers: Answers) {
  const fake = createFakeClient(async (name, input): Promise<ToolResult<unknown>> => {
    if (name === "get_week") {
      const found = answers.weeks[input.date as LocalDate];
      return found === "fails" || !found
        ? { ok: false, error: { code: "not_found", message: "No" } }
        : { ok: true, value: found };
    }
    if (name === "get_recipe") {
      const found = answers.recipes.find((each) => each.id === input.id);
      if (found && answers.timingOut?.includes(found.id)) throw new Error("Timed out");
      return found && !answers.failing?.includes(found.id)
        ? { ok: true, value: found }
        : { ok: false, error: { code: "not_found", message: "No" } };
    }
    throw new Error(`Unexpected tool ${name}`);
  });
  const dispose = createRoot((dispose) => {
    keepPlannedRecipes(fake.client, () => household);
    return dispose;
  });
  disposers.push(dispose);
  return fake;
}

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

/** Lets every call in flight answer, and what it answers be saved. */
const settled = () => new Promise((resolve) => setTimeout(resolve));

test("every Recipe planned this Week and next, and each Leftovers' Recipe, is kept on this device", async () => {
  keep({
    weeks: {
      [thisWeek]: week(thisWeek, [cooking(dal), leftoversOf(tacos)]),
      [nextWeek]: week(nextWeek, [cooking(curry)]),
    },
    recipes: [dal, tacos, curry, soup],
  });
  await settled();

  expect(savedRecipe(dal.id)?.title).toBe("Dal");
  expect(savedRecipe(tacos.id)?.title).toBe("Tacos");
  expect(savedRecipe(curry.id)?.title).toBe("Curry");
  expect(savedRecipe(soup.id)).toBeUndefined();
});

test("a Recipe replanned away drops off this device, and the one planned in its place is kept", async () => {
  const answers: Answers = {
    weeks: { [thisWeek]: week(thisWeek, [cooking(dal), cooking(curry)]), [nextWeek]: week(nextWeek, [cooking(dal)]) },
    recipes: [dal, tacos, curry],
  };
  const { notify } = keep(answers);
  await settled();

  answers.weeks[thisWeek] = week(thisWeek, [cooking(tacos), cooking(soup)]);
  answers.recipes.push(soup);
  notify("plan");
  await settled();

  // Dal is still planned next Week.
  expect(savedRecipe(dal.id)?.title).toBe("Dal");
  expect(savedRecipe(curry.id)).toBeUndefined();
  expect(savedRecipe(tacos.id)?.title).toBe("Tacos");
  expect(savedRecipe(soup.id)?.title).toBe("Soup");
});

test("a Recipe no longer planned but last viewed still opens", async () => {
  const answers: Answers = {
    weeks: { [thisWeek]: week(thisWeek, [cooking(dal)]), [nextWeek]: week(nextWeek) },
    recipes: [dal],
  };
  const { notify } = keep(answers);
  await settled();
  saveRecipe(dal);

  answers.weeks[thisWeek] = week(thisWeek);
  notify("plan");
  await settled();

  expect(savedRecipe(dal.id)?.title).toBe("Dal");
});

test("a Recipe that fails to load keeps its earlier copy", async () => {
  const answers: Answers = {
    weeks: { [thisWeek]: week(thisWeek, [cooking(dal), cooking(tacos)]), [nextWeek]: week(nextWeek) },
    recipes: [dal, tacos],
  };
  const { notify } = keep(answers);
  await settled();

  answers.recipes = [
    { ...dal, title: "Red lentil dal" },
    { ...tacos, title: "Fish tacos" },
  ];
  answers.failing = [dal.id];
  notify("recipes");
  await settled();

  expect(savedRecipe(dal.id)?.title).toBe("Dal");
  expect(savedRecipe(tacos.id)?.title).toBe("Fish tacos");
});

test("a Recipe whose load times out keeps its earlier copy, and the rest are kept as they are now", async () => {
  const answers: Answers = {
    weeks: { [thisWeek]: week(thisWeek, [cooking(dal), cooking(tacos)]), [nextWeek]: week(nextWeek) },
    recipes: [dal, tacos, curry],
  };
  const { notify } = keep(answers);
  await settled();

  answers.weeks[nextWeek] = week(nextWeek, [cooking(curry)]);
  answers.timingOut = [dal.id];
  notify("plan");
  await settled();

  expect(savedRecipe(dal.id)?.title).toBe("Dal");
  expect(savedRecipe(curry.id)?.title).toBe("Curry");
});

test("a Week that fails to load leaves the kept Recipes as they were", async () => {
  const answers: Answers = {
    weeks: { [thisWeek]: week(thisWeek, [cooking(dal)]), [nextWeek]: week(nextWeek) },
    recipes: [dal],
  };
  const { notify } = keep(answers);
  await settled();

  answers.weeks[thisWeek] = week(thisWeek);
  answers.weeks[nextWeek] = "fails";
  notify("plan");
  await settled();

  expect(savedRecipe(dal.id)?.title).toBe("Dal");
});

test("a kept Recipe that no longer fits is ignored without losing the others", async () => {
  // As an older Mise kept them: Tacos from before Ready-made dishes, Dal broken.
  const { readyMade: _, ...oldTacos } = tacos;
  localStorage.setItem("mise.plannedRecipes", JSON.stringify({ [dal.id]: { id: dal.id }, [tacos.id]: oldTacos }));

  expect(savedRecipe(dal.id)).toBeUndefined();
  expect(savedRecipe(tacos.id)).toMatchObject({ title: "Tacos", readyMade: false });
});
