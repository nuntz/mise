import {
  addDays,
  DEFAULT_EFFORT_BUDGETS,
  type LocalDate,
  MEALS,
  type Meal,
  type MemberId,
  type Slot,
  type Week,
} from "@mise/domain";

/** The seven days from `startDate`, every Slot unplanned and eaten by `diners`, the Household's default. */
export function emptyWeek(startDate: LocalDate, diners: MemberId[] = [1, 2, 3]): Week {
  return {
    startDate,
    endDate: addDays(startDate, 6),
    slots: Array.from({ length: 7 }, (_, day) => addDays(startDate, day)).flatMap((date) =>
      MEALS.map(
        (meal): Slot => ({
          date,
          meal,
          kind: "unplanned",
          recipe: null,
          note: null,
          diners: [...diners],
          dinersAreDefault: true,
          guests: 0,
          guestConstraints: [],
          servings: diners.length,
          cookFor: 0,
          leftoversOf: null,
          leftovers: [],
          conflicts: [],
          reason: null,
          cookedAt: null,
          ratings: [],
        }),
      ),
    ),
    effortBudgets: DEFAULT_EFFORT_BUDGETS,
    effortBudgetOverrides: {},
    proposalSeed: null,
    useUp: [],
  };
}

/** Changes the Slot of `week` at `date` and `meal` in place, and returns it. */
export function setSlot(week: Week, date: LocalDate, meal: Meal, change: Partial<Slot>): Slot {
  const slot = week.slots.find((each) => each.date === date && each.meal === meal);
  if (!slot) throw new Error(`No ${meal} on ${date} in the Week of ${week.startDate}`);
  return Object.assign(slot, change);
}

/**
 * The household's Weeks, for a fake client. `get` answers `get_week` with a fresh copy, as the household
 * sends a new Week each time: a screen holding on to an old one then shows it old, as it would for real.
 * Without a date it answers the first Week, today's.
 */
export function weekStore(...weeks: [Week, ...Week[]]) {
  const holding = (date: LocalDate) => {
    const week = weeks.find((each) => each.startDate <= date && date <= each.endDate);
    if (!week) throw new Error(`No Week holds ${date}`);
    return week;
  };
  return {
    get: (date?: LocalDate): Week => structuredClone(date ? holding(date) : weeks[0]),
    /** Changes a Slot in place, as a test sets the scene or the fake's `set_slot` saves. */
    set: (date: LocalDate, meal: Meal, change: Partial<Slot>): Slot => setSlot(holding(date), date, meal, change),
  };
}
