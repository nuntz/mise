import {
  type Constraint,
  Household,
  HouseholdSettings,
  Member,
  type MemberId,
  type NewMember,
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

type MemberRow = { id: number; name: string; email: string | null };

type ConstraintRow = { member_id: number; kind: string; allergen: string | null; term: string | null };

type Handlers = {
  [N in ToolName]: (sql: SqlStorage, input: ParsedToolInput<N>, context: ToolContext) => ToolResult<ToolOutput<N>>;
};

/** The implementation of every tool in the registry, against the household's SQLite. */
export const handlers: Handlers = {
  get_household: (sql) => ({ ok: true, value: readHousehold(sql) }),

  setup_household: (sql, input) => {
    if (readSettings(sql)) {
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
    for (const member of input.members) {
      const added = insertMember(sql, member);
      if (!added.ok) return added;
    }
    return { ok: true, value: readHousehold(sql) as Household };
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
    sql.exec("DELETE FROM member WHERE id = ?", member.id);
    return { ok: true, value: member };
  },

  get_caller: (sql, _input, { caller }) => ({
    ok: true,
    value: caller && { ...caller, member: memberSignedInAs(sql, caller.email) },
  }),
};

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
}

/** The Member who signs in as `email`; Caller and Member emails are both lower case. */
function memberSignedInAs(sql: SqlStorage, email: string): Member | null {
  const [row] = sql.exec<{ id: number }>("SELECT id FROM member WHERE email = ?", email).toArray();
  return row ? readMember(sql, row.id) : null;
}

function emailInUse(sql: SqlStorage, email: string, exceptId?: MemberId): boolean {
  return sql.exec("SELECT 1 FROM member WHERE email = ? AND id IS NOT ?", email, exceptId ?? null).toArray().length > 0;
}

function readSettings(sql: SqlStorage): HouseholdSettings | null {
  const [row] = sql.exec<HouseholdRow>("SELECT * FROM household WHERE id = 1").toArray();
  if (!row) return null;
  return HouseholdSettings.parse({
    name: row.name,
    timezone: row.timezone,
    dinnerTime: row.dinner_time,
    weekStartsOn: row.week_starts_on,
    units: row.units,
    locale: row.locale,
  });
}

function readHousehold(sql: SqlStorage): Household | null {
  const settings = readSettings(sql);
  if (!settings) return null;
  return Household.parse({ ...settings, members: readMembers(sql) });
}

function readMember(sql: SqlStorage, id: MemberId): Member | null {
  return readMembers(sql, id)[0] ?? null;
}

/** Every Member in the order they were added, or just the one with `id`. */
function readMembers(sql: SqlStorage, id?: MemberId): Member[] {
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
      constraints: constraints
        .filter((constraint) => constraint.member_id === row.id)
        .map(({ kind, allergen, term }) => ({
          kind,
          ...(allergen !== null && { allergen }),
          ...(term !== null && { term }),
        })),
    }),
  );
}

function notSetUp<T>(): ToolResult<T> {
  return { ok: false, error: { code: "not_set_up", message: "Set up the Household first" } };
}

function emailTaken<T>(email: string): ToolResult<T> {
  return { ok: false, error: { code: "email_in_use", message: `Another Member signs in as ${email}` } };
}

function memberNotFound<T>(id: MemberId): ToolResult<T> {
  return { ok: false, error: { code: "not_found", message: `No Member with id ${id}` } };
}
