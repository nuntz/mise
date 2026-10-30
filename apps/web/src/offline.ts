import {
  addDays,
  createTickQueue,
  currentWeek,
  GroceryList,
  Household,
  type HouseholdClock,
  type LocalDate,
  linkedRecipe,
  nextWeekStart,
  QueuedChange,
  Recipe,
  type RecipeId,
  type TickQueue,
  Week,
} from "@mise/domain";
import { onCleanup } from "solid-js";
import { z } from "zod";
import type { MiseClient } from "./client";
import { keepFresh } from "./fresh";

/*
 * What Mise keeps on this device for when the household can't be reached: the Household, the
 * current Week, the current and next Week's Grocery Lists, the Recipes planned in those two Weeks,
 * the last Recipe viewed, and the Grocery List changes not yet sent. The service worker caches the
 * app itself; the data comes over the WebSocket, which it can't see, so the page keeps it here.
 * Each is checked against its schema when read, so one saved by an older version of Mise is ignored
 * rather than shown wrong, unless it can be brought up to date.
 */

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** Saved before its week start could change: it never has. */
const SavedHousehold = z.preprocess(
  (saved) => (isObject(saved) && !("weekStartChanges" in saved) ? { ...saved, weekStartChanges: [] } : saved),
  Household,
);

/** Saved before a Recipe could be Ready-made (ADR 0026): it isn't. */
const notReadyMade = (recipe: unknown) =>
  isObject(recipe) && !("readyMade" in recipe) ? { ...recipe, readyMade: false } : recipe;

/** A saved Slot's Recipes, and its Leftovers' Recipe, as they are now. */
const slotUpToDate = (slot: unknown) =>
  isObject(slot)
    ? {
        ...slot,
        recipe: notReadyMade(slot.recipe),
        leftoversOf: isObject(slot.leftoversOf)
          ? { ...slot.leftoversOf, recipe: notReadyMade(slot.leftoversOf.recipe) }
          : slot.leftoversOf,
      }
    : slot;

/**
 * Saved before Weeks could run on past seven days: it is seven days long. Saved before Ready-made
 * dishes: none of its Recipes is one.
 */
const SavedWeek = z.preprocess((saved) => {
  if (!isObject(saved)) return saved;
  const slots = Array.isArray(saved.slots) ? saved.slots.map(slotUpToDate) : saved.slots;
  return !("endDate" in saved) && typeof saved.startDate === "string"
    ? { ...saved, slots, endDate: addDays(saved.startDate, 6) }
    : { ...saved, slots };
}, Week);

/** Saved before a Recipe could be Ready-made: it isn't. */
const SavedRecipe = z.preprocess(notReadyMade, Recipe);

const GroceryLists = z.record(z.string(), GroceryList.nullable());

/** Each checked on its own when read, so one that no longer fits leaves the others. */
const PlannedRecipes = z.record(z.string(), z.unknown());

const KEYS = {
  household: "mise.household",
  week: "mise.week",
  groceryLists: "mise.groceryLists",
  recipe: "mise.recipe",
  plannedRecipes: "mise.plannedRecipes",
  changes: "mise.changes",
} as const;

function read<T>(key: string, schema: z.ZodType<T>): T | undefined {
  try {
    const stored = localStorage.getItem(key);
    if (stored === null) return undefined;
    const parsed = schema.safeParse(JSON.parse(stored));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: Mise still works online, only not offline.
  }
}

export const savedHousehold = () => read(KEYS.household, SavedHousehold);
export const saveHousehold = (household: Household) => write(KEYS.household, household);

/** The current Week as last loaded, shown read-only while the household can't be reached. */
export const savedWeek = () => read(KEYS.week, SavedWeek);
export const saveWeek = (week: Week) => write(KEYS.week, week);

/** The Grocery List last loaded for the Week starting `date`: null if it had none, undefined if unknown. */
export const savedGroceryList = (date: LocalDate) => read(KEYS.groceryLists, GroceryLists)?.[date];

/** The last Recipe viewed. */
export const lastRecipe = () => read(KEYS.recipe, SavedRecipe);

function plannedRecipe(id: RecipeId): Recipe | undefined {
  const saved = read(KEYS.plannedRecipes, PlannedRecipes)?.[id];
  const parsed = SavedRecipe.safeParse(saved);
  return parsed.success && parsed.data.id === id ? parsed.data : undefined;
}

/** The Recipe `id` as last loaded, if it's planned in the current or next Week or was the last viewed. */
export function savedRecipe(id: RecipeId): Recipe | undefined {
  const recipe = lastRecipe();
  return recipe?.id === id ? recipe : plannedRecipe(id);
}
export const saveRecipe = (recipe: Recipe) => write(KEYS.recipe, recipe);

/** The current and next Week's first days: the Weeks whose Grocery Lists and Recipes are kept. */
function keptWeeks(household: HouseholdClock): LocalDate[] {
  const current = currentWeek(new Date(), household);
  return [current.startDate, nextWeekStart(current)];
}

/**
 * Keeps the current and next Week's Grocery Lists on this device, loaded again on every connect and
 * whenever anything they're built from changes.
 */
export function keepGroceryLists(client: MiseClient, household: () => HouseholdClock): void {
  // Offline, what was saved is kept.
  keepFresh(
    client,
    ["grocery", "plan", "recipes", "household"],
    async () =>
      Promise.all(
        keptWeeks(household()).map(async (date) => [date, await client.call("get_grocery_list", { date })] as const),
      ),
    (results) => {
      const lists: Record<string, GroceryList | null> = {};
      for (const [date, result] of results) if (result.ok) lists[date] = result.value;
      write(KEYS.groceryLists, lists);
    },
  );
}

/**
 * Keeps every Recipe planned in the current and next Week on this device, so any of them opens
 * offline, loaded again on every connect and whenever the plan or a Recipe changes. Each load
 * replaces what was kept, so a Recipe no longer planned goes; one that fails to load keeps its
 * earlier copy.
 */
export function keepPlannedRecipes(client: MiseClient, household: () => HouseholdClock): void {
  // Offline, or with either Week failing to load, what was saved is kept.
  keepFresh(
    client,
    ["plan", "recipes", "household"],
    async () => {
      const weeks = await Promise.all(
        keptWeeks(household()).map(async (date) => {
          const result = await client.call("get_week", { date });
          if (!result.ok) throw new Error(result.error.message);
          return result.value;
        }),
      );
      const ids = [...new Set(weeks.flatMap((week) => week.slots.flatMap(linkedRecipe)))];
      return Promise.all(
        ids.map(async (id) => {
          // One that times out is as one that fails: its earlier copy stands in.
          const result = await client.call("get_recipe", { id }).catch(() => undefined);
          return [id, result?.ok ? result.value : undefined] as const;
        }),
      );
    },
    (results) => {
      const recipes: Record<string, Recipe> = {};
      for (const [id, loaded] of results) {
        const recipe = loaded ?? plannedRecipe(id);
        if (recipe) recipes[id] = recipe;
      }
      write(KEYS.plannedRecipes, recipes);
    },
  );
}

/**
 * The queue of Have Ticks and added lines (see `createTickQueue`), kept on this device and sent
 * through `client`. It sends whenever the connection comes back, and at once while connected.
 */
export function createGroceryQueue(client: MiseClient): TickQueue {
  let online = true;
  // A send that timed out with the connection still open waits for no reconnect: try again now and then.
  const retry = setInterval(() => {
    if (online && queue.pending().length > 0) void queue.flush();
  }, 30_000);
  onCleanup(() => clearInterval(retry));
  const queue = createTickQueue({
    storage: {
      load: () => read(KEYS.changes, z.array(QueuedChange)) ?? [],
      save: (changes) => write(KEYS.changes, changes),
    },
    transport: {
      async setHaveTick(input) {
        return (await client.call("set_have_tick", input)).ok ? { ok: true } : { ok: false };
      },
      async addGroceryLine(input) {
        const result = await client.call("add_grocery_line", input);
        return result.ok ? { ok: true, line: result.value.id } : { ok: false };
      },
    },
  });
  onCleanup(
    queue.subscribe(() => {
      if (online && queue.pending().length > 0) void queue.flush();
    }),
  );
  onCleanup(
    client.onConnection((now) => {
      online = now;
      if (online) void queue.flush();
    }),
  );
  return queue;
}
