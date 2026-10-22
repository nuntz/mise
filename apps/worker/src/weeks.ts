import {
  Conflict,
  Constraint,
  currentWeekStart,
  type HouseholdSettings,
  type LocalDate,
  MEALS,
  type Meal,
  type Member,
  type MemberId,
  Override,
  type RecipeAllergens,
  type RecipeId,
  type RefusedConflict,
  Slot,
  sameConflict,
  slotConflicts,
  type ToolResult,
  type Week,
  weekDates,
  weekStartOf,
} from "@mise/domain";
import { readRecipeAllergens, recipeNotFound } from "./recipes";
import {
  type ConstraintColumns,
  constraintOf,
  type Handlers,
  memberNotFound,
  notSetUp,
  readMembers,
  readSettings,
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
  title: string | null;
  base_servings: number | null;
  photo_key: string | null;
};

type SlotKey = { date: string; meal: string };

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
  | "clear_week";

/** The Week tools, against the household's SQLite. */
export const weekHandlers: Pick<Handlers, WeekTools> = {
  get_week: (sql, input) => {
    const settings = readSettings(sql);
    if (!settings) return notSetUp();
    const start = input.date
      ? weekStartOf(input.date, settings.weekStartsOn)
      : currentWeekStart(new Date(), settings.timezone, settings.weekStartsOn);
    return { ok: true, value: readWeek(sql, start) };
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
      sql.exec(
        "UPDATE slot SET kind = ?, recipe_id = ? WHERE date = ? AND meal = ?",
        input.kind,
        recipeId,
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
    const recipeId = input.recipeId === undefined ? (slot.recipe?.id ?? null) : input.recipeId;
    const diners = input.diners === undefined ? slot.diners : (input.diners ?? memberIds(sql));
    const conflicts = conflictsOf(readMembers(sql), readRecipeAllergens(sql, recipeId === null ? [] : [recipeId]), {
      recipeId,
      diners,
      guests: input.guests ?? slot.guests,
      guestConstraints: input.guestConstraints ?? slot.guestConstraints,
    });
    // An Override is for the Recipe it was given with.
    const kept = recipeId === (slot.recipe?.id ?? null) ? slot.conflicts : [];
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

  clear_week: (sql, input) => {
    const settings = readSettings(sql);
    if (!settings) return notSetUp();
    const dates = weekDates(weekStartOf(input.date, settings.weekStartsOn));
    const range = [dates[0], dates.at(-1)];
    for (const table of ["slot_diner", "slot_guest_constraint", "slot_override", "slot"]) {
      sql.exec(`DELETE FROM ${table} WHERE date BETWEEN ? AND ?`, ...range);
    }
    return { ok: true, value: readWeek(sql, dates[0] as LocalDate) };
  },
};

/**
 * Makes `change` to a Slot, then settles its Overrides: those given cover their Conflicts, those
 * already stored stay while the Recipe does, and the rest are dropped. Returns the Conflicts the
 * change brought that nothing overrides; the caller refuses it then, which rolls the change back.
 * Conflicts the Slot already had are left to the Week view: they never block an unrelated edit, nor
 * the one that resolves them.
 */
function editSlot(
  sql: SqlStorage,
  settings: HouseholdSettings,
  { date, meal }: { date: LocalDate; meal: Meal },
  given: Override[] | undefined,
  change: () => void,
): RefusedConflict[] {
  const before = readSlot(sql, date, meal);
  storeSlot(sql, settings, date, meal);
  change();
  const after = readSlot(sql, date, meal);
  const sameRecipe = before.recipe?.id === after.recipe?.id;
  const known = sameRecipe ? before.conflicts : [];

  const overrides: StoredOverride[] = [];
  const refused: RefusedConflict[] = [];
  for (const conflict of after.conflicts) {
    const reason =
      given?.find((override) => sameConflict(override, conflict))?.reason ?? (sameRecipe ? conflict.override : null);
    if (reason) overrides.push({ who: conflict.who, allergen: conflict.allergen, cause: conflict.cause, reason });
    else if (!known.some((other) => sameConflict(other, conflict))) {
      const { override: _, ...refusal } = conflict;
      refused.push({ date, meal, ...refusal });
    }
  }
  writeOverrides(sql, { date, meal }, overrides);
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
function storeSlot(sql: SqlStorage, settings: HouseholdSettings, date: LocalDate, meal: Meal): void {
  sql.exec("INSERT OR IGNORE INTO week (start_date) VALUES (?)", weekStartOf(date, settings.weekStartsOn));
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

function readWeek(sql: SqlStorage, startDate: LocalDate): Week {
  const dates = weekDates(startDate);
  const stored = readSlots(sql, dates[0], dates.at(-1));
  const defaults = memberIds(sql);
  const slots = dates.flatMap((date) =>
    MEALS.map(
      (meal) => stored.find((slot) => slot.date === date && slot.meal === meal) ?? unplannedSlot(date, meal, defaults),
    ),
  );
  return { startDate, slots };
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
    locked: false,
    conflicts: [],
  };
}

/** The stored Slots dated from `from` to `to`, or every one; parsed, so bad rows throw. */
export function readSlots(sql: SqlStorage, from?: LocalDate, to?: LocalDate): Slot[] {
  const range = [from ?? "", to ?? "9999-12-31"];
  const rows = sql
    .exec<SlotRow>(
      `SELECT s.*, r.title, r.base_servings, r.photo_key FROM slot AS s LEFT JOIN recipe AS r ON r.id = s.recipe_id
       WHERE s.date BETWEEN ? AND ? ORDER BY s.date`,
      ...range,
    )
    .toArray();
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
  const members = readMembers(sql);
  const defaults = members.map((member) => member.id);
  const allergens = readRecipeAllergens(
    sql,
    rows.flatMap((row) => (row.recipe_id === null ? [] : [row.recipe_id])),
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
      const conflicts = conflictsOf(members, allergens, {
        recipeId: row.recipe_id,
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
        servings: eating.length + row.guests,
        locked: row.locked === 1,
        conflicts: conflicts.map((conflict) => ({
          ...conflict,
          override:
            stored.find((override) => sameConflict(override, conflict) && override.cause === conflict.cause)?.reason ??
            null,
        })),
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
