import { z } from "zod";
import { prepAheadDue } from "./calendar";
import { Locale } from "./household";
import { scaledLine } from "./ingredients";
import type { Recipe, RecipeId } from "./recipes";
import { localDate, nextOccurrence, zonedTimestamp } from "./time";
import { addDays, MEALS, Meal, type Slot, SlotKind } from "./weeks";

/** Where a Kitchen Display reads its Day Sheet. It bypasses Access and carries a token instead. */
export const DAY_SHEET_PATH = "/kitchen-display/v1/day-sheet";

/** The token a Kitchen Display sends in `Authorization: Bearer <token>`, or null if it sends none. */
export function bearerToken(authorization: string | null): string | null {
  return /^Bearer ([A-Za-z0-9_-]+)$/.exec(authorization ?? "")?.[1] ?? null;
}

export const KitchenDisplayId = z.number().int().positive();
export type KitchenDisplayId = z.infer<typeof KitchenDisplayId>;

/** A Kitchen Display paired to the Household: what a person calls it, never its token. */
export const KitchenDisplay = z.object({
  id: KitchenDisplayId,
  label: z.string().trim().min(1).max(60),
  addedAt: z.iso.datetime(),
  /** When it last read the Day Sheet; null until it first does. */
  lastUsedAt: z.iso.datetime().nullable(),
});
export type KitchenDisplay = z.infer<typeof KitchenDisplay>;

/** A Kitchen Display just added, with its token: shown this once, since only a hash is kept. */
export const NewKitchenDisplay = KitchenDisplay.extend({ token: z.string() });
export type NewKitchenDisplay = z.infer<typeof NewKitchenDisplay>;

export const AddKitchenDisplayInput = KitchenDisplay.pick({ label: true }).strict();
export const RevokeKitchenDisplayInput = z.object({ id: KitchenDisplayId }).strict();

/** How often a Kitchen Display is asked to fetch the Day Sheet again. */
const REFRESH_AFTER_SECONDS = 3600;

/** The most a Day Sheet takes as JSON, in bytes: what a Kitchen Display keeps. */
export const DAY_SHEET_MAX_BYTES = 64 * 1024;

/** The longest title a Day Sheet carries, in characters; a longer one is cut short with "…". */
const TITLE_MAX = 200;
const Title = z.string().min(1).max(TITLE_MAX);

/** What a Day Sheet prints in each locale, in Kitchen mode's words where it has them. */
const WORDS: Record<Locale, { scaled: string; asWritten: string; continued: string }> = {
  "en-CA": {
    scaled: "For {count}. The Recipe makes {base}.",
    asWritten: "For {count}, as the Recipe is written.",
    continued: "… continued in Mise",
  },
};

/** The earlier Slot Leftovers eat, named by its Recipe's title. */
export const DaySheetLeftoversOf = z.strictObject({ title: Title, date: z.iso.date(), meal: Meal });
export type DaySheetLeftoversOf = z.infer<typeof DaySheetLeftoversOf>;

/** A recipe Slot's Recipe, scaled to what the Slot is cooked for: every line ready to print. */
export const DaySheetRecipe = z.strictObject({ ingredients: z.array(z.string()), steps: z.array(z.string()) });
export type DaySheetRecipe = z.infer<typeof DaySheetRecipe>;

/** A Prep-ahead note due on the Day Sheet's date, for tomorrow's dinner. */
export const DaySheetPrepAhead = z.strictObject({ recipeTitle: Title, note: z.string() });
export type DaySheetPrepAhead = z.infer<typeof DaySheetPrepAhead>;

/**
 * One Slot as a Kitchen Display shows it. `needsReview` is the neutral Conflict marker: it says to
 * check the Slot in Mise, never who or what (nuntz/mise-display ADR 0001).
 */
export const DaySheetSlot = z.strictObject({
  meal: Meal,
  kind: SlotKind,
  cooked: z.boolean(),
  needsReview: z.boolean(),
  /** Only for a recipe Slot: its Recipe's title. */
  title: Title.optional(),
  /** Only for a recipe Slot: how many it is cooked for, Leftovers included, as Kitchen mode says it. */
  servingsText: z.string().optional(),
  /** Only for a recipe Slot. */
  recipe: DaySheetRecipe.optional(),
  /** Only for Leftovers: the earlier Slot they eat, with its Recipe's title; null when they eat nothing in particular. */
  leftoversOf: DaySheetLeftoversOf.nullable().optional(),
});
export type DaySheetSlot = z.infer<typeof DaySheetSlot>;

/**
 * A Household date for a Kitchen Display (schema 1). It carries nothing private: no Member or Diner
 * names, Allergens, Constraints, Guests, notes, Override reasons, Ratings, photos or URLs. Strict,
 * so a check against it finds any field added by mistake.
 */
export const DaySheet = z.strictObject({
  schemaVersion: z.literal(1),
  date: z.iso.date(),
  timezone: z.string(),
  locale: Locale,
  /** When it was made, with the Household's UTC offset then, so the display reads local times right on a day the clocks change. */
  generatedAt: z.iso.datetime({ offset: true }),
  refreshAfterSeconds: z.number().int().positive(),
  /** The next local midnight, when the date turns over. */
  nextDayAt: z.iso.datetime(),
  /** Breakfast, lunch and dinner, always, in that order. */
  slots: z.array(DaySheetSlot).length(MEALS.length),
  /** The Prep-ahead notes due on `date`, as the Calendar Feed shows them that day. */
  prepAhead: z.array(DaySheetPrepAhead),
});
export type DaySheet = z.infer<typeof DaySheet>;

export type DaySheetInput = {
  household: { timezone: string; locale: Locale };
  /** The Household's stored Slots on its date at `now` and the day after; a meal with none is unplanned. */
  slots: Slot[];
  /** The Recipe of each recipe Slot on its date. */
  recipes: ReadonlyMap<RecipeId, SheetRecipe>;
  /** The Prep-ahead note of each Recipe that has one. */
  prepAhead: ReadonlyMap<RecipeId, string>;
  now: Date;
};

type SheetRecipe = Pick<Recipe, "baseServings" | "ingredients" | "steps">;

/**
 * The Day Sheet for the Household's date at `now`, at most `DAY_SHEET_MAX_BYTES` as JSON: past that,
 * the Recipes' lines are cut short (`capped`).
 */
export function daySheet({ household, slots, recipes, prepAhead, now }: DaySheetInput): DaySheet {
  const { timezone, locale } = household;
  const date = localDate(now, timezone);
  const tomorrow = addDays(date, 1);
  return capped(
    {
      schemaVersion: 1,
      date,
      timezone,
      locale,
      generatedAt: zonedTimestamp(now, timezone),
      refreshAfterSeconds: REFRESH_AFTER_SECONDS,
      nextDayAt: `${nextOccurrence(now, "00:00", timezone).toISOString().slice(0, 19)}Z`,
      slots: MEALS.map((meal) =>
        sheetSlot(
          meal,
          slots.find((slot) => slot.date === date && slot.meal === meal),
          recipes,
          locale,
        ),
      ),
      prepAhead: slots.flatMap((slot) => {
        const note = slot.date === tomorrow ? prepAheadDue(slot, prepAhead) : undefined;
        return note && slot.recipe ? [{ recipeTitle: shortTitle(slot.recipe.title), note }] : [];
      }),
    },
    WORDS[locale].continued,
  );
}

function sheetSlot(
  meal: Meal,
  slot: Slot | undefined,
  recipes: ReadonlyMap<RecipeId, SheetRecipe>,
  locale: Locale,
): DaySheetSlot {
  if (!slot) return { meal, kind: "unplanned", cooked: false, needsReview: false };
  const shown: DaySheetSlot = {
    meal,
    kind: slot.kind,
    cooked: slot.cookedAt !== null,
    needsReview: slot.conflicts.length > 0,
  };
  const recipe = slot.kind === "recipe" && slot.recipe ? recipes.get(slot.recipe.id) : undefined;
  if (slot.kind === "recipe" && slot.recipe && !recipe) return { ...shown, title: shortTitle(slot.recipe.title) };
  if (slot.recipe && recipe) {
    // A Slot nobody eats is cooked as the Recipe is written, as in Kitchen mode.
    const cookFor = slot.cookFor || recipe.baseServings;
    const words = WORDS[locale];
    return {
      ...shown,
      title: shortTitle(slot.recipe.title),
      servingsText: (cookFor === recipe.baseServings ? words.asWritten : words.scaled)
        .replace("{count}", String(cookFor))
        .replace("{base}", String(recipe.baseServings)),
      recipe: {
        ingredients: recipe.ingredients.map((line) => scaledLine(line, cookFor / recipe.baseServings, locale)),
        steps: recipe.steps,
      },
    };
  }
  if (slot.kind === "leftovers") return { ...shown, leftoversOf: leftoversOf(slot) };
  return shown;
}

/** The earlier Slot Leftovers eat, if it still holds a Recipe to name. */
function leftoversOf(slot: Slot): DaySheetLeftoversOf | null {
  const of = slot.leftoversOf;
  return of?.recipe ? { title: shortTitle(of.recipe.title), date: of.date, meal: of.meal } : null;
}

function shortTitle(title: string): string {
  return title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1).trimEnd()}…` : title;
}

/**
 * `sheet` cut down to `DAY_SHEET_MAX_BYTES` as JSON, by its Recipes' lines (Ingredients, then
 * steps). Each Recipe gets an even share of the room left, and one that needs less passes the rest
 * on. The line that would breach a share is cut short, ending in `continued`, and the lines after it
 * are dropped.
 */
function capped(sheet: DaySheet, continued: string): DaySheet {
  const recipes = sheet.slots.flatMap((slot) => (slot.recipe ? [slot.recipe] : []));
  const empty = {
    ...sheet,
    slots: sheet.slots.map((slot) => (slot.recipe ? { ...slot, recipe: { ingredients: [], steps: [] } } : slot)),
  };
  let room = DAY_SHEET_MAX_BYTES - bytes(JSON.stringify(empty));
  // Each line costs its JSON and a comma (one too many per list: a byte to spare).
  const cost = (line: string) => bytes(JSON.stringify(line)) + 1;
  const total = (recipe: DaySheetRecipe) =>
    [...recipe.ingredients, ...recipe.steps].reduce((sum, line) => sum + cost(line), 0);
  if (recipes.reduce((sum, recipe) => sum + total(recipe), 0) <= room) return sheet;

  const fitted = new Map<DaySheetRecipe, DaySheetRecipe>();
  const smallestFirst = [...recipes].sort((a, b) => total(a) - total(b));
  smallestFirst.forEach((recipe, index) => {
    let share = Math.floor(room / (smallestFirst.length - index));
    room -= share;
    const fit = (lines: string[]) => {
      const kept: string[] = [];
      for (const line of lines) {
        if (cost(line) <= share) {
          kept.push(line);
          share -= cost(line);
          continue;
        }
        const cut = cutShort(line, continued, share - 1);
        if (cut) kept.push(cut);
        share = -1;
        break;
      }
      return kept;
    };
    const ingredients = fit(recipe.ingredients);
    const steps = share < 0 ? [] : fit(recipe.steps);
    room += Math.max(share, 0);
    fitted.set(recipe, { ingredients, steps });
  });
  return {
    ...sheet,
    slots: sheet.slots.map((slot) => (slot.recipe ? { ...slot, recipe: fitted.get(slot.recipe) } : slot)),
  };
}

/** As much of `line` as fits in `room` bytes of JSON, cut at a word and ending in `continued`; null if none does. */
function cutShort(line: string, continued: string, room: number): string | null {
  const characters = Array.from(line);
  const ending = (length: number) => {
    const start = characters.slice(0, length).join("");
    // A start that ends inside a word goes back to the word before; a first word too long is cut.
    const inWord = length < characters.length && /\S/.test(characters[length] ?? "");
    const word = inWord ? start.replace(/\s+\S*$/, "") : start;
    return `${(/\s/.test(start) ? word : start).trimEnd()} ${continued}`;
  };
  // The longest start that fits, found by halving.
  let [low, high] = [0, characters.length];
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (bytes(JSON.stringify(ending(middle))) <= room) low = middle;
    else high = middle - 1;
  }
  return low > 0 && bytes(JSON.stringify(ending(low))) <= room ? ending(low) : null;
}

function bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}
