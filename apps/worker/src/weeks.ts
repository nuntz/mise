import {
  addDays,
  Conflict,
  Constraint,
  currentWeek,
  type LocalDate,
  localDate,
  MEALS,
  type Meal,
  type Member,
  type MemberId,
  Override,
  PLANNED_WEIGHS_FOR_DAYS,
  ProposalChoice,
  ProposalReason,
  type ProposerDinner,
  type ProposerInput,
  type ProposerPeople,
  proposeWeek,
  Rating,
  type RecipeAllergens,
  type RecipeId,
  type RefusedConflict,
  rerollWeek,
  Slot,
  SlotRating,
  sameConflict,
  slotConflicts,
  type ToolResult,
  Week,
  type WeekSpan,
  weekDates,
  weekOf,
} from "@mise/domain";
import { itemNotFound, readCatalogue } from "./items";
import { readRecipeAllergens, readRecipes, recipeNotFound } from "./recipes";
import {
  type ConstraintColumns,
  constraintOf,
  type Handlers,
  memberNotFound,
  memberSignedInAs,
  notSetUp,
  readEffortBudgets,
  readMembers,
  readSettings,
  type Settings,
} from "./tools";

type SlotRow = {
  date: string;
  meal: string;
  kind: string;
  recipe_id: number | null;
  note: string | null;
  diners_chosen: number;
  guests: number;
  locked: number;
  cooked_at: string | null;
  leftovers_of_date: string | null;
  leftovers_of_meal: string | null;
  title: string | null;
  base_servings: number | null;
  photo_key: string | null;
  /** The Recipe of the Slot it is Leftovers of, if any. */
  of_recipe_id: number | null;
  of_title: string | null;
  of_base_servings: number | null;
  of_photo_key: string | null;
};

type SlotKey = { date: string; meal: string };

type WeekRow = { start_date: string; proposal_seed: number | null; proposal_choice: string | null; reviewed: number };

/** What is stored about a Week beside its Slots, with the choice it was last proposed with (null until it is). */
const WeekRecord = Week.pick({
  startDate: true,
  effortBudgetOverrides: true,
  proposalSeed: true,
  reviewed: true,
}).extend({ proposalChoice: ProposalChoice.nullable() });
type WeekRecord = ReturnType<typeof WeekRecord.parse>;

type RatingRow = SlotKey & {
  member_id: number | null;
  rating: string;
  note: string | null;
  rated_at: string;
};

type OverrideRow = SlotKey & { member_id: number | null; allergen: string; cause: string; reason: string };

/** An Override as stored: for the cause its Conflict had when it was given. */
type StoredOverride = Override & Pick<Conflict, "cause">;

type WeekTools =
  | "get_week"
  | "set_slot"
  | "set_diners"
  | "set_guests"
  | "check_slot_constraints"
  | "lock_slot"
  | "link_leftovers"
  | "clear_week"
  | "propose_week"
  | "set_week_effort_budgets"
  | "review_week"
  | "mark_cooked"
  | "rate_recipe";

/** The seed a Week is first proposed with. */
const FIRST_SEED = 1;

/** The Week tools, against the household's SQLite. */
export const weekHandlers: Pick<Handlers, WeekTools> = {
  get_week: (sql, input) => {
    const settings = readSettings(sql);
    if (!settings) return notSetUp();
    return { ok: true, value: readWeek(sql, weekNamedBy(settings, input.date)) };
  },

  set_slot: (sql, input) => {
    const settings = readSettings(sql);
    if (!settings) return notSetUp();
    const recipeId = input.kind === "recipe" ? input.recipeId : null;
    if (recipeId !== null && !recipeExists(sql, recipeId)) {
      return recipeNotFound(recipeId);
    }
    const unknown = unknownMember(sql, input.diners);
    if (unknown !== undefined) return memberNotFound(unknown);
    const refused = editSlot(sql, settings, input, input.overrides, () => {
      // Set by hand now, so no longer for the reason a Proposal gave.
      sql.exec("DELETE FROM slot_reason WHERE date = ? AND meal = ?", input.date, input.meal);
      sql.exec(
        "UPDATE slot SET kind = ?, recipe_id = ? WHERE date = ? AND meal = ?",
        input.kind,
        recipeId,
        input.date,
        input.meal,
      );
      // Leftovers stay linked while they are Leftovers.
      sql.exec(
        `UPDATE slot SET leftovers_of_date = NULL, leftovers_of_meal = NULL
         WHERE date = ? AND meal = ? AND kind <> 'leftovers'`,
        input.date,
        input.meal,
      );
      if (input.note !== undefined) {
        sql.exec("UPDATE slot SET note = ? WHERE date = ? AND meal = ?", input.note, input.date, input.meal);
      }
      if (input.diners !== undefined) writeDiners(sql, input, input.diners);
      if (input.guests !== undefined) writeGuests(sql, input, input.guests, input.guestConstraints);
      else if (input.guestConstraints) writeGuestConstraints(sql, input, input.guestConstraints);
    });
    if (refused.length > 0) return conflictRefused(sql, refused);
    return { ok: true, value: readSlot(sql, input.date, input.meal) };
  },

  set_diners: (sql, input) => {
    const settings = readSettings(sql);
    if (!settings) return notSetUp();
    const unknown = unknownMember(sql, input.diners);
    if (unknown !== undefined) return memberNotFound(unknown);
    const meals = input.meal ? [input.meal] : MEALS;
    const refused = meals.flatMap((meal) =>
      editSlot(sql, settings, { date: input.date, meal }, input.overrides, () =>
        writeDiners(sql, { date: input.date, meal }, input.diners),
      ),
    );
    if (refused.length > 0) return conflictRefused(sql, refused);
    return { ok: true, value: meals.map((meal) => readSlot(sql, input.date, meal)) };
  },

  set_guests: (sql, input) => {
    const settings = readSettings(sql);
    if (!settings) return notSetUp();
    const refused = editSlot(sql, settings, input, input.overrides, () =>
      writeGuests(sql, input, input.guests, input.guestConstraints),
    );
    if (refused.length > 0) return conflictRefused(sql, refused);
    return { ok: true, value: readSlot(sql, input.date, input.meal) };
  },

  check_slot_constraints: (sql, input) => {
    if (!readSettings(sql)) return notSetUp();
    if (input.recipeId && !recipeExists(sql, input.recipeId)) {
      return recipeNotFound(input.recipeId);
    }
    const unknown = unknownMember(sql, input.diners);
    if (unknown !== undefined) return memberNotFound(unknown);
    const slot = readSlot(sql, input.date, input.meal);
    const recipeId = input.recipeId === undefined ? eatenRecipe(slot) : input.recipeId;
    const diners = input.diners === undefined ? slot.diners : (input.diners ?? memberIds(sql));
    const conflicts = conflictsOf(readMembers(sql), readRecipeAllergens(sql, recipeId === null ? [] : [recipeId]), {
      recipeId,
      diners,
      guests: input.guests ?? slot.guests,
      guestConstraints: input.guestConstraints ?? slot.guestConstraints,
    });
    // An Override is for the Recipe it was given with.
    const kept = recipeId === eatenRecipe(slot) ? slot.conflicts : [];
    return {
      ok: true,
      value: conflicts.map((conflict) => ({
        ...conflict,
        override: kept.find((other) => sameConflict(other, conflict))?.override ?? null,
      })),
    };
  },

  lock_slot: (sql, input) => {
    const settings = readSettings(sql);
    if (!settings) return notSetUp();
    storeSlot(sql, settings, input.date, input.meal);
    sql.exec("UPDATE slot SET locked = ? WHERE date = ? AND meal = ?", Number(input.locked), input.date, input.meal);
    return { ok: true, value: readSlot(sql, input.date, input.meal) };
  },

  link_leftovers: (sql, input) => {
    const settings = readSettings(sql);
    if (!settings) return notSetUp();
    const { of } = input;
    if (of && !isBefore(of, input)) {
      return {
        ok: false,
        error: { code: "not_earlier", message: `${of.date} ${of.meal} is not before ${input.date} ${input.meal}` },
      };
    }
    if (of && !readSlot(sql, of.date, of.meal).recipe) {
      return { ok: false, error: { code: "no_recipe", message: `${of.date} ${of.meal} has no Recipe to cook` } };
    }
    const refused = editSlot(sql, settings, input, input.overrides, () => {
      // Linked by hand now, so no longer for the reason a Proposal gave.
      sql.exec("DELETE FROM slot_reason WHERE date = ? AND meal = ?", input.date, input.meal);
      sql.exec(
        `UPDATE slot SET kind = 'leftovers', recipe_id = NULL, leftovers_of_date = ?, leftovers_of_meal = ?
         WHERE date = ? AND meal = ?`,
        of?.date ?? null,
        of?.meal ?? null,
        input.date,
        input.meal,
      );
    });
    if (refused.length > 0) return conflictRefused(sql, refused);
    return { ok: true, value: readSlot(sql, input.date, input.meal) };
  },

  clear_week: (sql, input) => {
    const settings = readSettings(sql);
    if (!settings) return notSetUp();
    const span = weekOf(input.date, settings);
    const range = [span.startDate, span.endDate];
    // Leftovers of the Slots cleared, in the next Week, are of nothing in particular now.
    const cleared = `SELECT date, meal FROM slot WHERE date BETWEEN ? AND ? AND cooked_at IS NULL`;
    sql.exec(
      `DELETE FROM slot_override WHERE (date, meal) IN
         (SELECT date, meal FROM slot WHERE (leftovers_of_date, leftovers_of_meal) IN (${cleared}))`,
      ...range,
    );
    sql.exec(
      `UPDATE slot SET leftovers_of_date = NULL, leftovers_of_meal = NULL
       WHERE (leftovers_of_date, leftovers_of_meal) IN (${cleared})`,
      ...range,
    );
    // A cooked Slot is history, not a plan: it stays, with its Ratings.
    for (const table of ["slot_diner", "slot_guest_constraint", "slot_override", "slot_reason", "slot"]) {
      sql.exec(
        `DELETE FROM ${table} WHERE (date, meal) IN
           (SELECT date, meal FROM slot WHERE date BETWEEN ? AND ? AND cooked_at IS NULL)`,
        ...range,
      );
    }
    return { ok: true, value: readWeek(sql, span) };
  },

  propose_week: (sql, input) => {
    const settings = readSettings(sql);
    if (!settings) return notSetUp();
    const catalogue = readCatalogue(sql);
    const unknownItem = input.useUp.find((id) => !catalogue.item(id));
    if (unknownItem) return itemNotFound(unknownItem);
    const span = weekNamedBy(settings, input.date);
    const week = readWeek(sql, span);
    const stored = readWeekRecords(sql, span.startDate)[0];
    const members = readMembers(sql);
    const ratings = readRatingsByRecipe(sql);
    const people = (slot: Slot): ProposerPeople => ({
      diners: slot.diners.flatMap((id) => members.filter((member) => member.id === id)),
      guests: slot.guests,
      guestConstraints: slot.guestConstraints,
    });
    const dinners = week.slots.filter((slot) => slot.meal === "dinner");
    const proposerInput: ProposerInput = {
      dinners: dinners.map(
        (slot): ProposerDinner => ({
          date: slot.date,
          kind: slot.kind,
          recipeId: slot.recipe?.id ?? null,
          locked: slot.locked,
          cooked: slot.cookedAt !== null,
          ...people(slot),
          leftoversOf: slot.leftoversOf?.meal === "dinner" ? slot.leftoversOf.date : null,
          leftoversProposed: isProposedLeftovers(slot),
          // Those it placed itself, it places again.
          keptLeftovers: slot.leftovers
            .map((leftovers) => readSlot(sql, leftovers.date, leftovers.meal))
            .filter((leftovers) => !isProposedLeftovers(leftovers))
            .map(people),
        }),
      ),
      recipes: readRecipes(sql).map((recipe) => ({ ...recipe, ratings: ratings.get(recipe.id) ?? [] })),
      history: plannedAround(sql, span),
      effortBudgets: week.effortBudgets,
      useUp: input.useUp,
      seed: stored?.proposalSeed ?? FIRST_SEED,
      choice: stored?.proposalChoice ?? "best",
    };
    const proposal = input.reroll ? rerollWeek(proposerInput) : proposeWeek(proposerInput);

    storeWeek(sql, span.startDate);
    for (const dinner of proposal.dinners) {
      const slot = { date: dinner.date, meal: "dinner" } as const;
      storeSlot(sql, settings, dinner.date, "dinner");
      if (!["locked", "cooked", "kept"].includes(dinner.reason.kind)) {
        sql.exec(
          `UPDATE slot SET kind = ?, recipe_id = ?, leftovers_of_date = ?, leftovers_of_meal = ?
           WHERE date = ? AND meal = ?`,
          dinner.kind,
          dinner.recipeId,
          dinner.leftoversOf,
          dinner.leftoversOf === null ? null : "dinner",
          dinner.date,
          "dinner",
        );
        // A Recipe proposed conflicts with nobody, not even whoever eats its Leftovers, so no
        // Override is left to hold.
        writeOverrides(sql, slot, []);
        const before = dinners.find((other) => other.date === dinner.date);
        for (const leftovers of before?.leftovers ?? []) writeOverrides(sql, leftovers, []);
      }
      sql.exec(
        "INSERT OR REPLACE INTO slot_reason (date, meal, reason) VALUES (?, ?, ?)",
        dinner.date,
        "dinner",
        JSON.stringify(dinner.reason),
      );
    }
    sql.exec(
      "UPDATE week SET proposal_seed = ?, proposal_choice = ?, reviewed = 0 WHERE start_date = ?",
      proposal.seed,
      proposal.choice,
      span.startDate,
    );
    return { ok: true, value: readWeek(sql, span) };
  },

  set_week_effort_budgets: (sql, input) => {
    const settings = readSettings(sql);
    if (!settings) return notSetUp();
    const span = weekOf(input.date, settings);
    storeWeek(sql, span.startDate);
    for (const [weekday, minutes] of Object.entries(input.budgets)) {
      if (minutes === null) {
        sql.exec("DELETE FROM week_effort_budget WHERE start_date = ? AND weekday = ?", span.startDate, weekday);
      } else {
        sql.exec(
          "INSERT OR REPLACE INTO week_effort_budget (start_date, weekday, minutes) VALUES (?, ?, ?)",
          span.startDate,
          weekday,
          minutes,
        );
      }
    }
    return { ok: true, value: readWeek(sql, span) };
  },

  review_week: (sql, input) => {
    const settings = readSettings(sql);
    if (!settings) return notSetUp();
    const span = weekOf(input.date, settings);
    storeWeek(sql, span.startDate);
    sql.exec("UPDATE week SET reviewed = ? WHERE start_date = ?", Number(input.reviewed), span.startDate);
    return { ok: true, value: readWeek(sql, span) };
  },

  mark_cooked: (sql, input) => {
    const settings = readSettings(sql);
    if (!settings) return notSetUp();
    const slot = readSlot(sql, input.date, input.meal);
    if (!slot.recipe) {
      return { ok: false, error: { code: "no_recipe", message: `${input.date} ${input.meal} has no Recipe to cook` } };
    }
    if (input.cooked && input.date > localDate(new Date(), settings.timezone)) {
      return { ok: false, error: { code: "not_yet", message: `${input.date} is after today, so not cooked yet` } };
    }
    if (input.cooked) {
      // Marking it again keeps when it was first marked.
      sql.exec(
        "UPDATE slot SET cooked_at = coalesce(cooked_at, ?) WHERE date = ? AND meal = ?",
        new Date().toISOString(),
        input.date,
        input.meal,
      );
    } else {
      clearCooking(sql, input);
    }
    return { ok: true, value: readSlot(sql, input.date, input.meal) };
  },

  rate_recipe: (sql, input, { caller }) => {
    if (!readSettings(sql)) return notSetUp();
    if (readSlot(sql, input.date, input.meal).cookedAt === null) {
      return {
        ok: false,
        error: { code: "not_cooked", message: `Mark ${input.date} ${input.meal} cooked before rating it` },
      };
    }
    const member = caller ? memberSignedInAs(sql, caller.email) : null;
    if (member) {
      sql.exec(
        "DELETE FROM slot_rating WHERE date = ? AND meal = ? AND member_id = ?",
        input.date,
        input.meal,
        member.id,
      );
    }
    sql.exec(
      "INSERT INTO slot_rating (date, meal, member_id, rating, note, rated_at) VALUES (?, ?, ?, ?, ?, ?)",
      input.date,
      input.meal,
      member?.id ?? null,
      input.rating,
      input.note,
      new Date().toISOString(),
    );
    return { ok: true, value: readSlot(sql, input.date, input.meal) };
  },
};

/** Leftovers the latest Proposal placed and nobody has Locked or linked by hand since. */
function isProposedLeftovers(slot: Slot): boolean {
  return slot.kind === "leftovers" && slot.reason?.kind === "leftovers" && !slot.locked;
}

/** The Recipe eaten at the Slot: its own, or for Leftovers the one they were cooked from. */
function eatenRecipe(slot: Slot): RecipeId | null {
  return slot.recipe?.id ?? slot.leftoversOf?.recipe?.id ?? null;
}

/** Whether Slot `a` comes before Slot `b`: an earlier date, or an earlier meal that day. */
function isBefore(a: SlotKey & { meal: Meal }, b: SlotKey & { meal: Meal }): boolean {
  return a.date < b.date || (a.date === b.date && MEALS.indexOf(a.meal) < MEALS.indexOf(b.meal));
}

/** Forgets that the Slot was cooked, and so its Ratings. */
function clearCooking(sql: SqlStorage, { date, meal }: SlotKey): void {
  sql.exec("UPDATE slot SET cooked_at = NULL WHERE date = ? AND meal = ?", date, meal);
  sql.exec("DELETE FROM slot_rating WHERE date = ? AND meal = ?", date, meal);
}

/** Each Recipe's Ratings, from every Slot cooked with it, oldest first. */
function readRatingsByRecipe(sql: SqlStorage): Map<RecipeId, Rating[]> {
  const rows = sql
    .exec<{ recipe_id: number; rating: string }>(
      `SELECT s.recipe_id, r.rating FROM slot_rating AS r JOIN slot AS s ON s.date = r.date AND s.meal = r.meal
       WHERE s.recipe_id IS NOT NULL ORDER BY r.rated_at, r.id`,
    )
    .toArray();
  const ratings = new Map<RecipeId, Rating[]>();
  for (const row of rows) {
    const recipe = ratings.get(row.recipe_id) ?? [];
    recipe.push(Rating.parse(row.rating));
    ratings.set(row.recipe_id, recipe);
  }
  return ratings;
}

/** The Week `date` is in; without one, the Week the Household is in today. */
export function weekNamedBy(settings: Settings, date: LocalDate | undefined): WeekSpan {
  return date ? weekOf(date, settings) : currentWeek(new Date(), settings);
}

/**
 * The Recipes planned for dinners within 6 weeks of the Week, before or after it, cooked or not:
 * a cooked one counts on its own date, and a past one nobody marked cooked most likely was (ADR 0014).
 */
function plannedAround(sql: SqlStorage, span: WeekSpan): { recipeId: RecipeId; date: LocalDate }[] {
  const { startDate: start, endDate: end } = span;
  return sql
    .exec<{ recipe_id: number; date: string }>(
      `SELECT recipe_id, date FROM slot
       WHERE meal = 'dinner' AND recipe_id IS NOT NULL AND date BETWEEN ? AND ? AND date NOT BETWEEN ? AND ?
       ORDER BY date`,
      addDays(start, -PLANNED_WEIGHS_FOR_DAYS),
      addDays(end, PLANNED_WEIGHS_FOR_DAYS),
      start,
      end,
    )
    .toArray()
    .map((row) => ({ recipeId: row.recipe_id, date: row.date }));
}

/** Stores the Week as it starts unless already stored, so that what belongs to it can be set. */
export function storeWeek(sql: SqlStorage, start: LocalDate): void {
  sql.exec("INSERT OR IGNORE INTO week (start_date) VALUES (?)", start);
}

/**
 * Makes `change` to a Slot, then settles the Overrides of it and of the Slots linked as its
 * Leftovers, whose Diners and Guests eat its Recipe: those given cover their Conflicts, those already stored stay
 * while the Recipe eaten does, and the rest are dropped. Returns the Conflicts the change brought that
 * nothing overrides; the caller refuses it then, which rolls the change back. Conflicts a Slot already
 * had are left to the Week view: they never block an unrelated edit, nor the one that resolves them.
 */
function editSlot(
  sql: SqlStorage,
  settings: Settings,
  { date, meal }: { date: LocalDate; meal: Meal },
  given: Override[] | undefined,
  change: () => void,
): RefusedConflict[] {
  const edited = readSlot(sql, date, meal);
  const before = [edited, ...edited.leftovers.map((leftovers) => readSlot(sql, leftovers.date, leftovers.meal))];
  storeSlot(sql, settings, date, meal);
  change();
  // What was cooked, and rated, was the Recipe it had.
  if (edited.recipe?.id !== readSlot(sql, date, meal).recipe?.id) clearCooking(sql, { date, meal });

  const refused: RefusedConflict[] = [];
  for (const was of before) {
    const after = readSlot(sql, was.date, was.meal);
    const sameRecipe = eatenRecipe(was) === eatenRecipe(after);
    const known = sameRecipe ? was.conflicts : [];
    const overrides: StoredOverride[] = [];
    for (const conflict of after.conflicts) {
      const reason =
        given?.find((override) => sameConflict(override, conflict))?.reason ?? (sameRecipe ? conflict.override : null);
      if (reason) overrides.push({ who: conflict.who, allergen: conflict.allergen, cause: conflict.cause, reason });
      else if (!known.some((other) => sameConflict(other, conflict))) {
        const { override: _, ...refusal } = conflict;
        refused.push({ date: was.date, meal: was.meal, ...refusal });
      }
    }
    writeOverrides(sql, was, overrides);
  }
  return refused;
}

/** Refuses a change for the Conflicts it would bring, naming each person and Allergen. */
function conflictRefused<T>(sql: SqlStorage, conflicts: RefusedConflict[]): ToolResult<T> {
  const names = new Map(readMembers(sql).map((member) => [member.id, member.name]));
  const described = conflicts.map((conflict) => {
    const slot = readSlot(sql, conflict.date, conflict.meal);
    const recipe = slot.recipe?.title ?? "The Recipe";
    const who = conflict.who === "guests" ? "the Guests" : (names.get(conflict.who) ?? `Member ${conflict.who}`);
    const has = `${who} ${conflict.who === "guests" ? "have" : "has"} a ${conflict.allergen} ${conflict.constraint}`;
    const why =
      conflict.cause === "contains"
        ? `${recipe} contains ${conflict.allergen}`
        : `${recipe} has Unresolved Ingredients, so its Allergens are unknown`;
    return `${conflict.date} ${conflict.meal}: ${why}, and ${has}`;
  });
  return {
    ok: false,
    error: {
      code: "constraint_conflict",
      message: `${described.join("; ")}. To plan it anyway, override each with a reason.`,
      conflicts,
    },
  };
}

function recipeExists(sql: SqlStorage, id: RecipeId): boolean {
  return sql.exec("SELECT 1 FROM recipe WHERE id = ?", id).toArray().length > 0;
}

/** The first Diner given who is not a Member. */
function unknownMember(sql: SqlStorage, diners: MemberId[] | null | undefined): MemberId | undefined {
  const members = memberIds(sql);
  return diners?.find((id) => !members.includes(id));
}

/** Stores the Slot, and its Week, as they start unless already stored, so that it can be edited. */
function storeSlot(sql: SqlStorage, settings: Settings, date: LocalDate, meal: Meal): void {
  storeWeek(sql, weekOf(date, settings).startDate);
  sql.exec(
    `INSERT OR IGNORE INTO slot (date, meal, kind, diners_chosen, guests, locked)
     VALUES (?, ?, 'unplanned', 0, 0, 0)`,
    date,
    meal,
  );
}

/** Sets who eats the Slot; null follows the Household's default again. */
function writeDiners(sql: SqlStorage, { date, meal }: SlotKey, diners: MemberId[] | null): void {
  sql.exec("UPDATE slot SET diners_chosen = ? WHERE date = ? AND meal = ?", Number(diners !== null), date, meal);
  sql.exec("DELETE FROM slot_diner WHERE date = ? AND meal = ?", date, meal);
  for (const id of diners ?? []) {
    sql.exec("INSERT INTO slot_diner (date, meal, member_id) VALUES (?, ?, ?)", date, meal, id);
  }
}

function writeGuests(sql: SqlStorage, slot: SlotKey, guests: number, constraints: Constraint[] | undefined): void {
  sql.exec("UPDATE slot SET guests = ? WHERE date = ? AND meal = ?", guests, slot.date, slot.meal);
  if (constraints) writeGuestConstraints(sql, slot, constraints);
}

function writeOverrides(sql: SqlStorage, { date, meal }: SlotKey, overrides: StoredOverride[]): void {
  sql.exec("DELETE FROM slot_override WHERE date = ? AND meal = ?", date, meal);
  overrides.forEach((override, position) => {
    sql.exec(
      "INSERT INTO slot_override (date, meal, position, member_id, allergen, cause, reason) VALUES (?, ?, ?, ?, ?, ?, ?)",
      date,
      meal,
      position,
      override.who === "guests" ? null : override.who,
      override.allergen,
      override.cause,
      override.reason,
    );
  });
}

function writeGuestConstraints(sql: SqlStorage, { date, meal }: SlotKey, constraints: Constraint[]): void {
  sql.exec("DELETE FROM slot_guest_constraint WHERE date = ? AND meal = ?", date, meal);
  constraints.forEach((constraint, position) => {
    sql.exec(
      "INSERT INTO slot_guest_constraint (date, meal, position, kind, allergen, term) VALUES (?, ?, ?, ?, ?, ?)",
      date,
      meal,
      position,
      constraint.kind,
      constraint.allergen ?? null,
      constraint.term ?? null,
    );
  });
}

export function readWeek(sql: SqlStorage, span: WeekSpan): Week {
  const { startDate, endDate } = span;
  const dates = weekDates(span);
  const stored = readSlots(sql, startDate, endDate);
  const defaults = memberIds(sql);
  const slots = dates.flatMap((date) =>
    MEALS.map(
      (meal) => stored.find((slot) => slot.date === date && slot.meal === meal) ?? unplannedSlot(date, meal, defaults),
    ),
  );
  const effortBudgets = readEffortBudgets(sql);
  const record = readWeekRecords(sql, startDate)[0];
  const overrides = record?.effortBudgetOverrides ?? {};
  return {
    startDate,
    endDate,
    slots,
    effortBudgets: { ...effortBudgets, ...overrides },
    effortBudgetOverrides: overrides,
    proposalSeed: record?.proposalSeed ?? null,
    reviewed: record?.reviewed ?? false,
  };
}

/** What is stored about each Week, or the one starting on `startDate`, beside its Slots; parsed, so bad rows throw. */
export function readWeekRecords(sql: SqlStorage, startDate?: LocalDate): WeekRecord[] {
  const only = [startDate ?? null, startDate ?? null];
  const weeks = sql
    .exec<WeekRow>("SELECT * FROM week WHERE ? IS NULL OR start_date = ? ORDER BY start_date", ...only)
    .toArray();
  const budgets = sql
    .exec<{ start_date: string; weekday: string; minutes: number }>(
      "SELECT * FROM week_effort_budget WHERE ? IS NULL OR start_date = ? ORDER BY start_date, weekday",
      ...only,
    )
    .toArray();
  return weeks.map((row) =>
    WeekRecord.parse({
      startDate: row.start_date,
      effortBudgetOverrides: Object.fromEntries(
        budgets
          .filter((budget) => budget.start_date === row.start_date)
          .map((budget) => [budget.weekday, budget.minutes]),
      ),
      proposalSeed: row.proposal_seed,
      proposalChoice: row.proposal_choice,
      reviewed: row.reviewed === 1,
    }),
  );
}

function readSlot(sql: SqlStorage, date: LocalDate, meal: Meal): Slot {
  return readSlots(sql, date, date).find((slot) => slot.meal === meal) ?? unplannedSlot(date, meal, memberIds(sql));
}

/** A Slot nobody has edited. */
function unplannedSlot(date: LocalDate, meal: Meal, diners: MemberId[]): Slot {
  return {
    date,
    meal,
    kind: "unplanned",
    recipe: null,
    note: null,
    diners,
    dinersAreDefault: true,
    guests: 0,
    guestConstraints: [],
    servings: diners.length,
    cookFor: 0,
    leftoversOf: null,
    leftovers: [],
    locked: false,
    conflicts: [],
    reason: null,
    cookedAt: null,
    ratings: [],
  };
}

/** The stored Slots dated from `from` to `to`, or every one; parsed, so bad rows throw. */
export function readSlots(sql: SqlStorage, from?: LocalDate, to?: LocalDate): Slot[] {
  const range = [from ?? "", to ?? "9999-12-31"];
  const rows = sql
    .exec<SlotRow>(
      `SELECT s.*, r.title, r.base_servings, r.photo_key, o.recipe_id AS of_recipe_id, of_recipe.title AS of_title,
         of_recipe.base_servings AS of_base_servings, of_recipe.photo_key AS of_photo_key
       FROM slot AS s LEFT JOIN recipe AS r ON r.id = s.recipe_id
       LEFT JOIN slot AS o ON o.date = s.leftovers_of_date AND o.meal = s.leftovers_of_meal
       LEFT JOIN recipe AS of_recipe ON of_recipe.id = o.recipe_id
       WHERE s.date BETWEEN ? AND ? ORDER BY s.date`,
      ...range,
    )
    .toArray();
  // Leftovers of these Slots, wherever they are: they can be in the next Week. Servings counted as a
  // Slot's below are: its Diners, every Member while they are the default, and its Guests.
  const linked = sql
    .exec<SlotKey & { of_date: string; of_meal: string; servings: number }>(
      `SELECT l.date, l.meal, l.leftovers_of_date AS of_date, l.leftovers_of_meal AS of_meal,
         l.guests + CASE WHEN l.diners_chosen = 1
           THEN (SELECT count(*) FROM slot_diner AS d WHERE d.date = l.date AND d.meal = l.meal)
           ELSE (SELECT count(*) FROM member) END AS servings
       FROM slot AS l WHERE l.leftovers_of_date BETWEEN ? AND ? ORDER BY l.date`,
      ...range,
    )
    .toArray()
    .sort((a, b) => a.date.localeCompare(b.date) || MEALS.indexOf(a.meal as Meal) - MEALS.indexOf(b.meal as Meal));
  const diners = sql
    .exec<SlotKey & { member_id: number }>(
      "SELECT date, meal, member_id FROM slot_diner WHERE date BETWEEN ? AND ? ORDER BY member_id",
      ...range,
    )
    .toArray();
  const guestConstraints = sql
    .exec<SlotKey & ConstraintColumns>(
      `SELECT date, meal, kind, allergen, term FROM slot_guest_constraint
       WHERE date BETWEEN ? AND ? ORDER BY date, meal, position`,
      ...range,
    )
    .toArray();
  const overrides = sql
    .exec<OverrideRow>(
      `SELECT date, meal, member_id, allergen, cause, reason FROM slot_override
       WHERE date BETWEEN ? AND ? ORDER BY date, meal, position`,
      ...range,
    )
    .toArray();
  const ratings = sql
    .exec<RatingRow>(
      `SELECT date, meal, member_id, rating, note, rated_at FROM slot_rating
       WHERE date BETWEEN ? AND ? ORDER BY rated_at, id`,
      ...range,
    )
    .toArray();
  const reasons = sql
    .exec<SlotKey & { reason: string }>(
      "SELECT date, meal, reason FROM slot_reason WHERE date BETWEEN ? AND ?",
      ...range,
    )
    .toArray();
  const members = readMembers(sql);
  const defaults = members.map((member) => member.id);
  // The Recipe eaten: for Leftovers, the one they were cooked from.
  const eaten = (row: SlotRow) => row.recipe_id ?? (row.kind === "leftovers" ? row.of_recipe_id : null);
  const allergens = readRecipeAllergens(
    sql,
    rows.flatMap((row) => {
      const id = eaten(row);
      return id === null ? [] : [id];
    }),
  );
  const of = <T extends SlotKey>(all: T[], row: SlotKey) =>
    all.filter((other) => other.date === row.date && other.meal === row.meal);

  return rows
    .map((row) => {
      const eating = row.diners_chosen === 1 ? of(diners, row).map((diner) => diner.member_id) : defaults;
      const theirConstraints = of(guestConstraints, row).map((constraint) =>
        Constraint.parse(constraintOf(constraint)),
      );
      const stored = of(overrides, row).map(
        (override): StoredOverride => ({
          ...Override.parse({
            who: override.member_id ?? "guests",
            allergen: override.allergen,
            reason: override.reason,
          }),
          cause: Conflict.shape.cause.parse(override.cause),
        }),
      );
      const [reason] = of(reasons, row);
      const leftovers = linked.filter((other) => other.of_date === row.date && other.of_meal === row.meal);
      const servings = eating.length + row.guests;
      const conflicts = conflictsOf(members, allergens, {
        recipeId: eaten(row),
        diners: eating,
        guests: row.guests,
        guestConstraints: theirConstraints,
      });
      return Slot.parse({
        date: row.date,
        meal: row.meal,
        kind: row.kind,
        recipe:
          row.recipe_id === null
            ? null
            : {
                id: row.recipe_id,
                title: row.title,
                baseServings: row.base_servings,
                photoKey: row.photo_key,
              },
        note: row.note,
        diners: eating,
        dinersAreDefault: row.diners_chosen === 0,
        guests: row.guests,
        guestConstraints: theirConstraints,
        servings,
        cookFor: row.recipe_id === null ? 0 : servings + leftovers.reduce((total, other) => total + other.servings, 0),
        leftoversOf:
          row.leftovers_of_date === null
            ? null
            : {
                date: row.leftovers_of_date,
                meal: row.leftovers_of_meal,
                recipe:
                  row.of_recipe_id === null
                    ? null
                    : {
                        id: row.of_recipe_id,
                        title: row.of_title,
                        baseServings: row.of_base_servings,
                        photoKey: row.of_photo_key,
                      },
              },
        leftovers: leftovers.map((other) => ({ date: other.date, meal: other.meal })),
        locked: row.locked === 1,
        conflicts: conflicts.map((conflict) => ({
          ...conflict,
          override:
            stored.find((override) => sameConflict(override, conflict) && override.cause === conflict.cause)?.reason ??
            null,
        })),
        reason: reason ? ProposalReason.parse(JSON.parse(reason.reason)) : null,
        cookedAt: row.cooked_at,
        ratings: of(ratings, row).map((rating) =>
          SlotRating.parse({
            memberId: rating.member_id,
            rating: rating.rating,
            note: rating.note,
            at: rating.rated_at,
          }),
        ),
      });
    })
    .sort((a, b) => a.date.localeCompare(b.date) || MEALS.indexOf(a.meal) - MEALS.indexOf(b.meal));
}

/** The Conflicts of a Slot as described, from the Members and Recipe Allergens already read. */
function conflictsOf(
  members: Member[],
  allergens: Map<RecipeId, RecipeAllergens>,
  slot: { recipeId: RecipeId | null; diners: MemberId[]; guests: number; guestConstraints: Constraint[] },
): Conflict[] {
  return slotConflicts({
    allergens: slot.recipeId === null ? null : (allergens.get(slot.recipeId) ?? null),
    diners: slot.diners.flatMap((id) => members.filter((member) => member.id === id)),
    guests: slot.guests,
    guestConstraints: slot.guestConstraints,
  });
}

/** The Household's default Diners: every Member, in the order they were added. */
function memberIds(sql: SqlStorage): MemberId[] {
  return sql
    .exec<{ id: number }>("SELECT id FROM member ORDER BY id")
    .toArray()
    .map((row) => row.id);
}
