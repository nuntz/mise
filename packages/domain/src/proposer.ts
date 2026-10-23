import { type ConflictWho, slotConflicts } from "./conflicts";
import type { EffortBudgets } from "./household";
import type { ItemId } from "./items";
import type { Allergen, Constraint, Member } from "./members";
import type { Exclusions, ProposalChoice, ProposalReason, Rating, ReasonFactor } from "./proposals";
import type { Recipe, RecipeId } from "./recipes";
import { type LocalDate, type SlotKind, weekdayOf } from "./weeks";

/** A dinner of the Week as the Proposer finds it. */
export type ProposerDinner = {
  date: LocalDate;
  kind: SlotKind;
  recipeId: RecipeId | null;
  locked: boolean;
  /** Marked cooked: what was eaten stays as it was. */
  cooked: boolean;
  diners: Pick<Member, "id" | "constraints">[];
  guests: number;
  guestConstraints: Constraint[];
};

/** What the Proposer weighs of a Recipe, with its Ratings, oldest first. */
export type ProposerRecipe = Pick<
  Recipe,
  | "id"
  | "title"
  | "ingredients"
  | "allergens"
  | "effortMinutes"
  | "cuisine"
  | "mainProtein"
  | "recurring"
  | "importedPreference"
> & { ratings: Rating[] };

export type ProposerInput = {
  /** The Week's dinners, in date order. */
  dinners: ProposerDinner[];
  recipes: ProposerRecipe[];
  /** Recipes planned for dinners outside the Week, before or after it. */
  history: { recipeId: RecipeId; date: LocalDate }[];
  /** This Week's, overrides included. */
  effortBudgets: EffortBudgets;
  /** Items on hand that Recipes using them are favoured for. */
  useUp: ItemId[];
  seed: number;
  /** "best" when left out; see `ProposalChoice`. */
  choice?: ProposalChoice;
};

export type ProposedDinner = { date: LocalDate; kind: SlotKind; recipeId: RecipeId | null; reason: ProposalReason };

/** The seed and choice it was made with: given them again, with the same input, it comes out the same. */
export type Proposal = { seed: number; choice: ProposalChoice; dinners: ProposedDinner[] };

/** How far either side of a dinner, in days, a Recipe planned still weighs on what is proposed for it. */
export const PLANNED_WEIGHS_FOR_DAYS = 42;
/** A Recipe planned this close to a dinner, in days, is not proposed for it. */
const EXCLUDED_WITHIN_DAYS = 14;
/** The recency penalty fades from its full weight at 2 weeks to nothing at 6. */
const RECENCY_FADES_BY_DAYS = PLANNED_WEIGHS_FOR_DAYS;
const RECENCY_PENALTY = 3;
/** A main protein shouldn't come back within 3 consecutive dinners: 2 days either side. */
const PROTEIN_WITHIN_DAYS = 2;
const PROTEIN_PENALTY = 2;
const CUISINE_PENALTY = 1.5;
const RATING_SCORE = { again: 2, meh: -1 } as const;
const IMPORTED_PREFERENCE_SCORE = { positive: 1, negative: -1 } as const;
/** Per person who dislikes something in it. */
const DISLIKE_PENALTY = 2;
/** Per "use it up" Item it uses. */
const USE_UP_BONUS = 1.5;
/** The choice is made among the Recipes scoring less than this below the best, at most `MOST_CHOICES` of them. */
const CHOICE_WINDOW = 1.5;
const MOST_CHOICES = 5;
/** How many seeds a re-roll tries for a Proposal that differs from the Week as it is. */
const REROLL_TRIES = 50;

/** Kinds of Slot decided by hand that a Proposal never replaces: they hold no Recipe to choose. */
const KEPT_KINDS: readonly SlotKind[] = ["leftovers", "eat_out", "skip"];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Proposes the Week's dinners. Locked Slots, cooked dinners, and dinners decided by hand as Leftovers,
 * eating out or no meal, are kept. Recurring Recipes are pinned first. Every other dinner gets a
 * Recipe that no Hard Constraint of anyone eating it rules out (unknown Allergens fail closed), not
 * rated "never", not planned within 2 weeks of it and within the day's Effort Budget (an unknown
 * effort passes).
 * Among those, it is chosen with the seed from the best scoring, for recency, variety, Ratings,
 * Imported Preference, dislikes and "use it up" Items (or from any of them, for the choice "any").
 * The same input, seed and choice always give the same Proposal.
 */
export function proposeWeek(input: ProposerInput): Proposal {
  const choice = input.choice ?? "best";
  return propose(input, choice === "best" ? CHOICE_WINDOW : Number.POSITIVE_INFINITY, choice);
}

/**
 * Proposes the Week again with a new seed: the next after `input.seed` whose Proposal differs from
 * the dinners as they are, if one of the next few does. When the best-scoring Recipes leave no other
 * choice, it chooses from every Recipe that passes the rules instead. Locked Slots are kept, as by
 * `proposeWeek`.
 */
export function rerollWeek(input: ProposerInput): Proposal {
  for (const choice of ["best", "any"] as const) {
    for (let tries = 1; tries <= REROLL_TRIES; tries++) {
      const proposal = proposeWeek({ ...input, seed: input.seed + tries, choice });
      if (!isUnchanged(proposal, input.dinners)) return proposal;
    }
  }
  return proposeWeek({ ...input, seed: input.seed + 1, choice: "best" });
}

/** Proposes the Week, choosing for each dinner among the candidates scoring less than `window` below the best. */
function propose(input: ProposerInput, window: number, choice: ProposalChoice): Proposal {
  const random = seededRandom(input.seed);
  const recipes = new Map(input.recipes.map((recipe) => [recipe.id, recipe]));
  const weekDates = new Set(input.dinners.map((dinner) => dinner.date));
  const proposed: (ProposedDinner | undefined)[] = input.dinners.map(settled);
  const planned = () => [
    ...input.history,
    ...proposed.flatMap((dinner) =>
      dinner?.recipeId != null ? [{ recipeId: dinner.recipeId, date: dinner.date }] : [],
    ),
  ];
  const open = (index: number) => proposed[index] === undefined;

  // Recurring Recipes come first, those for a weekday before those for any day of the Week.
  const recurring = input.recipes
    .filter((recipe) => recipe.recurring !== null)
    .sort((a, b) => Number(a.recurring === "weekly") - Number(b.recurring === "weekly") || a.id - b.id);
  for (const recipe of recurring) {
    const { recurring: recurrence } = recipe;
    if (recurrence === null) continue;
    if (planned().some((other) => other.recipeId === recipe.id && weekDates.has(other.date))) continue;
    const fits = input.dinners.flatMap((dinner, index) =>
      open(index) &&
      isSafe(recipe, dinner) &&
      (recurrence === "weekly" || weekdayOf(dinner.date) === recurrence.weekday)
        ? [index]
        : [],
    );
    const withinBudget = fits.filter((index) => isWithinBudget(recipe, budgetOf(input, index)));
    const index = pick(withinBudget.length > 0 ? withinBudget : fits, random);
    if (index === undefined) continue;
    proposed[index] = {
      date: (input.dinners[index] as ProposerDinner).date,
      kind: "recipe",
      recipeId: recipe.id,
      reason: { kind: "recurring", recurrence },
    };
  }

  input.dinners.forEach((dinner, index) => {
    if (!open(index)) return;
    const budget = budgetOf(input, index);
    const excluded: Exclusions = { conflict: 0, never: 0, recent: 0, effort: 0 };
    const candidates: { recipe: ProposerRecipe; score: number; factors: ReasonFactor[] }[] = [];
    const nearby = planned();
    for (const recipe of input.recipes) {
      const daysApart = closestPlanned(recipe.id, dinner.date, nearby);
      if (!isSafe(recipe, dinner)) excluded.conflict++;
      else if (recipe.ratings.includes("never")) excluded.never++;
      else if (daysApart !== null && daysApart < EXCLUDED_WITHIN_DAYS) excluded.recent++;
      else if (!isWithinBudget(recipe, budget)) excluded.effort++;
      else candidates.push({ recipe, ...scored(recipe, dinner, daysApart, budget, nearby, recipes, input.useUp) });
    }
    candidates.sort((a, b) => b.score - a.score || a.recipe.id - b.recipe.id);
    const best = candidates[0]?.score ?? 0;
    const choices = candidates.filter((candidate) => candidate.score > best - window).slice(0, MOST_CHOICES);
    const chosen = pick(choices, random);
    proposed[index] = chosen
      ? {
          date: dinner.date,
          kind: "recipe",
          recipeId: chosen.recipe.id,
          reason: { kind: "chosen", candidates: candidates.length, factors: chosen.factors },
        }
      : { date: dinner.date, kind: "unplanned", recipeId: null, reason: { kind: "no_candidate", excluded } };
  });

  return { seed: input.seed, choice, dinners: proposed as ProposedDinner[] };
}

function isUnchanged(proposal: Proposal, dinners: ProposerDinner[]): boolean {
  return proposal.dinners.every(
    (dinner, index) => dinner.kind === dinners[index]?.kind && dinner.recipeId === dinners[index]?.recipeId,
  );
}

/** A dinner the Proposal leaves as it is, with why; undefined for one it fills. */
function settled(dinner: ProposerDinner): ProposedDinner | undefined {
  const as = (reason: ProposalReason): ProposedDinner => ({
    date: dinner.date,
    kind: dinner.kind,
    recipeId: dinner.recipeId,
    reason,
  });
  if (dinner.cooked) return as({ kind: "cooked" });
  if (dinner.locked) return as({ kind: "locked" });
  if (KEPT_KINDS.includes(dinner.kind)) return as({ kind: "kept" });
  if (dinner.diners.length + dinner.guests === 0) {
    return { date: dinner.date, kind: "unplanned", recipeId: null, reason: { kind: "nobody_eating" } };
  }
  return undefined;
}

function budgetOf(input: ProposerInput, index: number): number {
  return input.effortBudgets[weekdayOf((input.dinners[index] as ProposerDinner).date)];
}

/** No Hard Constraint of anyone eating the dinner conflicts with the Recipe, not even an Override could. */
function isSafe(recipe: ProposerRecipe, dinner: ProposerDinner): boolean {
  return slotConflicts({ allergens: recipe.allergens, ...dinner }).length === 0;
}

function isWithinBudget(recipe: ProposerRecipe, budget: number): boolean {
  return recipe.effortMinutes === null || recipe.effortMinutes <= budget;
}

/** How many days from `date` the Recipe is planned nearest, before or after; null if it is not. */
function closestPlanned(
  recipeId: RecipeId,
  date: LocalDate,
  planned: { recipeId: RecipeId; date: LocalDate }[],
): number | null {
  const apart = planned.filter((other) => other.recipeId === recipeId).map((other) => daysBetween(date, other.date));
  return apart.length > 0 ? Math.min(...apart) : null;
}

function daysBetween(a: LocalDate, b: LocalDate): number {
  return Math.round(Math.abs(Date.parse(a) - Date.parse(b)) / DAY_MS);
}

function scored(
  recipe: ProposerRecipe,
  dinner: ProposerDinner,
  daysApart: number | null,
  budget: number,
  planned: { recipeId: RecipeId; date: LocalDate }[],
  recipes: Map<RecipeId, ProposerRecipe>,
  useUp: ItemId[],
): { score: number; factors: ReasonFactor[] } {
  let score = 0;
  const recent = daysApart !== null && daysApart < RECENCY_FADES_BY_DAYS;
  if (recent) {
    score -= (RECENCY_PENALTY * (RECENCY_FADES_BY_DAYS - daysApart)) / (RECENCY_FADES_BY_DAYS - EXCLUDED_WITHIN_DAYS);
  }
  const factors: ReasonFactor[] = [
    { kind: "recency", daysApart: recent ? daysApart : null },
    { kind: "effort", minutes: recipe.effortMinutes, budget },
  ];

  const rating = recipe.ratings.at(-1);
  if (rating === "again" || rating === "meh") {
    score += RATING_SCORE[rating];
    factors.push({ kind: "rating", rating });
  }
  if (recipe.importedPreference) {
    score += IMPORTED_PREFERENCE_SCORE[recipe.importedPreference];
    factors.push({ kind: "imported_preference", preference: recipe.importedPreference });
  }

  const usesUp = useUp.filter((item) => recipe.ingredients.some((ingredient) => ingredient.item === item));
  if (usesUp.length > 0) {
    score += USE_UP_BONUS * usesUp.length;
    factors.push({ kind: "uses_up", items: usesUp });
  }

  const dislikedBy = whoDislikes(recipe, dinner);
  if (dislikedBy.length > 0) {
    score -= DISLIKE_PENALTY * dislikedBy.length;
    factors.push({ kind: "disliked", by: dislikedBy });
  }

  const near = (days: number) =>
    planned.flatMap((other) => {
      const apart = daysBetween(dinner.date, other.date);
      const neighbour = recipes.get(other.recipeId);
      return apart > 0 && apart <= days && neighbour ? [neighbour] : [];
    });
  const protein = recipe.mainProtein;
  if (protein && near(PROTEIN_WITHIN_DAYS).some((other) => sameTag(other.mainProtein, protein))) {
    score -= PROTEIN_PENALTY;
    factors.push({ kind: "repeats_protein", protein });
  }
  const cuisine = recipe.cuisine;
  if (cuisine && near(1).some((other) => sameTag(other.cuisine, cuisine))) {
    score -= CUISINE_PENALTY;
    factors.push({ kind: "repeats_cuisine", cuisine });
  }

  return { score, factors };
}

function sameTag(a: string | null, b: string): boolean {
  return a !== null && a.toLowerCase() === b.toLowerCase();
}

/**
 * Who eating the dinner has a dislike the Recipe matches: an Allergen it contains (or is known to,
 * when unknown), or a term in its title or an Ingredient line.
 */
function whoDislikes(recipe: ProposerRecipe, dinner: ProposerDinner): ConflictWho[] {
  const eating: [ConflictWho, Constraint[]][] = dinner.diners.map((diner) => [diner.id, diner.constraints]);
  if (dinner.guests > 0) eating.push(["guests", dinner.guestConstraints]);
  const contained: Allergen[] =
    recipe.allergens.kind === "known" ? recipe.allergens.allergens : recipe.allergens.atLeast;
  const text = [recipe.title, ...recipe.ingredients.map((ingredient) => ingredient.raw)].join("\n").toLowerCase();
  return eating.flatMap(([who, constraints]) =>
    constraints.some(
      (constraint) =>
        constraint.kind === "dislike" &&
        ((constraint.allergen !== undefined && contained.includes(constraint.allergen)) ||
          (constraint.term !== undefined && text.includes(constraint.term.toLowerCase()))),
    )
      ? [who]
      : [],
  );
}

function pick<T>(from: T[], random: () => number): T | undefined {
  return from[Math.floor(random() * from.length)];
}

/** Mulberry32: a small, fast generator whose sequence depends only on the seed. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
