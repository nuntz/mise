import { describe, expect, test } from "bun:test";
import { slotConflicts } from "./conflicts";
import { WEEKDAYS } from "./household";
import { ALLERGENS, type Constraint, type Member } from "./members";
import type { Rating } from "./proposals";
import {
  type Proposal,
  type ProposerDinner,
  type ProposerInput,
  type ProposerRecipe,
  proposeWeek,
  rerollWeek,
} from "./proposer";
import { addDays, weekdayOf } from "./weeks";

// Monday 26 October 2026 to Sunday 1 November.
const MONDAY = "2026-10-26";

const robin = { id: 1, constraints: [{ kind: "allergy", allergen: "peanut" }] } satisfies Pick<
  Member,
  "id" | "constraints"
>;
const alex = { id: 2, constraints: [] } satisfies Pick<Member, "id" | "constraints">;

/** A Recipe of nothing in particular: no Allergens, quick, untagged, never rated. */
function recipe(id: number, fields: Partial<ProposerRecipe> = {}): ProposerRecipe {
  return {
    id,
    title: `Recipe ${id}`,
    ingredients: [],
    allergens: { kind: "known", allergens: [] },
    effortMinutes: 30,
    cuisine: null,
    mainProtein: null,
    recurring: null,
    importedPreference: null,
    ratings: [],
    ...fields,
  };
}

/** The Week's seven dinners, unplanned, for Robin and Alex. */
function dinners(): ProposerDinner[] {
  return Array.from({ length: 7 }, (_, day) => ({
    date: addDays(MONDAY, day),
    kind: "unplanned",
    recipeId: null,
    locked: false,
    cooked: false,
    diners: [robin, alex],
    guests: 0,
    guestConstraints: [],
  }));
}

function input(fields: Partial<ProposerInput> = {}): ProposerInput {
  return {
    dinners: dinners(),
    recipes: Array.from({ length: 20 }, (_, index) => recipe(index + 1)),
    history: [],
    effortBudgets: { monday: 45, tuesday: 45, wednesday: 45, thursday: 45, friday: 60, saturday: 120, sunday: 90 },
    useUp: [],
    seed: 1,
    ...fields,
  };
}

describe("proposeWeek", () => {
  test("fills every dinner with a Recipe, never one that conflicts with someone eating it", () => {
    const satay = recipe(1, { allergens: { kind: "known", allergens: ["peanut"] } });
    const stew = recipe(2, { allergens: { kind: "unknown", atLeast: [], unresolved: 1 } });
    const recipes = [satay, stew, ...Array.from({ length: 7 }, (_, index) => recipe(index + 3))];

    const proposal = proposeWeek(input({ recipes }));

    expect(proposal.dinners).toHaveLength(7);
    for (const dinner of proposal.dinners) {
      expect(dinner.kind).toBe("recipe");
      expect([1, 2]).not.toContain(dinner.recipeId);
    }
  });
});

/** A small, seeded generator for the random Weeks below, so that a failure always reproduces. */
function generator(seed: number) {
  let state = seed;
  const next = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  const int = (below: number) => Math.floor(next() * below);
  const one = <T>(of: readonly T[]): T => of[int(of.length)] as T;
  const some = <T>(of: readonly T[], chance: number): T[] => of.filter(() => next() < chance);
  return { next, int, one, some };
}

const PROTEINS = ["chicken", "beef", "tofu", "fish", null] as const;
const CUISINES = ["italian", "thai", "mexican", null] as const;
const FEW_ALLERGENS = ["peanut", "milk", "wheat", "egg"] as const;

/**
 * A random Week: Members with random Hard Constraints and dislikes, Recipes with random Allergens
 * (some unknown), efforts, tags and Ratings, dinners some Locked or decided by hand, and history.
 */
function randomWeek(seed: number): ProposerInput {
  const random = generator(seed);
  const constraints = (): Constraint[] => [
    ...random
      .some(FEW_ALLERGENS, 0.15)
      .map((allergen) => ({ kind: random.one(["allergy", "diet"] as const), allergen })),
    ...random.some(FEW_ALLERGENS, 0.1).map((allergen) => ({ kind: "dislike" as const, allergen })),
  ];
  const members = Array.from({ length: 1 + random.int(4) }, (_, index) => ({
    id: index + 1,
    constraints: constraints(),
  }));
  const recipes = Array.from({ length: 5 + random.int(30) }, (_, index) =>
    recipe(index + 1, {
      allergens:
        random.next() < 0.15
          ? { kind: "unknown", atLeast: random.some(FEW_ALLERGENS, 0.2), unresolved: 1 }
          : { kind: "known", allergens: random.some(ALLERGENS, 0.15) },
      effortMinutes: random.next() < 0.2 ? null : 10 + random.int(150),
      cuisine: random.one(CUISINES),
      mainProtein: random.one(PROTEINS),
      recurring: random.next() < 0.05 ? "weekly" : random.next() < 0.05 ? { weekday: random.one(WEEKDAYS) } : null,
      importedPreference: random.one(["positive", "negative", null] as const),
      ratings: random.some(["again", "meh", "never"] as Rating[], 0.15),
    }),
  );
  const week = dinners().map((dinner): ProposerDinner => {
    const diners = members.filter(() => random.next() < 0.8);
    const guests = random.next() < 0.2 ? 1 + random.int(3) : 0;
    const roll = random.next();
    const planned = random.one(recipes);
    return {
      ...dinner,
      diners,
      guests,
      guestConstraints: guests > 0 ? constraints() : [],
      ...(roll < 0.15 && { kind: "recipe", recipeId: planned.id, locked: true }),
      ...(roll >= 0.15 && roll < 0.25 && { kind: random.one(["leftovers", "eat_out", "skip"] as const) }),
      ...(roll >= 0.25 && roll < 0.35 && { kind: "recipe", recipeId: planned.id }),
      ...(roll >= 0.35 && roll < 0.45 && { kind: "recipe", recipeId: planned.id, cooked: true }),
    };
  });
  const history = Array.from({ length: random.int(10) }, () => ({
    recipeId: random.one(recipes).id,
    date: addDays(MONDAY, -1 - random.int(50)),
  }));
  return input({ dinners: week, recipes, history, seed: random.int(1_000_000) });
}

const WEEKS = Array.from({ length: 300 }, (_, index) => index + 1);

/** The dinners a Proposal filled itself, not those it kept. */
function filled(proposal: Proposal) {
  return proposal.dinners.filter((dinner) => dinner.reason.kind === "chosen" || dinner.reason.kind === "recurring");
}

describe("proposeWeek, over random Weeks", () => {
  test("never proposes a Recipe that conflicts with a Hard Constraint of a Diner or the Guests", () => {
    for (const seed of WEEKS) {
      const week = randomWeek(seed);
      filled(proposeWeek(week)).forEach((dinner) => {
        const before = week.dinners.find((other) => other.date === dinner.date) as ProposerDinner;
        const chosen = week.recipes.find((other) => other.id === dinner.recipeId) as ProposerRecipe;
        expect(slotConflicts({ allergens: chosen.allergens, ...before })).toEqual([]);
      });
    }
  });

  test("keeps Locked Slots, cooked dinners, and those decided as Leftovers, eating out or no meal", () => {
    for (const seed of WEEKS) {
      const week = randomWeek(seed);
      const proposal = proposeWeek(week);
      week.dinners.forEach((before, index) => {
        if (!before.locked && !before.cooked && !["leftovers", "eat_out", "skip"].includes(before.kind)) return;
        expect(proposal.dinners[index]).toMatchObject({ kind: before.kind, recipeId: before.recipeId });
      });
    }
  });

  test("the same input and seed always give the same Proposal", () => {
    for (const seed of WEEKS) {
      expect(proposeWeek(randomWeek(seed))).toEqual(proposeWeek(randomWeek(seed)));
    }
  });

  test("never chooses a Recipe rated never, over the day's Effort Budget, or planned within 2 weeks", () => {
    for (const seed of WEEKS) {
      const week = randomWeek(seed);
      const proposal = proposeWeek(week);
      const planned = [
        ...week.history,
        ...proposal.dinners.flatMap((dinner) =>
          dinner.recipeId === null ? [] : [{ recipeId: dinner.recipeId, date: dinner.date }],
        ),
      ];
      for (const dinner of proposal.dinners.filter((other) => other.reason.kind === "chosen")) {
        const chosen = week.recipes.find((other) => other.id === dinner.recipeId) as ProposerRecipe;
        expect(chosen.ratings).not.toContain("never");
        expect(chosen.effortMinutes ?? 0).toBeLessThanOrEqual(week.effortBudgets[weekdayOf(dinner.date)]);
        for (const other of planned) {
          if (other.recipeId !== chosen.id || other.date === dinner.date) continue;
          expect(Math.abs(Date.parse(other.date) - Date.parse(dinner.date))).toBeGreaterThanOrEqual(14 * 86_400_000);
        }
      }
    }
  });

  test("a re-roll differs from the Week as it was proposed, and keeps its Locked Slots", () => {
    for (const seed of WEEKS) {
      const week = randomWeek(seed);
      const first = proposeWeek(week);
      const proposed: ProposerDinner[] = week.dinners.map((dinner, index) => ({
        ...dinner,
        kind: first.dinners[index]?.kind ?? dinner.kind,
        recipeId: first.dinners[index]?.recipeId ?? null,
      }));
      // Only a Week with room to choose can come out differently.
      const roomToChoose = first.dinners.some(
        (dinner) => dinner.reason.kind === "chosen" && dinner.reason.candidates > 1,
      );
      if (!roomToChoose) continue;

      const rerolled = rerollWeek({ ...week, dinners: proposed });

      expect(rerolled.seed).not.toBe(first.seed);
      expect(rerolled.dinners.map((dinner) => dinner.recipeId)).not.toEqual(first.dinners.map((d) => d.recipeId));
      week.dinners.forEach((before, index) => {
        if (before.locked) expect(rerolled.dinners[index]?.recipeId).toBe(before.recipeId);
      });
    }
  });
});

describe("proposeWeek, rule by rule", () => {
  test("a Recurring Recipe for a weekday is pinned to that day's dinner, and a weekly one to one dinner", () => {
    const tacoTuesday = recipe(1, { recurring: { weekday: "tuesday" } });
    const pizza = recipe(2, { recurring: "weekly" });

    for (const seed of [1, 2, 3, 4, 5]) {
      const proposal = proposeWeek(input({ recipes: [tacoTuesday, pizza, ...input().recipes.slice(2)], seed }));

      expect(proposal.dinners[1]).toMatchObject({
        recipeId: 1,
        reason: { kind: "recurring", recurrence: { weekday: "tuesday" } },
      });
      expect(proposal.dinners.filter((dinner) => dinner.recipeId === 2)).toEqual([
        expect.objectContaining({ reason: { kind: "recurring", recurrence: "weekly" } }),
      ]);
    }
  });

  test("a Recurring Recipe is never pinned where it conflicts, nor again when a Locked Slot already has it", () => {
    const satay = recipe(1, { recurring: { weekday: "monday" }, allergens: { kind: "known", allergens: ["peanut"] } });
    const pizza = recipe(2, { recurring: "weekly" });
    const week = dinners();
    week[4] = { ...(week[4] as ProposerDinner), kind: "recipe", recipeId: 2, locked: true };

    const proposal = proposeWeek(input({ dinners: week, recipes: [satay, pizza, ...input().recipes.slice(2)] }));

    expect(proposal.dinners.map((dinner) => dinner.recipeId)).not.toContain(1);
    expect(proposal.dinners.filter((dinner) => dinner.recipeId === 2)).toHaveLength(1);
  });

  test("Recipes over the day's Effort Budget are left out, but an unknown effort passes", () => {
    const slow = Array.from({ length: 10 }, (_, index) => recipe(index + 1, { effortMinutes: 100 }));
    const unknown = recipe(11, { effortMinutes: null });

    const proposal = proposeWeek(input({ recipes: [...slow, unknown] }));

    // Monday's budget is 45 minutes; Saturday's is 120.
    expect(proposal.dinners[0]).toMatchObject({
      recipeId: 11,
      reason: {
        kind: "chosen",
        candidates: 1,
        factors: expect.arrayContaining([{ kind: "effort", minutes: null, budget: 45 }]),
      },
    });
    expect(proposal.dinners[5]?.recipeId).not.toBe(11);
    // Nothing quick enough is left for the rest of the weeknights.
    expect(proposal.dinners[1]).toMatchObject({
      kind: "unplanned",
      recipeId: null,
      reason: { kind: "no_candidate", excluded: { conflict: 0, never: 0, recent: 1, effort: 10 } },
    });
  });

  test("a Recipe planned lately is scored down, less the longer ago, until 6 weeks", () => {
    const recently = recipe(1);
    const longAgo = recipe(2);
    const history = [
      { recipeId: 1, date: addDays(MONDAY, -20) },
      { recipeId: 2, date: addDays(MONDAY, -50) },
    ];
    const week = dinners().slice(0, 1);

    for (const seed of [1, 2, 3, 4, 5]) {
      const proposal = proposeWeek(input({ dinners: week, recipes: [recently, longAgo], history, seed }));
      expect(proposal.dinners[0]).toMatchObject({
        recipeId: 2,
        reason: { factors: expect.arrayContaining([{ kind: "recency", daysApart: null }]) },
      });
    }
    const onlyRecent = proposeWeek(input({ dinners: week, recipes: [recently], history }));
    expect(onlyRecent.dinners[0]).toMatchObject({
      reason: { factors: expect.arrayContaining([{ kind: "recency", daysApart: 20 }]) },
    });
  });

  test("a main protein doesn't come back within 3 dinners, nor a cuisine on the next night", () => {
    const recipes = ["chicken", "beef", "tofu"].flatMap((protein, p) =>
      Array.from({ length: 7 }, (_, index) =>
        recipe(p * 7 + index + 1, { mainProtein: protein, cuisine: index % 2 === 0 ? "italian" : "thai" }),
      ),
    );

    for (const seed of [1, 2, 3, 4, 5]) {
      const chosen = proposeWeek(input({ recipes, seed })).dinners.map(
        (dinner) => recipes.find((other) => other.id === dinner.recipeId) as ProposerRecipe,
      );
      chosen.forEach((dinner, day) => {
        expect(chosen.slice(Math.max(0, day - 2), day).map((other) => other.mainProtein)).not.toContain(
          dinner.mainProtein,
        );
        if (day > 0) expect(chosen[day - 1]?.cuisine).not.toBe(dinner.cuisine);
      });
    }
  });

  test("Ratings and Imported Preference weigh in: never is left out, again and positive come first", () => {
    const week = dinners().slice(0, 1);
    const plain = Array.from({ length: 5 }, (_, index) => recipe(index + 3));

    for (const seed of [1, 2, 3, 4, 5]) {
      const again = proposeWeek(
        input({ dinners: week, seed, recipes: [recipe(1, { ratings: ["meh", "again"] }), ...plain] }),
      );
      expect(again.dinners[0]).toMatchObject({
        recipeId: 1,
        reason: { factors: expect.arrayContaining([{ kind: "rating", rating: "again" }]) },
      });
      const liked = proposeWeek(
        input({ dinners: week, seed, recipes: [recipe(1, { importedPreference: "positive" }), ...plain] }),
      );
      expect(liked.dinners[0]?.recipeId).not.toBe(3 + 5);
    }
    const never = proposeWeek(input({ dinners: week, recipes: [recipe(1, { ratings: ["again", "never"] })] }));
    expect(never.dinners[0]).toMatchObject({ reason: { kind: "no_candidate", excluded: { never: 1 } } });
  });

  test("Recipes using the 'use it up' Items are favoured, and dislikes score a Recipe down", () => {
    const week = dinners().slice(0, 1);
    week[0] = {
      ...(week[0] as ProposerDinner),
      diners: [{ id: 2, constraints: [{ kind: "dislike", term: "mushroom" }] }],
    };
    const ingredient = (raw: string, item: ProposerRecipe["ingredients"][number]["item"]) => ({
      raw,
      amount: null,
      unit: null,
      name: raw,
      note: null,
      item,
    });
    const spinach = recipe(1, { ingredients: [ingredient("200 g spinach", "spinach")] });
    const mushrooms = recipe(2, { title: "Mushroom risotto", ingredients: [ingredient("1 cup rice", "rice")] });
    const plain = Array.from({ length: 4 }, (_, index) => recipe(index + 3));

    for (const seed of [1, 2, 3, 4, 5]) {
      const proposal = proposeWeek(
        input({ dinners: week, seed, recipes: [spinach, mushrooms, ...plain], useUp: ["spinach"] }),
      );
      expect(proposal.dinners[0]).toMatchObject({
        recipeId: 1,
        reason: { factors: expect.arrayContaining([{ kind: "uses_up", items: ["spinach"] }]) },
      });
    }
    const onlyDisliked = proposeWeek(input({ dinners: week, recipes: [mushrooms] }));
    expect(onlyDisliked.dinners[0]).toMatchObject({
      recipeId: 2,
      reason: { factors: expect.arrayContaining([{ kind: "disliked", by: [2] }]) },
    });
  });

  test("a re-roll that only differs by choosing from every Recipe that fits is proposed again the same", () => {
    // Rated again, Recipe 1 is always the best choice; only a wider choice can pick Recipe 2.
    const recipes = [recipe(1, { ratings: ["again"] }), recipe(2)];
    const week = dinners().slice(0, 1);
    const asProposed = proposeWeek(input({ dinners: week, recipes }));
    expect(asProposed.dinners[0]?.recipeId).toBe(1);

    const rerolled = rerollWeek(
      input({ dinners: [{ ...(week[0] as ProposerDinner), kind: "recipe", recipeId: 1 }], recipes }),
    );

    expect(rerolled).toMatchObject({ choice: "any", dinners: [{ recipeId: 2 }] });
    expect(proposeWeek(input({ dinners: week, recipes, seed: rerolled.seed, choice: rerolled.choice }))).toEqual(
      rerolled,
    );
  });

  test("a dinner nobody is eating is left unplanned", () => {
    const week = dinners();
    week[2] = { ...(week[2] as ProposerDinner), diners: [] };

    expect(proposeWeek(input({ dinners: week })).dinners[2]).toEqual({
      date: addDays(MONDAY, 2),
      kind: "unplanned",
      recipeId: null,
      reason: { kind: "nobody_eating" },
    });
  });
});
