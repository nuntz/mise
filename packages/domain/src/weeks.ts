import { z } from "zod";
import { WEEKDAYS, type Weekday } from "./household";
import { Constraint, MemberId } from "./members";
import { Recipe, RecipeId } from "./recipes";
import { localDate } from "./time";

/** A calendar date, YYYY-MM-DD, as the Household's wall clock reads it; it names no instant. */
export const LocalDate = z.iso.date();
export type LocalDate = z.infer<typeof LocalDate>;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The date `days` calendar days after `date` (before, when negative). */
export function addDays(date: LocalDate, days: number): LocalDate {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Which day of the week `date` is. */
export function weekdayOf(date: LocalDate): Weekday {
  // getUTCDay counts from Sunday; WEEKDAYS from Monday.
  return WEEKDAYS[(new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7] as Weekday;
}

/** The start date of the Week that `date` falls in, for a Household whose Weeks start on `weekStartsOn`. */
export function weekStartOf(date: LocalDate, weekStartsOn: Weekday): LocalDate {
  const behind = (WEEKDAYS.indexOf(weekdayOf(date)) - WEEKDAYS.indexOf(weekStartsOn) + 7) % 7;
  return addDays(date, -behind);
}

/** The start date of the Week the Household is in at `now`, by its own calendar. */
export function currentWeekStart(now: Date, timezone: string, weekStartsOn: Weekday): LocalDate {
  return weekStartOf(localDate(now, timezone), weekStartsOn);
}

/** The dates of the Week that starts on `startDate`, in order. */
export function weekDates(startDate: LocalDate): LocalDate[] {
  return Array.from({ length: 7 }, (_, day) => addDays(startDate, day));
}

export const MEALS = ["breakfast", "lunch", "dinner"] as const;
export const Meal = z.enum(MEALS);
export type Meal = z.infer<typeof Meal>;

/** What a Slot holds: a Recipe, Leftovers, a meal out, nothing decided yet, or no meal at all. */
export const SLOT_KINDS = ["recipe", "leftovers", "eat_out", "unplanned", "skip"] as const;
export const SlotKind = z.enum(SLOT_KINDS);
export type SlotKind = z.infer<typeof SlotKind>;

const SlotNote = z.string().trim().min(1).max(500);
const Guests = z.number().int().min(0).max(50);
const GuestConstraints = z.array(Constraint).max(50);

/** What a Slot shows of its Recipe. */
export const SlotRecipe = Recipe.pick({ id: true, title: true, baseServings: true, photoKey: true });
export type SlotRecipe = z.infer<typeof SlotRecipe>;

export const Slot = z.object({
  date: LocalDate,
  meal: Meal,
  kind: SlotKind,
  /** Set exactly when the kind is "recipe". */
  recipe: SlotRecipe.nullable(),
  note: SlotNote.nullable(),
  /** The Members eating it, in the order they were added to the Household. */
  diners: z.array(MemberId),
  /** True while the Diners follow the Household's default (every Member) rather than a choice made for this Slot. */
  dinersAreDefault: z.boolean(),
  guests: Guests,
  guestConstraints: GuestConstraints,
  /** Diners plus Guests: how many the Recipe is scaled to. */
  servings: z.number().int().nonnegative(),
  locked: z.boolean(),
});
export type Slot = z.infer<typeof Slot>;

export const Week = z.object({
  startDate: LocalDate,
  /** Every meal of every day, by date and then breakfast, lunch, dinner. */
  slots: z.array(Slot),
});
export type Week = z.infer<typeof Week>;

/** A Week is named by any date in it; without one, the Week the Household is in today. */
export const GetWeekInput = z.object({ date: LocalDate.optional() }).strict();

const SlotRef = { date: LocalDate, meal: Meal };

/**
 * Sets what a Slot holds. A Recipe is given exactly when the kind is "recipe". The note is kept
 * when left out and cleared by null. Diners, Guests and the Lock are left as they are.
 */
export const SetSlotInput = z.discriminatedUnion("kind", [
  z
    .object({ ...SlotRef, kind: z.literal("recipe"), recipeId: RecipeId, note: SlotNote.nullable().optional() })
    .strict(),
  z
    .object({
      ...SlotRef,
      kind: SlotKind.exclude(["recipe"]),
      note: SlotNote.nullable().optional(),
    })
    .strict(),
]);

/**
 * Sets who eats one Slot, or every meal of a day when `meal` is left out. Null goes back to the
 * Household's default. The Recipe is never changed; only the Servings it is scaled to.
 */
export const SetDinersInput = z
  .object({
    date: LocalDate,
    meal: Meal.optional(),
    diners: z
      .array(MemberId)
      .max(50)
      .refine((ids) => new Set(ids).size === ids.length, { message: "A Member can only be a Diner once" })
      .nullable(),
  })
  .strict();

/** Sets how many Guests eat a Slot, and their Constraints (kept when left out). */
export const SetGuestsInput = z
  .object({ ...SlotRef, guests: Guests, guestConstraints: GuestConstraints.optional() })
  .strict();

export const LockSlotInput = z.object({ ...SlotRef, locked: z.boolean() }).strict();

/** Clearing is destructive, so the caller must say they confirmed it. */
export const ClearWeekInput = z.object({ date: LocalDate, confirm: z.literal(true) }).strict();
