import {
  type Constraint,
  currentWeekStart,
  type HouseholdSettings,
  type LocalDate,
  MEALS,
  type Meal,
  type MemberId,
  Slot,
  type Week,
  weekDates,
  weekStartOf,
} from "@mise/domain";
import { recipeNotFound } from "./recipes";
import { type ConstraintColumns, constraintOf, type Handlers, memberNotFound, notSetUp, readSettings } from "./tools";

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

type WeekTools = "get_week" | "set_slot" | "set_diners" | "set_guests" | "lock_slot" | "clear_week";

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
    if (recipeId !== null && sql.exec("SELECT 1 FROM recipe WHERE id = ?", recipeId).toArray().length === 0) {
      return recipeNotFound(recipeId);
    }
    storeSlot(sql, settings, input.date, input.meal);
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
    return { ok: true, value: readSlot(sql, input.date, input.meal) };
  },

  set_diners: (sql, input) => {
    const settings = readSettings(sql);
    if (!settings) return notSetUp();
    const members = memberIds(sql);
    const unknown = input.diners?.find((id) => !members.includes(id));
    if (unknown !== undefined) return memberNotFound(unknown);
    const meals = input.meal ? [input.meal] : MEALS;
    for (const meal of meals) {
      storeSlot(sql, settings, input.date, meal);
      sql.exec(
        "UPDATE slot SET diners_chosen = ? WHERE date = ? AND meal = ?",
        Number(input.diners !== null),
        input.date,
        meal,
      );
      sql.exec("DELETE FROM slot_diner WHERE date = ? AND meal = ?", input.date, meal);
      for (const id of input.diners ?? []) {
        sql.exec("INSERT INTO slot_diner (date, meal, member_id) VALUES (?, ?, ?)", input.date, meal, id);
      }
    }
    return { ok: true, value: meals.map((meal) => readSlot(sql, input.date, meal)) };
  },

  set_guests: (sql, input) => {
    const settings = readSettings(sql);
    if (!settings) return notSetUp();
    storeSlot(sql, settings, input.date, input.meal);
    sql.exec("UPDATE slot SET guests = ? WHERE date = ? AND meal = ?", input.guests, input.date, input.meal);
    if (input.guestConstraints) writeGuestConstraints(sql, input, input.guestConstraints);
    return { ok: true, value: readSlot(sql, input.date, input.meal) };
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
    for (const table of ["slot_diner", "slot_guest_constraint", "slot"]) {
      sql.exec(`DELETE FROM ${table} WHERE date BETWEEN ? AND ?`, ...range);
    }
    return { ok: true, value: readWeek(sql, dates[0] as LocalDate) };
  },
};

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
  const defaults = memberIds(sql);
  const of = <T extends SlotKey>(all: T[], row: SlotKey) =>
    all.filter((other) => other.date === row.date && other.meal === row.meal);

  return rows
    .map((row) => {
      const eating = row.diners_chosen === 1 ? of(diners, row).map((diner) => diner.member_id) : defaults;
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
        guestConstraints: of(guestConstraints, row).map(constraintOf),
        servings: eating.length + row.guests,
        locked: row.locked === 1,
      });
    })
    .sort((a, b) => a.date.localeCompare(b.date) || MEALS.indexOf(a.meal) - MEALS.indexOf(b.meal));
}

/** The Household's default Diners: every Member, in the order they were added. */
function memberIds(sql: SqlStorage): MemberId[] {
  return sql
    .exec<{ id: number }>("SELECT id FROM member ORDER BY id")
    .toArray()
    .map((row) => row.id);
}
