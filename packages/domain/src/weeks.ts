import { z } from "zod";
import { Overrides, SlotConflict } from "./conflicts";
import { EffortBudgets, Minutes, WEEKDAYS, Weekday, WeekStartChange } from "./household";
import { ItemId } from "./items";
import { Constraint, MemberId } from "./members";
import { ProposalReason, Rating } from "./proposals";
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

/**
 * What decides the Household's Weeks: the day they start on now, and every change to it, oldest
 * first. Checked to give every date exactly one Week: each change stretches a Week that starts on
 * the day Weeks start on then, no earlier than the previous change, by more than seven days, and the
 * last leaves Weeks starting on `weekStartsOn`.
 */
export const WeekCalendar = z
  .object({ weekStartsOn: Weekday, weekStartChanges: z.array(WeekStartChange) })
  .superRefine(({ weekStartsOn, weekStartChanges }, ctx) => {
    let previous: WeekStartChange | undefined;
    for (const change of weekStartChanges) {
      if (change.from <= addDays(change.stretches, 7)) {
        ctx.addIssue({ code: "custom", message: `The Week of ${change.stretches} must run on past seven days` });
      }
      if (previous && change.stretches < previous.from) {
        ctx.addIssue({ code: "custom", message: `The Week of ${change.stretches} starts before ${previous.from}` });
      }
      if (previous && weekdayOf(change.stretches) !== weekdayOf(previous.from)) {
        ctx.addIssue({ code: "custom", message: `Weeks did not start on ${change.stretches}'s weekday then` });
      }
      previous = change;
    }
    if (previous && weekdayOf(previous.from) !== weekStartsOn) {
      ctx.addIssue({ code: "custom", message: `Weeks start on ${weekdayOf(previous.from)}, not ${weekStartsOn}` });
    }
  });
export type WeekCalendar = z.infer<typeof WeekCalendar>;

/** A Week's first and last days. */
export type WeekSpan = { startDate: LocalDate; endDate: LocalDate };

/** The Week `date` falls in: seven days, but for one a change of week start makes run on. */
export function weekOf(date: LocalDate, calendar: WeekCalendar): WeekSpan {
  const changes = calendar.weekStartChanges;
  // Changes are oldest first: count those already begun by `date`, less one.
  const since = changes.filter((change) => change.from <= date).length - 1;
  const startsOn =
    since >= 0
      ? weekdayOf((changes[since] as WeekStartChange).from)
      : changes[0]
        ? weekdayOf(changes[0].stretches)
        : calendar.weekStartsOn;
  const next = changes[since + 1];
  if (next && date >= next.stretches) return { startDate: next.stretches, endDate: addDays(next.from, -1) };
  const startDate = weekStartOf(date, startsOn);
  return { startDate, endDate: addDays(startDate, 6) };
}

/** What tells which Week the Household is in now: its Weeks, and the timezone its today is read in. */
export type HouseholdClock = WeekCalendar & { timezone: string };

/** The Week the Household is in at `now`, by its own calendar. */
export function currentWeek(now: Date, household: HouseholdClock): WeekSpan {
  return weekOf(localDate(now, household.timezone), household);
}

/** The first day of the Week after `week`. */
export function nextWeekStart(week: WeekSpan): LocalDate {
  return addDays(week.endDate, 1);
}

/** Whether someone has started the Week: any of its dinners is planned, by hand or by a Proposal. */
export function isStarted(week: Week): boolean {
  return week.slots.some((slot) => slot.meal === "dinner" && slot.kind !== "unplanned");
}

/** Every date of the Week, in order. */
export function weekDates(week: WeekSpan): LocalDate[] {
  const dates: LocalDate[] = [];
  for (let date = week.startDate; date <= week.endDate; date = addDays(date, 1)) dates.push(date);
  return dates;
}

/**
 * The changes of week start once Weeks start on `weekStartsOn` (ADR 0021). The current Week, and
 * any Week already `created` after it, keep their dates: the last of them runs on to the first new
 * start day after it, which starts the next Week. A change no Week has started under yet is replaced.
 */
export function changeWeekStart(
  calendar: WeekCalendar,
  weekStartsOn: Weekday,
  today: LocalDate,
  created: LocalDate[],
): WeekStartChange[] {
  const current = weekOf(today, calendar).startDate;
  const last = created.reduce((latest, start) => (start > latest ? start : latest), current);
  const kept = calendar.weekStartChanges.filter((change) => change.from <= last);
  // Seven days at least, and past today: a Week that has run on past seven days stays today's.
  let from = addDays(last, 7);
  if (from <= today) from = addDays(today, 1);
  while (weekdayOf(from) !== weekStartsOn) from = addDays(from, 1);
  return from === addDays(last, 7) ? kept : [...kept, { from, stretches: last }];
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

const RatingNote = z.string().trim().min(1).max(500);

/** A Rating given to a Slot once it was cooked, by the Member the Caller signed in as, if any. */
export const SlotRating = z.object({
  /** Null when no Member gave it: the Caller signed in as nobody's email, or the Member was removed. */
  memberId: MemberId.nullable(),
  rating: Rating,
  note: RatingNote.nullable(),
  at: z.iso.datetime(),
});
export type SlotRating = z.infer<typeof SlotRating>;

/** What a Slot shows of its Recipe. */
export const SlotRecipe = Recipe.pick({ id: true, title: true, baseServings: true, photoKey: true, readyMade: true });
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
  /** Diners plus Guests: how many eat it. */
  servings: z.number().int().nonnegative(),
  /**
   * How many its Recipe is cooked for, and so scaled to: its Servings plus those of every Slot linked
   * as its Leftovers. 0 without a Recipe.
   */
  cookFor: z.number().int().nonnegative(),
  /**
   * Only when the kind is "leftovers": the earlier Slot whose cooking it eats, with that Slot's Recipe
   * (null if it holds none now). Null when it is Leftovers of nothing in particular.
   */
  leftoversOf: z.object({ date: LocalDate, meal: Meal, recipe: SlotRecipe.nullable() }).nullable(),
  /** The Slots linked as its Leftovers, by date and meal. */
  leftovers: z.array(z.object({ date: LocalDate, meal: Meal })),
  locked: z.boolean(),
  /**
   * Every Conflict of its Recipe, or for Leftovers of the Recipe they were cooked from, with a Hard
   * Constraint of someone eating it, overridden or not.
   */
  conflicts: z.array(SlotConflict),
  /** Why the latest Proposal left it as it did; null once edited by hand, or if never proposed. */
  reason: ProposalReason.nullable(),
  /** When it was marked cooked; null until it is. Only a Slot with a Recipe can be. */
  cookedAt: z.iso.datetime().nullable(),
  /** The Ratings it was given once cooked, oldest first: one per Member, and any no Member gave. */
  ratings: z.array(SlotRating),
});
export type Slot = z.infer<typeof Slot>;

export const Week = z.object({
  startDate: LocalDate,
  /** Its last day: six days on, but for a Week a change of week start makes run on (ADR 0021). */
  endDate: LocalDate,
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
 * Sets what a Slot holds. A Recipe is given exactly when the kind is "recipe". Leftovers stay linked
 * to the Slot they were cooked for while the kind stays "leftovers"; `link_leftovers` links them.
 * The note is kept
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

/**
 * Makes a Slot Leftovers of an earlier Slot that holds a Recipe, which is then cooked for both. Null
 * unlinks it: it stays Leftovers, of nothing in particular, and the earlier Slot is cooked for its own
 * Servings again. Refuses new Conflicts as `set_slot` does: those eating the Leftovers eat its Recipe.
 */
export const LinkLeftoversInput = z
  .object({ ...SlotRef, of: z.object(SlotRef).strict().nullable(), overrides: Overrides.optional() })
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

/**
 * Marks a Slot with a Recipe as cooked, or not (which drops its Ratings). Cooking counts for its
 * Recipe on the Slot's date. A Slot loses its cooking and Ratings when its Recipe changes.
 */
export const MarkCookedInput = z.object({ ...SlotRef, cooked: z.boolean().default(true) }).strict();

/**
 * Rates the Recipe of a cooked Slot, for the Member the Caller signs in as: their Rating replaces
 * the one they gave the Slot before. A Caller who is no Member rates without a name.
 */
export const RateRecipeInput = z
  .object({ ...SlotRef, rating: Rating, note: RatingNote.nullable().default(null) })
  .strict();
