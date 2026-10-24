import {
  addDays,
  createTickQueue,
  currentWeek,
  GroceryList,
  Household,
  type LocalDate,
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
 * current Week, the current and next Week's Grocery Lists, the last Recipe viewed, and the Grocery
 * List changes not yet sent. The service worker caches the app itself; the data comes over the WebSocket, which it
 * can't see, so the page keeps it here. Each is checked against its schema when read, so one saved
 * by an older version of Mise is ignored rather than shown wrong, unless it can be brought up to date.
 */

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** Saved before its week start could change: it never has. */
const SavedHousehold = z.preprocess(
  (saved) => (isObject(saved) && !("weekStartChanges" in saved) ? { ...saved, weekStartChanges: [] } : saved),
  Household,
);

/** Saved before Weeks could run on past seven days: it is seven days long. */
const SavedWeek = z.preprocess(
  (saved) =>
    isObject(saved) && !("endDate" in saved) && typeof saved.startDate === "string"
      ? { ...saved, endDate: addDays(saved.startDate, 6) }
      : saved,
  Week,
);

const GroceryLists = z.record(z.string(), GroceryList.nullable());

const KEYS = {
  household: "mise.household",
  week: "mise.week",
  groceryLists: "mise.groceryLists",
  recipe: "mise.recipe",
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

/** The last Recipe viewed, if it is the one asked for. */
export const lastRecipe = () => read(KEYS.recipe, Recipe);
export function savedRecipe(id: RecipeId): Recipe | undefined {
  const recipe = lastRecipe();
  return recipe?.id === id ? recipe : undefined;
}
export const saveRecipe = (recipe: Recipe) => write(KEYS.recipe, recipe);

/**
 * Keeps the current and next Week's Grocery Lists on this device, loaded again on every connect and
 * whenever anything they're built from changes.
 */
export function keepGroceryLists(
  client: MiseClient,
  household: () => Pick<Household, "timezone" | "weekStartsOn" | "weekStartChanges">,
): void {
  // Offline, what was saved is kept.
  keepFresh(
    client,
    ["grocery", "plan", "recipes", "household"],
    async () => {
      const current = currentWeek(new Date(), household().timezone, household());
      return Promise.all(
        [current.startDate, nextWeekStart(current)].map(
          async (date) => [date, await client.call("get_grocery_list", { date })] as const,
        ),
      );
    },
    (results) => {
      const lists: Record<string, GroceryList | null> = {};
      for (const [date, result] of results) if (result.ok) lists[date] = result.value;
      write(KEYS.groceryLists, lists);
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
