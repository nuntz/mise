import {
  type Constraint,
  changeWeekStart,
  DEFAULT_EFFORT_BUDGETS,
  EffortBudgets,
  Household,
  HouseholdSettings,
  localDate,
  Member,
  type MemberId,
  type NewMember,
  type ParsedToolInput,
  type ToolContext,
  type ToolName,
  type ToolOutput,
  type ToolResult,
  WeekCalendar,
} from "@mise/domain";
import { calendarHandlers, readCalendarToken } from "./calendar";
import { cancelConfirmation } from "./confirmations";
import { draftHandlers } from "./drafts";
import { readDriveDocs } from "./drive";
import { groceryHandlers, readGroceryBuilds, readGroceryLines, readStoreSections } from "./grocery";
import { importHandlers, readImportFlags, readImportRuns } from "./imports";
import { itemHandlers, readCatalogue } from "./items";
import { kitchenDisplayHandlers, readKitchenDisplays } from "./kitchenDisplays";
import { pushHandlers, readPushSubscriptions } from "./pushDevices";
import { readyMadeHandlers } from "./readyMade";
import { readRecipes, recipeHandlers } from "./recipes";
import { readStaples, stapleHandlers } from "./staples";
import { readSuggestions, suggestionHandlers } from "./suggestions";
import { readChatTurns } from "./turns";
import { readSlots, readWeekRecords, weekHandlers } from "./weeks";

type HouseholdRow = {
  name: string;
  timezone: string;
  dinner_time: string;
  week_starts_on: string;
  units: string;
  locale: string;
  voice_minutes_per_day: number;
};

type MemberRow = { id: number; name: string; email: string | null };

/** A stored Constraint's columns, as a Member's and a Slot's Guests' are kept. */
export type ConstraintColumns = { kind: string; allergen: string | null; term: string | null };

type ConstraintRow = ConstraintColumns & { member_id: number };

/**
 * Tools that need more than SQLite, which the household runs itself: a Paprika import reads R2;
 * Suggestions and a text import ask the model; a link import fetches the page, and may ask it too;
 * a Drive sync reads the Drive folder and asks the model; the push key is a Worker secret.
 */
export type HouseholdToolName =
  | "run_paprika_import"
  | "request_suggestions"
  | "import_text"
  | "import_url"
  | "import_screenshots"
  | "sync_drive_folder"
  | "get_push_key";

export type Handlers = {
  [N in Exclude<ToolName, HouseholdToolName>]: (
    sql: SqlStorage,
    input: ParsedToolInput<N>,
    context: ToolContext,
  ) => ToolResult<ToolOutput<N>>;
};

/** The implementation of every other tool in the registry, against the household's SQLite. */
export const handlers: Handlers = {
  get_household: (sql) => ({ ok: true, value: readHousehold(sql) }),

  setup_household: (sql, input) => {
    if (readSettings(sql)) {
      return { ok: false, error: { code: "already_set_up", message: "The Household is already set up" } };
    }
    sql.exec(
      `INSERT INTO household (id, name, timezone, dinner_time, week_starts_on, units, locale, voice_minutes_per_day)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
      input.name,
      input.timezone,
      input.dinnerTime,
      input.weekStartsOn,
      input.units,
      input.locale,
      input.voiceMinutesPerDay,
    );
    for (const member of input.members) {
      const added = insertMember(sql, member);
      if (!added.ok) return added;
    }
    return { ok: true, value: readHousehold(sql) as Household };
  },

  /**
   * A new week start applies from the next Week (ADR 0021): the current Week and those already
   * stored after it keep their dates, judged by today in the new timezone.
   */
  update_household_settings: (sql, input) => {
    const settings = readSettings(sql);
    if (!settings) return notSetUp();
    const updated = { ...settings, ...input };
    if (input.weekStartsOn !== undefined) {
      const created = sql
        .exec<{ start_date: string }>("SELECT start_date FROM week")
        .toArray()
        .map((row) => row.start_date);
      const today = localDate(new Date(), updated.timezone);
      const changes = changeWeekStart(settings, updated.weekStartsOn, today, created);
      sql.exec("DELETE FROM week_start_change");
      for (const change of changes) {
        sql.exec("INSERT INTO week_start_change (from_date, stretches) VALUES (?, ?)", change.from, change.stretches);
      }
    }
    sql.exec(
      `UPDATE household SET name = ?, timezone = ?, dinner_time = ?, week_starts_on = ?, units = ?, locale = ?,
       voice_minutes_per_day = ? WHERE id = 1`,
      updated.name,
      updated.timezone,
      updated.dinnerTime,
      updated.weekStartsOn,
      updated.units,
      updated.locale,
      updated.voiceMinutesPerDay,
    );
    return { ok: true, value: readHousehold(sql) as Household };
  },

  set_effort_budgets: (sql, input) => {
    if (!readSettings(sql)) return notSetUp();
    for (const [weekday, minutes] of Object.entries(input.budgets)) {
      sql.exec("INSERT OR REPLACE INTO effort_budget (weekday, minutes) VALUES (?, ?)", weekday, minutes);
    }
    return { ok: true, value: readEffortBudgets(sql) };
  },

  add_member: (sql, input) => {
    if (!readSettings(sql)) return notSetUp();
    return insertMember(sql, input);
  },

  update_member: (sql, input) => {
    const member = readMember(sql, input.id);
    if (!member) return memberNotFound(input.id);
    const name = input.name ?? member.name;
    const email = input.email === undefined ? member.email : input.email;
    if (email !== null && emailInUse(sql, email, member.id)) return emailTaken(email);
    const constraints = input.constraints ?? member.constraints;
    sql.exec("UPDATE member SET name = ?, email = ? WHERE id = ?", name, email, member.id);
    if (input.constraints) writeConstraints(sql, member.id, input.constraints);
    return { ok: true, value: { id: member.id, name, email, constraints } };
  },

  update_member_constraints: (sql, input) => {
    const member = readMember(sql, input.id);
    if (!member) return memberNotFound(input.id);
    writeConstraints(sql, member.id, input.constraints);
    return { ok: true, value: { ...member, constraints: input.constraints } };
  },

  remove_member: (sql, input) => {
    const member = readMember(sql, input.id);
    if (!member) return memberNotFound(input.id);
    sql.exec("DELETE FROM member_constraint WHERE member_id = ?", member.id);
    // Slots they were chosen to eat go on without them, and need no Override for them.
    sql.exec("DELETE FROM slot_diner WHERE member_id = ?", member.id);
    sql.exec("DELETE FROM slot_override WHERE member_id = ?", member.id);
    // What they thought of what they ate still counts, without their name.
    sql.exec("UPDATE slot_rating SET member_id = NULL WHERE member_id = ?", member.id);
    sql.exec("DELETE FROM member WHERE id = ?", member.id);
    return { ok: true, value: member };
  },

  ...recipeHandlers,
  ...readyMadeHandlers,
  ...itemHandlers,
  ...suggestionHandlers,
  ...importHandlers,
  ...draftHandlers,
  ...weekHandlers,
  ...groceryHandlers,
  ...stapleHandlers,
  ...calendarHandlers,
  ...kitchenDisplayHandlers,
  ...pushHandlers,

  // Called when the call is made, so that confirmations.ts, which reads through these handlers, can import them.
  cancel_confirmation: (sql, input) => cancelConfirmation(sql, input.id),

  get_caller: (sql, _input, { caller }) => ({
    ok: true,
    value: caller && { ...caller, member: memberSignedInAs(sql, caller.email) },
  }),
};

/**
 * Reads every stored row the tools read through the domain parsers, settings or not, so that data no
 * tool can read throws here (a `ZodError`). A new domain table needs its reader added.
 */
export function parseStoredHousehold(sql: SqlStorage): void {
  readSettings(sql);
  readEffortBudgets(sql);
  readMembers(sql);
  readCatalogue(sql);
  readSuggestions(sql);
  readRecipes(sql);
  readImportRuns(sql);
  readImportFlags(sql);
  readSlots(sql);
  readWeekRecords(sql);
  readStoreSections(sql);
  readGroceryBuilds(sql);
  readGroceryLines(sql);
  readStaples(sql);
  readCalendarToken(sql);
  readKitchenDisplays(sql);
  readDriveDocs(sql);
  readChatTurns(sql);
  readPushSubscriptions(sql);
}

function insertMember(sql: SqlStorage, member: NewMember): ToolResult<Member> {
  if (member.email !== null && emailInUse(sql, member.email)) return emailTaken(member.email);
  const { id } = sql
    .exec<{ id: number }>("INSERT INTO member (name, email) VALUES (?, ?) RETURNING id", member.name, member.email)
    .one();
  writeConstraints(sql, id, member.constraints);
  return { ok: true, value: readMember(sql, id) as Member };
}

function writeConstraints(sql: SqlStorage, memberId: MemberId, constraints: Constraint[]): void {
  sql.exec("DELETE FROM member_constraint WHERE member_id = ?", memberId);
  constraints.forEach((constraint, position) => {
    sql.exec(
      "INSERT INTO member_constraint (member_id, position, kind, allergen, term) VALUES (?, ?, ?, ?, ?)",
      memberId,
      position,
      constraint.kind,
      constraint.allergen ?? null,
      constraint.term ?? null,
    );
  });
  // An Override is for a Hard Constraint: one taken away and given back later needs a new reason.
  const hard = constraints.flatMap((constraint) => (constraint.kind === "dislike" ? [] : [constraint.allergen]));
  sql.exec(
    "DELETE FROM slot_override WHERE member_id = ? AND allergen NOT IN (SELECT value FROM json_each(?))",
    memberId,
    JSON.stringify(hard),
  );
}

/** The Member who signs in as `email`; Caller and Member emails are both lower case. */
export function memberSignedInAs(sql: SqlStorage, email: string): Member | null {
  const [row] = sql.exec<{ id: number }>("SELECT id FROM member WHERE email = ?", email).toArray();
  return row ? readMember(sql, row.id) : null;
}

function emailInUse(sql: SqlStorage, email: string, exceptId?: MemberId): boolean {
  return sql.exec("SELECT 1 FROM member WHERE email = ? AND id IS NOT ?", email, exceptId ?? null).toArray().length > 0;
}

/** A stored Constraint, unparsed: the caller parses it with what it belongs to. */
export function constraintOf({ kind, allergen, term }: ConstraintColumns): unknown {
  return { kind, ...(allergen !== null && { allergen }), ...(term !== null && { term }) };
}

/** The Household's settings, with the changes of week start that, with them, decide its Weeks. */
export type SettingsAndCalendar = HouseholdSettings & WeekCalendar;

export function readSettings(sql: SqlStorage): SettingsAndCalendar | null {
  const [row] = sql.exec<HouseholdRow>("SELECT * FROM household WHERE id = 1").toArray();
  if (!row) return null;
  const settings = HouseholdSettings.parse({
    name: row.name,
    timezone: row.timezone,
    dinnerTime: row.dinner_time,
    weekStartsOn: row.week_starts_on,
    units: row.units,
    locale: row.locale,
    voiceMinutesPerDay: row.voice_minutes_per_day,
  });
  const weekStartChanges = sql
    .exec<{ from_date: string; stretches: string }>("SELECT * FROM week_start_change ORDER BY from_date")
    .toArray()
    .map((row) => ({ from: row.from_date, stretches: row.stretches }));
  // Parsed with the week start, so changes that would leave a date in no Week, or in two, throw.
  return { ...settings, ...WeekCalendar.parse({ weekStartsOn: settings.weekStartsOn, weekStartChanges }) };
}

function readHousehold(sql: SqlStorage): Household | null {
  const settings = readSettings(sql);
  if (!settings) return null;
  return Household.parse({
    ...settings,
    members: readMembers(sql),
    effortBudgets: readEffortBudgets(sql),
    storeSections: readStoreSections(sql),
  });
}

/** The Household's default Effort Budget for every weekday: its own where it set one. */
export function readEffortBudgets(sql: SqlStorage): EffortBudgets {
  const rows = sql.exec<{ weekday: string; minutes: number }>("SELECT weekday, minutes FROM effort_budget").toArray();
  return EffortBudgets.parse({
    ...DEFAULT_EFFORT_BUDGETS,
    ...Object.fromEntries(rows.map((row) => [row.weekday, row.minutes])),
  });
}

function readMember(sql: SqlStorage, id: MemberId): Member | null {
  return readMembers(sql, id)[0] ?? null;
}

/** Every Member in the order they were added, or just the one with `id`. */
export function readMembers(sql: SqlStorage, id?: MemberId): Member[] {
  const members = sql
    .exec<MemberRow>("SELECT id, name, email FROM member WHERE ? IS NULL OR id = ? ORDER BY id", id ?? null, id ?? null)
    .toArray();
  const constraints = sql
    .exec<ConstraintRow>(
      `SELECT member_id, kind, allergen, term FROM member_constraint
       WHERE ? IS NULL OR member_id = ? ORDER BY member_id, position`,
      id ?? null,
      id ?? null,
    )
    .toArray();
  return members.map((row) =>
    Member.parse({
      ...row,
      constraints: constraints.filter((constraint) => constraint.member_id === row.id).map(constraintOf),
    }),
  );
}

export function notSetUp<T>(): ToolResult<T> {
  return { ok: false, error: { code: "not_set_up", message: "Set up the Household first" } };
}

function emailTaken<T>(email: string): ToolResult<T> {
  return { ok: false, error: { code: "email_in_use", message: `Another Member signs in as ${email}` } };
}

export function memberNotFound<T>(id: MemberId): ToolResult<T> {
  return { ok: false, error: { code: "not_found", message: `No Member with id ${id}` } };
}
