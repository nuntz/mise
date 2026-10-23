import { z } from "zod";
import { GroceryAmount } from "./grocery";
import { ItemId } from "./items";
import { RecipeId } from "./recipes";
import { localDate } from "./time";
import type { LocalDate } from "./weeks";

/** How a Staple stands: no quantities, just whether there's enough. */
export const STAPLE_STATUSES = ["stocked", "low", "out"] as const;
export const StapleStatus = z.enum(STAPLE_STATUSES);
export type StapleStatus = z.infer<typeof StapleStatus>;

/** How often a Staple is checked, in days; adapted by each check-in. */
export const CheckInterval = z.number().int().min(1).max(365);

/** Every so many days, or at every check-in ("every_shop"). */
export const CheckEvery = z.union([CheckInterval, z.literal("every_shop")]);
export type CheckEvery = z.infer<typeof CheckEvery>;

/** How often a new Staple is checked until its check-ins say otherwise. */
export const NEW_STAPLE_INTERVAL = 14;
const LONGEST_INTERVAL = 60;
const SHORTEST_INTERVAL = 3;

/** What a check-in reads and changes of a Staple. */
export type CheckedStaple = {
  checkEvery: CheckEvery;
  status: StapleStatus;
  /** When its status was last recorded; null if never. */
  lastChecked: string | null;
  /** How many check-ins in a row have found it out. */
  outInARow: number;
};

/**
 * The Staple once `status` is recorded for it at `at`. Its interval adapts, so Staples that stay
 * stocked stop being asked about: stocked stretches it by half (to 60 days at most), out halves it
 * (to 3 days at least), and low leaves it.
 */
export function recordStapleStatus<T extends CheckedStaple>(staple: T, status: StapleStatus, at: string): T {
  return {
    ...staple,
    status,
    lastChecked: at,
    checkEvery: staple.checkEvery === "every_shop" ? "every_shop" : adaptedInterval(staple.checkEvery, status),
    outInARow: status === "out" ? staple.outInARow + 1 : 0,
  };
}

function adaptedInterval(days: number, status: StapleStatus): number {
  if (status === "stocked") return Math.min(LONGEST_INTERVAL, Math.round(days * 1.5));
  if (status === "out") return Math.max(SHORTEST_INTERVAL, Math.round(days / 2));
  return days;
}

/** Where a Staple is kept, in the order a check-in walks them. */
export const STAPLE_LOCATIONS = ["pantry", "fridge", "freezer"] as const;
export const StapleLocation = z.enum(STAPLE_LOCATIONS);
export type StapleLocation = z.infer<typeof StapleLocation>;

/** Orders Staples by where they are kept, in the order a check-in walks them. */
export function byLocation(a: { location: StapleLocation }, b: { location: StapleLocation }): number {
  return STAPLE_LOCATIONS.indexOf(a.location) - STAPLE_LOCATIONS.indexOf(b.location);
}

/** After this many 'out' in a row, a Staple is worth always buying. */
const OUT_IN_A_ROW_FOR_ALWAYS_BUY = 3;

/** Whether to suggest always buying a Staple: it keeps running out, and isn't always bought already. */
export function suggestsAlwaysBuy(staple: { outInARow: number; alwaysBuy: boolean }): boolean {
  return !staple.alwaysBuy && staple.outInARow >= OUT_IN_A_ROW_FOR_ALWAYS_BUY;
}

/** What deciding which Staples are due reads of each. */
export type DueStaple = CheckedStaple & { name: string; location: StapleLocation; alwaysBuy: boolean };

/** The most Staples one check-in asks about. */
export const CHECK_IN_SIZE = 10;

/**
 * The Staples a check-in asks about on `today`, and how many are due in all. A Staple is due when
 * its interval has passed since it was last checked, by the Household's calendar, or it has never
 * been checked (it is then due from today, not overdue); or it is low or checked every shop and
 * hasn't been checked yet today. One always bought is never asked about.
 * A check-in asks about the 10 most overdue, pantry first, then fridge, then freezer, and within
 * each the most overdue first.
 */
export function dueStaples<T extends DueStaple>(
  staples: readonly T[],
  today: LocalDate,
  timezone: string,
): { due: number; staples: T[] } {
  const due = staples.flatMap((staple) => {
    if (staple.alwaysBuy) return [];
    const since = daysSinceChecked(staple, today, timezone);
    // Checked every shop: due again from the day after it was last checked.
    const interval = staple.checkEvery === "every_shop" ? 1 : staple.checkEvery;
    const overdue = since === null ? 0 : since - interval;
    const askAgain = staple.status === "low" && since !== null && since > 0;
    return overdue >= 0 || askAgain ? [{ staple, overdue }] : [];
  });
  const byOverdue = (a: (typeof due)[number], b: (typeof due)[number]) =>
    b.overdue - a.overdue || a.staple.name.localeCompare(b.staple.name);
  const asked = [...due]
    .sort(byOverdue)
    .slice(0, CHECK_IN_SIZE)
    .sort((a, b) => byLocation(a.staple, b.staple) || byOverdue(a, b));
  return { due: due.length, staples: asked.map(({ staple }) => staple) };
}

/** Days since the Staple was last checked, by the Household's calendar; null if never. */
function daysSinceChecked(staple: CheckedStaple, today: LocalDate, timezone: string): number | null {
  if (staple.lastChecked === null) return null;
  const checked = localDate(new Date(staple.lastChecked), timezone);
  return (Date.parse(today) - Date.parse(checked)) / DAY_MS;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** An Item the Household keeps on hand, checked by status rather than by quantity. One per Item. */
export const Staple = z.object({
  item: ItemId,
  /** The Item's name. */
  name: z.string(),
  location: StapleLocation,
  checkEvery: CheckEvery,
  /** Bought every shop, so never asked about. */
  alwaysBuy: z.boolean(),
  /** How much the Grocery List buys when it is due to be bought; null for no amount. */
  qtyPerShop: GroceryAmount.nullable(),
  status: StapleStatus,
  lastChecked: z.iso.datetime().nullable(),
  outInARow: z.number().int().nonnegative(),
  /** It has been out three check-ins in a row: worth always buying. */
  suggestAlwaysBuy: z.boolean(),
});
export type Staple = z.infer<typeof Staple>;

/**
 * Makes the Item a Staple, or changes the Staple it is. A new one is kept in the pantry, checked
 * every 14 days, stocked and not always bought, unless told otherwise; fields left out of a change
 * stay as they are.
 */
export const UpsertStapleInput = z
  .object({
    item: ItemId,
    location: StapleLocation.optional(),
    checkEvery: CheckEvery.optional(),
    alwaysBuy: z.boolean().optional(),
    qtyPerShop: GroceryAmount.nullable().optional(),
  })
  .strict();

/** The Item stops being a Staple. */
export const RemoveStapleInput = z.object({ item: ItemId }).strict();

/** Every Staple, or those `usedBy` the Recipe's Ingredients; by location, then name. */
export const ListStaplesInput = z.object({ usedBy: RecipeId.optional() }).strict();

/** The Staples a check-in asks about today, and how many are due in all. */
export const DueStaples = z.object({ due: z.number().int().nonnegative(), staples: z.array(Staple) });
export type DueStaples = z.infer<typeof DueStaples>;

/**
 * Records how the Staple stands as of `at` (now if left out), adapting how often it is checked. A
 * status recorded at or after `at` wins, so one synced late from offline changes nothing.
 */
export const RecordStapleStatusInput = z
  .object({ item: ItemId, status: StapleStatus, at: z.iso.datetime().optional() })
  .strict();
