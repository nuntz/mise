import {
  Household,
  type ParsedToolInput,
  type ToolContext,
  type ToolName,
  type ToolOutput,
  type ToolResult,
} from "@mise/domain";

type HouseholdRow = {
  name: string;
  timezone: string;
  dinner_time: string;
  week_starts_on: string;
  units: string;
  locale: string;
};

type Handlers = {
  [N in ToolName]: (sql: SqlStorage, input: ParsedToolInput<N>, context: ToolContext) => ToolResult<ToolOutput<N>>;
};

/** The implementation of every tool in the registry, against the household's SQLite. */
export const handlers: Handlers = {
  get_household: (sql) => ({ ok: true, value: readHousehold(sql) }),

  setup_household: (sql, input) => {
    if (readHousehold(sql)) {
      return { ok: false, error: { code: "already_set_up", message: "The Household is already set up" } };
    }
    sql.exec(
      `INSERT INTO household (id, name, timezone, dinner_time, week_starts_on, units, locale)
       VALUES (1, ?, ?, ?, ?, ?, ?)`,
      input.name,
      input.timezone,
      input.dinnerTime,
      input.weekStartsOn,
      input.units,
      input.locale,
    );
    return { ok: true, value: input };
  },

  get_caller: (_sql, _input, context) => ({ ok: true, value: context.caller }),
};

function readHousehold(sql: SqlStorage): Household | null {
  const [row] = sql.exec<HouseholdRow>("SELECT * FROM household WHERE id = 1").toArray();
  if (!row) return null;
  return Household.parse({
    name: row.name,
    timezone: row.timezone,
    dinnerTime: row.dinner_time,
    weekStartsOn: row.week_starts_on,
    units: row.units,
    locale: row.locale,
  });
}
