import { type ConflictWho, slotConflicts } from "./conflicts";
import type { EffortBudgets } from "./household";
import type { ItemId } from "./items";
import type { Allergen, Constraint, Member } from "./members";
import type { Exclusions, ProposalChoice, ProposalReason, Rating, ReasonFactor } from "./proposals";
import type { Recipe, RecipeId } from "./recipes";
import { isEaten, type LocalDate, type SlotKind, weekdayOf } from "./weeks";

/** Who eats a Slot, as far as Hard Constraints go. */
export type ProposerPeople = {
  diners: Pick<Member, "id" | "constraints">[];
  guests: number;
  guestConstraints: Constraint[];
};

/** A dinner of the Week as the Proposer finds it. */
export type ProposerDinner = ProposerPeople & {
  date: LocalDate;
  kind: SlotKind;
  recipeId: RecipeId | null;
  /** Marked cooked: what was eaten stays as it was. */
  cooked: boolean;
  /** The dinner it is Leftovers of, when it is linked to one. */
  leftoversOf: LocalDate | null;
  /**
   * A pencilled dinner: it has a reason, so a Proposal may change it. Every other dinner but an
   * unplanned one is the Household's own, which no Proposal changes (ADR 0030).
   */
  pencilled: boolean;
  /**
   * Who eats each of its Leftovers linked by hand, at any meal; none when it has none. They eat what it
   * is cooked, so they count as eating it. A dinner with any gets no more Leftovers, and none are placed
   * in it.
   */
  leftoversLinkedByHand: ProposerPeople[];
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
  | "course"
  | "recurring"
  | "yieldsLeftovers"
  | "importedPreference"
  | "draft"
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

export type ProposedDinner = {
  date: LocalDate;
  kind: SlotKind;
  recipeId: RecipeId | null;
  /** The dinner it is Leftovers of, when it is linked to one. */
  leftoversOf: LocalDate | null;
  /** Why it was filled as it was; null for a dinner left as it is, whose reason (or lack of one) stays. */
  reason: ProposalReason | null;
};

/**
 * The seed and choice it was made with: given them again, with the same input, it comes out the same.
 * `changed` says whether any dinner's kind, Recipe or Leftovers link differs from the dinners it was
 * given; a reason alone is no change.
 */
export type Proposal = { seed: number; choice: ProposalChoice; dinners: ProposedDinner[]; changed: boolean };

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
/** Leftovers go in a dinner at most this many days after the one cooked for them. */
const LEFTOVERS_WITHIN_DAYS = 2;
/** How many seeds a re-roll tries for a Proposal that differs from the Week as it is. */
const REROLL_TRIES = 50;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Proposes the Week's dinners. Cooked dinners and the Household's own are settled: left as they are,
 * with no reason written, and counted for recency. Recurring Recipes are pinned first.
 * Every pencilled and unplanned dinner gets a Recipe that no Hard Constraint of anyone eating it, its
 * Leftovers linked by hand included, rules out (unknown Allergens fail closed), not rated "never", not
 * planned within 2 weeks of it and within the day's Effort Budget (an unknown effort passes). Leftovers are still placed after a settled
 * dinner not yet cooked. Every Recipe a dinner gets, Recurring, Leftovers or not, is a main dish or of
 * unknown Course (ADR 0022), and no Draft.
 * Among those, it is chosen with the seed from the best scoring, for recency, variety, Ratings,
 * Imported Preference, dislikes and "use it up" Items (or from any of them, for the choice "any").
 * A dinner whose Recipe yields Leftovers, and has none linked by hand, gets them in the next dinner
 * within two days that is still to fill, has no Leftovers linked by hand itself and is eaten by the
 * same Diners, if its Recipe is safe for them. A dinner with Leftovers linked by hand is the
 * Household's own (ADR 0030) until it is handed back to Mise, so what they are of changes only then.
 * The same input, seed and choice always give the same Proposal.
 */
export function proposeWeek(input: ProposerInput): Proposal {
  const choice = input.choice ?? "best";
  return propose(input, choice === "best" ? CHOICE_WINDOW : Number.POSITIVE_INFINITY, choice);
}

/**
 * Proposes the Week again with a new seed: the next after `input.seed` whose Proposal differs from
 * the dinners as they are, if one of the next few does. When the best-scoring Recipes leave no other
 * choice, it chooses from every Recipe that passes the rules instead. Settled dinners are kept, as by
 * `proposeWeek`. When no seed changes a dinner, it is not `changed`: every dinner is left as it is,
 * with no reason written, and the seed and choice stay `input`'s, so the Week can be left untouched.
 */
export function rerollWeek(input: ProposerInput): Proposal {
  for (const choice of ["best", "any"] as const) {
    for (let tries = 1; tries <= REROLL_TRIES; tries++) {
      const proposal = proposeWeek({ ...input, seed: input.seed + tries, choice });
      if (proposal.changed) return proposal;
    }
  }
  return { seed: input.seed, choice: input.choice ?? "best", dinners: input.dinners.map(asItIs), changed: false };
}

/** Proposes the Week, choosing for each dinner among the candidates scoring less than `window` below the best. */
function propose(given: ProposerInput, window: number, choice: ProposalChoice): Proposal {
  // A Draft is not a Recipe to plan until a person accepts it, so it is no candidate at all.
  const input = { ...given, recipes: given.recipes.filter((recipe) => !recipe.draft) };
  const random = seededRandom(input.seed);
  const recipes = new Map(input.recipes.map((recipe) => [recipe.id, recipe]));
  const proposed: (ProposedDinner | undefined)[] = input.dinners.map(settled);
  const planned = () => [
    ...input.history,
    ...proposed.flatMap((dinner) =>
      dinner?.recipeId != null ? [{ recipeId: dinner.recipeId, date: dinner.date }] : [],
    ),
  ];
  const open = (index: number) => proposed[index] === undefined;

  pinRecurring(input, proposed, open, planned, random);

  // In date order, so that a dinner's Leftovers are placed before the dinners after it are chosen.
  input.dinners.forEach((_, index) => {
    if (open(index)) proposed[index] = chosen(input, index, planned(), recipes, window, random);
    placeLeftovers(input, index, proposed, recipes);
  });

  return proposal(input, choice, proposed as ProposedDinner[]);
}

/**
 * Proposes one dinner of the Week again, handed back to Mise ("Let Mise choose"), from the Week's seed
 * and choice, by the rules of `proposeWeek`: a Recurring Recipe due on it is pinned to it, and otherwise
 * it gets a Recipe other than the one it had, if another fits. Every other dinner counts for recency and
 * is left as it is, with no reason written, but for the Leftovers of this one: those the last Proposal
 * placed are proposed again with it, and its Recipe's go in the next dinner within two days that is
 * still unplanned, as `proposeWeek` places them. A cooked dinner is left as it is.
 * The same input and date always give the same Proposal.
 */
export function proposeDinner(given: ProposerInput, date: LocalDate): Proposal {
  const choice = given.choice ?? "best";
  const window = choice === "best" ? CHOICE_WINDOW : Number.POSITIVE_INFINITY;
  const input = { ...given, recipes: given.recipes.filter((recipe) => !recipe.draft) };
  const random = seededRandom(input.seed);
  const recipes = new Map(input.recipes.map((recipe) => [recipe.id, recipe]));
  const target = input.dinners.findIndex((dinner) => dinner.date === date);
  const dinner = input.dinners[target];
  /** Leftovers of this dinner the last Proposal placed, which go with it. */
  const itsLeftovers = (other: ProposerDinner) =>
    other.pencilled && other.kind === "leftovers" && other.leftoversOf === date;
  // Another dinner still unplanned is open to this one's Leftovers, but is not filled itself.
  const proposed: (ProposedDinner | undefined)[] = input.dinners.map((other, index) =>
    index === target || itsLeftovers(other) || (other.kind === "unplanned" && settled(other) === undefined)
      ? undefined
      : asItIs(other),
  );
  const planned = () => [
    ...input.history,
    ...proposed.flatMap((other) => (other?.recipeId != null ? [{ recipeId: other.recipeId, date: other.date }] : [])),
  ];

  if (dinner) {
    if (dinner.cooked) proposed[target] = asItIs(dinner);
    else proposed[target] = settled({ ...dinner, kind: "unplanned", pencilled: true });
    pinRecurring(input, proposed, (index) => index === target && proposed[index] === undefined, planned, random);
    proposed[target] ??= chosen(input, target, planned(), recipes, window, random, dinner.recipeId);
    placeLeftovers(input, target, proposed, recipes);
    input.dinners.forEach((other, index) => {
      if (proposed[index] === undefined && itsLeftovers(other))
        proposed[index] = chosen(input, index, planned(), recipes, window, random);
    });
  }
  const dinners = proposed.map((other, index) => other ?? asItIs(input.dinners[index] as ProposerDinner));
  return proposal(input, choice, dinners);
}

/** The Proposal of `dinners`, made from `input` with its seed and `choice`. */
function proposal(input: ProposerInput, choice: ProposalChoice, dinners: ProposedDinner[]): Proposal {
  return { seed: input.seed, choice, dinners, changed: changesDinners(dinners, input.dinners) };
}

/**
 * Pins Recurring Recipes into the dinners `open` allows, those for a weekday before those for any day of
 * the Week, unless the Week already plans them. One rated "never" is ruled out of a Proposal like any
 * other Recipe (ADR 0014).
 */
function pinRecurring(
  input: ProposerInput,
  proposed: (ProposedDinner | undefined)[],
  open: (index: number) => boolean,
  planned: () => { recipeId: RecipeId; date: LocalDate }[],
  random: () => number,
): void {
  const weekDates = new Set(input.dinners.map((dinner) => dinner.date));
  const recurring = input.recipes
    .filter((recipe) => recipe.recurring !== null && !recipe.ratings.includes("never"))
    .sort((a, b) => Number(a.recurring === "weekly") - Number(b.recurring === "weekly") || a.id - b.id);
  for (const recipe of recurring) {
    const { recurring: recurrence } = recipe;
    if (recurrence === null) continue;
    if (planned().some((other) => other.recipeId === recipe.id && weekDates.has(other.date))) continue;
    const fits = input.dinners.flatMap((dinner, index) =>
      open(index) &&
      canFillDinner(recipe) &&
      isSafe(recipe, eating(dinner)) &&
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
      leftoversOf: null,
      reason: { kind: "recurring", recurrence },
    };
  }
}

/**
 * The Recipe chosen for the dinner at `index`, or none when no Recipe passes every rule; never `avoid`
 * when another passes them.
 */
function chosen(
  input: ProposerInput,
  index: number,
  nearby: { recipeId: RecipeId; date: LocalDate }[],
  recipes: Map<RecipeId, ProposerRecipe>,
  window: number,
  random: () => number,
  avoid: RecipeId | null = null,
): ProposedDinner {
  const dinner = input.dinners[index] as ProposerDinner;
  const people = eating(dinner);
  const budget = budgetOf(input, index);
  const excluded: Exclusions = { conflict: 0, never: 0, course: 0, recent: 0, effort: 0 };
  const candidates: { recipe: ProposerRecipe; score: number; factors: ReasonFactor[] }[] = [];
  for (const recipe of input.recipes) {
    const daysApart = closestPlanned(recipe.id, dinner.date, nearby);
    if (!isSafe(recipe, people)) excluded.conflict++;
    else if (recipe.ratings.includes("never")) excluded.never++;
    else if (!canFillDinner(recipe)) excluded.course++;
    else if (daysApart !== null && daysApart < EXCLUDED_WITHIN_DAYS) excluded.recent++;
    else if (!isWithinBudget(recipe, budget)) excluded.effort++;
    else
      candidates.push({ recipe, ...scored(recipe, dinner, people, daysApart, budget, nearby, recipes, input.useUp) });
  }
  candidates.sort((a, b) => b.score - a.score || a.recipe.id - b.recipe.id);
  const others = candidates.filter((candidate) => candidate.recipe.id !== avoid);
  const from = others.length > 0 ? others : candidates;
  const best = from[0]?.score ?? 0;
  const choices = from.filter((candidate) => candidate.score > best - window).slice(0, MOST_CHOICES);
  const choice = pick(choices, random);
  return choice
    ? {
        date: dinner.date,
        kind: "recipe",
        recipeId: choice.recipe.id,
        leftoversOf: null,
        reason: { kind: "chosen", candidates: candidates.length, factors: choice.factors },
      }
    : {
        date: dinner.date,
        kind: "unplanned",
        recipeId: null,
        leftoversOf: null,
        reason: { kind: "no_candidate", excluded },
      };
}

/**
 * Places the Leftovers of the dinner at `index`, if its Recipe yields them, it is not cooked yet and it has none linked
 * by hand: in the first dinner within two days after it that is still to fill and has no Leftovers linked to it by hand,
 * eaten by the same Diners, whose Guests (if any) its Recipe is safe for.
 */
function placeLeftovers(
  input: ProposerInput,
  index: number,
  proposed: (ProposedDinner | undefined)[],
  recipes: Map<RecipeId, ProposerRecipe>,
): void {
  const source = input.dinners[index] as ProposerDinner;
  const recipeId = proposed[index]?.recipeId;
  const recipe = recipeId == null ? undefined : recipes.get(recipeId);
  // What a dinner already cooked was cooked for is history.
  if (!recipe?.yieldsLeftovers || source.cooked || source.leftoversLinkedByHand.length > 0) return;
  // A dessert chosen by hand is no dinner the day after.
  if (!canFillDinner(recipe)) return;
  const diners = dinersKey(source);
  const at = input.dinners.findIndex(
    (dinner, other) =>
      other > index &&
      proposed[other] === undefined &&
      // A dinner cooked for Leftovers linked by hand must keep a Recipe of its own.
      dinner.leftoversLinkedByHand.length === 0 &&
      daysBetween(source.date, dinner.date) <= LEFTOVERS_WITHIN_DAYS &&
      dinersKey(dinner) === diners &&
      isSafe(recipe, dinner),
  );
  const dinner = input.dinners[at];
  if (!dinner) return;
  proposed[at] = {
    date: dinner.date,
    kind: "leftovers",
    recipeId: null,
    leftoversOf: source.date,
    reason: { kind: "leftovers", of: source.date },
  };
}

/** The Diners of a dinner as a key, the same for the same Diners in any order. */
function dinersKey(dinner: ProposerDinner): string {
  return dinner.diners
    .map((diner) => diner.id)
    .sort((a, b) => a - b)
    .join();
}

/** Whether any dinner proposed differs from the one it was in kind, Recipe or Leftovers link; a reason alone is no change. */
function changesDinners(proposed: ProposedDinner[], dinners: ProposerDinner[]): boolean {
  return proposed.some(
    (dinner, index) =>
      dinner.kind !== dinners[index]?.kind ||
      dinner.recipeId !== dinners[index]?.recipeId ||
      dinner.leftoversOf !== dinners[index]?.leftoversOf,
  );
}

/**
 * A dinner the Proposal leaves as it is, with no reason written; one it leaves unplanned because nobody
 * is eating it; undefined for one it fills.
 */
function settled(dinner: ProposerDinner): ProposedDinner | undefined {
  const own = !dinner.pencilled && dinner.kind !== "unplanned";
  if (dinner.cooked || own) return asItIs(dinner);
  if (!isEaten(dinner)) {
    return {
      date: dinner.date,
      kind: "unplanned",
      recipeId: null,
      leftoversOf: null,
      reason: { kind: "nobody_eating" },
    };
  }
  return undefined;
}

/** The dinner left as it is, with no reason written, so its reason (or lack of one) stays. */
function asItIs(dinner: ProposerDinner): ProposedDinner {
  return {
    date: dinner.date,
    kind: dinner.kind,
    recipeId: dinner.recipeId,
    leftoversOf: dinner.leftoversOf,
    reason: null,
  };
}

/** Who eats the dinner: its Diners and Guests, and whoever eats its Leftovers linked by hand. */
function eating(dinner: ProposerDinner): ProposerPeople {
  const everyone = [dinner, ...dinner.leftoversLinkedByHand];
  return {
    diners: [...new Map(everyone.flatMap((them) => them.diners).map((diner) => [diner.id, diner])).values()],
    guests: everyone.reduce((sum, them) => sum + them.guests, 0),
    guestConstraints: everyone.flatMap((them) => them.guestConstraints),
  };
}

function budgetOf(input: ProposerInput, index: number): number {
  return input.effortBudgets[weekdayOf((input.dinners[index] as ProposerDinner).date)];
}

/** No Hard Constraint of anyone eating the Slot conflicts with the Recipe, not even an Override could. */
function isSafe(recipe: ProposerRecipe, people: ProposerPeople): boolean {
  return slotConflicts({ allergens: recipe.allergens, ...people }).length === 0;
}

/** A main dish, or a Recipe whose Course is unknown: what a dinner can be filled with. */
function canFillDinner(recipe: ProposerRecipe): boolean {
  return recipe.course === null || recipe.course === "main";
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
  people: ProposerPeople,
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

  const dislikedBy = whoDislikes(recipe, people);
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
 * Who of `people` has a dislike the Recipe matches: an Allergen it contains (or is known to, when
 * unknown), or a term in its title or an Ingredient line.
 */
function whoDislikes(recipe: ProposerRecipe, people: ProposerPeople): ConflictWho[] {
  const eating: [ConflictWho, Constraint[]][] = people.diners.map((diner) => [diner.id, diner.constraints]);
  if (people.guests > 0) eating.push(["guests", people.guestConstraints]);
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
