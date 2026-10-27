import { z } from "zod";
import { Locale } from "./household";
import { localDate, nextOccurrence, zonedTimestamp } from "./time";
import { MEALS, Meal, type Slot, SlotKind } from "./weeks";

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

/** The earlier Slot Leftovers eat, named by its Recipe's title. */
export const DaySheetLeftoversOf = z.strictObject({ title: z.string(), date: z.iso.date(), meal: Meal });
export type DaySheetLeftoversOf = z.infer<typeof DaySheetLeftoversOf>;

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
  title: z.string().optional(),
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
});
export type DaySheet = z.infer<typeof DaySheet>;

export type DaySheetInput = {
  household: { timezone: string; locale: Locale };
  /** The Household's stored Slots on its date at `now`; a meal with none is unplanned. */
  slots: Slot[];
  now: Date;
};

/** The Day Sheet for the Household's date at `now`. */
export function daySheet({ household, slots, now }: DaySheetInput): DaySheet {
  const { timezone, locale } = household;
  const date = localDate(now, timezone);
  return {
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
      ),
    ),
  };
}

function sheetSlot(meal: Meal, slot: Slot | undefined): DaySheetSlot {
  if (!slot) return { meal, kind: "unplanned", cooked: false, needsReview: false };
  const shown: DaySheetSlot = {
    meal,
    kind: slot.kind,
    cooked: slot.cookedAt !== null,
    needsReview: slot.conflicts.length > 0,
  };
  if (slot.kind === "recipe" && slot.recipe) return { ...shown, title: slot.recipe.title };
  if (slot.kind === "leftovers") return { ...shown, leftoversOf: leftoversOf(slot) };
  return shown;
}

/** The earlier Slot Leftovers eat, if it still holds a Recipe to name. */
function leftoversOf(slot: Slot): DaySheetLeftoversOf | null {
  const of = slot.leftoversOf;
  return of?.recipe ? { title: of.recipe.title, date: of.date, meal: of.meal } : null;
}
