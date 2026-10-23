import { z } from "zod";
import { Overrides, SlotConflict } from "./conflicts";
import { EffortBudgets, Minutes, WEEKDAYS, Weekday } from "./household";
import { ItemId } from "./items";
import { Constraint, MemberId } from "./members";
import { ProposalReason } from "./proposals";
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
  /** Every Conflict of its Recipe with a Hard Constraint of someone eating it, overridden or not. */
  conflicts: z.array(SlotConflict),
  /** Why the latest Proposal left it as it did; null once edited by hand, or if never proposed. */
  reason: ProposalReason.nullable(),
});
export type Slot = z.infer<typeof Slot>;

export const Week = z.object({
  startDate: LocalDate,
  /** Every meal of every day, by date and then breakfast, lunch, dinner. */
  slots: z.array(Slot),
  /** Each weekday's Effort Budget for this Week: the Household's default, or this Week's override. */
  effortBudgets: EffortBudgets,
  /** The weekdays whose Effort Budget this Week overrides, and by what. */
  effortBudgetOverrides: z.partialRecord(Weekday, Minutes),
  /** The seed of the latest Proposal; null until the Week is first proposed. */
  proposalSeed: z.number().int().nonnegative().nullable(),
  /** Whether someone has looked the Week over since it was last proposed. */
  reviewed: z.boolean(),
});
export type Week = z.infer<typeof Week>;

/** A Week is named by any date in it; without one, the Week the Household is in today. */
export const GetWeekInput = z.object({ date: LocalDate.optional() }).strict();

const SlotRef = { date: LocalDate, meal: Meal };

const Diners = z
  .array(MemberId)
  .max(50)
  .refine((ids) => new Set(ids).size === ids.length, { message: "A Member can only be a Diner once" })
  .nullable();

/**
 * What a change to a Slot may bring: refused if it leaves the Slot with a Conflict it did not have,
 * unless that Conflict is overridden here. Overrides already on the Slot stay while its Recipe does.
 */
const SlotChange = {
  ...SlotRef,
  note: SlotNote.nullable().optional(),
  /** As `set_diners` takes them; left as they are when left out. */
  diners: Diners.optional(),
  guests: Guests.optional(),
  guestConstraints: GuestConstraints.optional(),
  overrides: Overrides.optional(),
};

/**
 * Sets what a Slot holds. A Recipe is given exactly when the kind is "recipe". The note is kept
 * when left out and cleared by null. Diners and Guests can be set in the same change, so that their
 * Conflicts are checked once, against the Slot as it ends up; the Lock is left as it is.
 */
export const SetSlotInput = z.discriminatedUnion("kind", [
  z.object({ ...SlotChange, kind: z.literal("recipe"), recipeId: RecipeId }).strict(),
  z.object({ ...SlotChange, kind: SlotKind.exclude(["recipe"]) }).strict(),
]);

/**
 * Sets who eats one Slot, or every meal of a day when `meal` is left out. Null goes back to the
 * Household's default. The Recipe is never changed; only the Servings it is scaled to.
 */
export const SetDinersInput = z
  .object({
    date: LocalDate,
    meal: Meal.optional(),
    diners: Diners,
    /** Each applies to every Slot changed that has its Conflict. */
    overrides: Overrides.optional(),
  })
  .strict();

/** Sets how many Guests eat a Slot, and their Constraints (kept when left out). */
export const SetGuestsInput = z
  .object({
    ...SlotRef,
    guests: Guests,
    guestConstraints: GuestConstraints.optional(),
    overrides: Overrides.optional(),
  })
  .strict();

/**
 * The Conflicts a Slot would have with the changes given (each left as it is when left out; a null
 * Recipe is none), without changing it. Overrides on the Slot still show while its Recipe stays.
 */
export const CheckSlotConstraintsInput = z
  .object({
    ...SlotRef,
    recipeId: RecipeId.nullable().optional(),
    diners: Diners.optional(),
    guests: Guests.optional(),
    guestConstraints: GuestConstraints.optional(),
  })
  .strict();

export const LockSlotInput = z.object({ ...SlotRef, locked: z.boolean() }).strict();

/** Clearing is destructive, so the caller must say they confirmed it. */
export const ClearWeekInput = z.object({ date: LocalDate, confirm: z.literal(true) }).strict();

/**
 * Proposes the Week's dinners (see `proposeWeek`). The same Week, unchanged, gets the same Proposal
 * from the seed it was last proposed with; a re-roll moves on to a new seed and a different Proposal.
 * Either way the Week is marked as not reviewed.
 */
export const ProposeWeekInput = z
  .object({
    date: LocalDate.optional(),
    /** Items on hand: Recipes that use them are favoured. */
    useUp: z
      .array(ItemId)
      .max(50)
      .default([])
      .transform((items) => [...new Set(items)]),
    reroll: z.boolean().default(false),
  })
  .strict();

/** Overrides the Effort Budgets of the weekdays given for one Week; null goes back to the Household's. */
export const SetWeekEffortBudgetsInput = z
  .object({ date: LocalDate, budgets: z.partialRecord(Weekday, Minutes.nullable()) })
  .strict();

export const ReviewWeekInput = z.object({ date: LocalDate, reviewed: z.boolean() }).strict();
