import {
  type ConfirmationStatus,
  confirmationCaseOf,
  describeClearing,
  describeDeletion,
  describeMemberChange,
  describeOverride,
  describeRemoval,
  hardConstraintsOf,
  isToolName,
  type LocalDate,
  loosenedConstraints,
  type Meal,
  type Member,
  type MemberChange,
  type OverriddenFor,
  type Override,
  type ParsedToolInput,
  type PendingConfirmation,
  parseToolInput,
  type Slot,
  type SlotChangeSummary,
  type ToolName,
  type ToolResult,
  whoName,
} from "@mise/domain";
import { readRecipe, recipeNotFound } from "./recipes";
import { handlers, readMembers } from "./tools";

/**
 * Calls the agent made that wait for a person's tap (ADR 0024). Each is kept with what its button
 * says and the state it describes, as it was when the agent made it: a tap runs it only while that
 * state is unchanged. They are not exported (see `backup.ts`): the conversation that shows them isn't.
 */

/** What a held call's button says, and the state it describes, serialised to compare. */
type Held = { summary: string; state: string };

type OverridableTool = "set_slot" | "set_diners" | "set_guests" | "link_leftovers";
type MemberTool = "update_member" | "update_member_constraints" | "remove_member";

/**
 * Holds a call from the agent for a person's tap if it needs one, and returns it; null if it can run
 * now. Refuses a call whose subject doesn't exist, as running it would.
 */
export function holdIfGuarded(
  sql: SqlStorage,
  name: ToolName,
  input: unknown,
  parsed: unknown,
): ToolResult<PendingConfirmation | null> {
  const held = heldCall(sql, name, parsed);
  if (!held.ok) return held;
  if (held.value === null) return { ok: true, value: null };
  const { summary, state } = held.value;
  const { id } = sql
    .exec<{ id: number }>(
      `INSERT INTO pending_confirmation (tool, input, summary, state, status, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?) RETURNING id`,
      name,
      JSON.stringify(input ?? {}),
      summary,
      state,
      new Date().toISOString(),
    )
    .one();
  return { ok: true, value: { id, summary } };
}

type ConfirmationRow = { tool: string; input: string; summary: string; state: string; status: string };

function readRow(sql: SqlStorage, id: number): ConfirmationRow | undefined {
  return sql
    .exec<ConfirmationRow>("SELECT tool, input, summary, state, status FROM pending_confirmation WHERE id = ?", id)
    .toArray()[0];
}

/**
 * Claims the held call a tap runs, if it is still pending and the state it describes is unchanged,
 * marking it done so that a second tap finds nothing (`not_found`); `release` gives it back if the
 * call is then refused. One whose state changed is marked expired and refused (`expired`).
 */
export function takeConfirmation(sql: SqlStorage, id: unknown): ToolResult<{ name: ToolName; input: unknown }> {
  const row = typeof id === "number" ? readRow(sql, id) : undefined;
  if (row?.status !== "pending" || !isToolName(row.tool)) {
    return { ok: false, error: { code: "not_found", message: "Nothing is waiting for that tap" } };
  }
  const input: unknown = JSON.parse(row.input);
  if (currentState(sql, row) !== row.state) {
    sql.exec("UPDATE pending_confirmation SET status = 'expired' WHERE id = ?", id);
    return { ok: false, error: { code: "expired", message: "This has changed since Mise asked; ask again" } };
  }
  sql.exec("UPDATE pending_confirmation SET status = 'done' WHERE id = ?", id);
  return { ok: true, value: { name: row.tool, input } };
}

/** Withdraws a held call still waiting for its tap. */
export function cancelConfirmation(sql: SqlStorage, id: number): ToolResult<PendingConfirmation> {
  const row = readRow(sql, id);
  if (row?.status !== "pending") {
    return { ok: false, error: { code: "not_found", message: "Nothing is waiting for that tap" } };
  }
  sql.exec("UPDATE pending_confirmation SET status = 'cancelled' WHERE id = ?", id);
  return { ok: true, value: { id, summary: row.summary } };
}

/** Gives back a held call `takeConfirmation` claimed, when running it was refused. */
export function releaseConfirmation(sql: SqlStorage, id: number): void {
  sql.exec("UPDATE pending_confirmation SET status = 'pending' WHERE id = ?", id);
}

/** A held call as the chat shows it: expired, without being marked so, once its state has changed. */
export function confirmationShown(sql: SqlStorage, id: number): { summary: string; status: ConfirmationStatus } | null {
  const row = readRow(sql, id);
  if (!row) return null;
  const status = row.status === "pending" && currentState(sql, row) !== row.state ? "expired" : row.status;
  return { summary: row.summary, status: status as ConfirmationStatus };
}

/** The state a stored call describes now; null once its input no longer parses, which never matches. */
function currentState(sql: SqlStorage, row: ConfirmationRow): string | null {
  const parsed = parseToolInput(row.tool, JSON.parse(row.input));
  if (!parsed.ok || !isToolName(row.tool)) return null;
  const held = heldCall(sql, row.tool, parsed.value);
  return held.ok && held.value ? held.value.state : null;
}

/** What a call's button would say and the state it describes, if it needs a tap; null if it doesn't. */
function heldCall(sql: SqlStorage, name: ToolName, input: unknown): ToolResult<Held | null> {
  switch (confirmationCaseOf(name)) {
    case undefined:
      return { ok: true, value: null };
    case "always":
      if (name === "delete_recipe") return deletion(sql, input as ParsedToolInput<"delete_recipe">);
      if (name === "clear_week") return clearing(sql, input as ParsedToolInput<"clear_week">);
      throw new Error(`No confirmation describes ${name}`);
    case "override":
      return override(sql, name as OverridableTool, input as ParsedToolInput<OverridableTool>);
    case "member":
      return memberChange(sql, name as MemberTool, input as ParsedToolInput<MemberTool>);
  }
}

function deletion(sql: SqlStorage, input: ParsedToolInput<"delete_recipe">): ToolResult<Held> {
  const recipe = readRecipe(sql, input.id);
  if (!recipe) return recipeNotFound(input.id);
  return { ok: true, value: { summary: describeDeletion(recipe.title), state: JSON.stringify(recipe) } };
}

function clearing(sql: SqlStorage, input: ParsedToolInput<"clear_week">): ToolResult<Held> {
  const week = handlers.get_week(sql, { date: input.date }, { caller: null });
  if (!week.ok) return week;
  return { ok: true, value: { summary: describeClearing(week.value.startDate), state: JSON.stringify(week.value) } };
}

/**
 * A change carrying Overrides. It describes the Slots changed (and the one Leftovers are linked to),
 * the Recipe it plans and the Members, whose Constraints its Conflicts come from.
 */
function override(
  sql: SqlStorage,
  name: OverridableTool,
  input: ParsedToolInput<OverridableTool>,
): ToolResult<Held | null> {
  const overrides: Override[] = input.overrides ?? [];
  if (overrides.length === 0) return { ok: true, value: null };
  // A button names a Slot's new Recipe and the Conflicts overridden; anything else would run unsaid.
  if (name === "set_slot" && ["note", "diners", "guests", "guestConstraints"].some((field) => field in input)) {
    return foldedIn("a note, Diners or Guests");
  }
  const planned = name === "set_slot" && "recipeId" in input ? input.recipeId : null;
  const recipe = planned === null ? null : readRecipe(sql, planned);
  if (planned !== null && !recipe) return recipeNotFound(planned);

  const meal = "meal" in input ? input.meal : undefined;
  const slots = slotsOn(sql, input.date, meal);
  if (!slots.ok) return slots;
  const of = name === "link_leftovers" ? (input as ParsedToolInput<"link_leftovers">).of : null;
  const linked = of ? slotsOn(sql, of.date, of.meal) : { ok: true as const, value: [] };
  if (!linked.ok) return linked;

  const members = readMembers(sql);
  const guestConstraints =
    ("guestConstraints" in input ? input.guestConstraints : undefined) ?? slots.value[0]?.guestConstraints ?? [];
  const overridden: OverriddenFor[] = overrides.map(({ who, allergen }) => {
    const constraints = who === "guests" ? guestConstraints : (members.find((m) => m.id === who)?.constraints ?? []);
    const hard = hardConstraintsOf({ constraints }).find((constraint) => constraint.allergen === allergen);
    return { who, allergen, name: whoName(who, members), constraint: hard?.kind ?? null };
  });

  const change = slotChange(name, input, recipe?.title ?? "", members);
  return {
    ok: true,
    value: {
      summary: describeOverride(change, overridden),
      state: JSON.stringify({ slots: slots.value, linked: linked.value, recipe, members }),
    },
  };
}

function slotChange(
  name: OverridableTool,
  input: ParsedToolInput<OverridableTool>,
  title: string,
  members: readonly Member[],
): SlotChangeSummary {
  switch (name) {
    case "set_slot": {
      const { date, meal, kind } = input as ParsedToolInput<"set_slot">;
      return kind === "recipe" ? { kind: "plan", title, date, meal } : { kind: "set", to: kind, date, meal };
    }
    case "set_diners": {
      const { date, meal, diners } = input as ParsedToolInput<"set_diners">;
      return { kind: "diners", diners: diners === null ? null : diners.map((id) => whoName(id, members)), date, meal };
    }
    case "set_guests": {
      const { date, meal, guests, guestConstraints } = input as ParsedToolInput<"set_guests">;
      return { kind: "guests", guests, constraints: guestConstraints, date, meal };
    }
    case "link_leftovers": {
      const { date, meal, of } = input as ParsedToolInput<"link_leftovers">;
      return { kind: "leftovers", date, meal, of };
    }
  }
}

/** The Slots of a date, or just its `meal`. */
function slotsOn(sql: SqlStorage, date: LocalDate, meal: Meal | undefined): ToolResult<Slot[]> {
  const week = handlers.get_week(sql, { date }, { caller: null });
  if (!week.ok) return week;
  const slots = week.value.slots.filter((slot) => slot.date === date && (meal === undefined || slot.meal === meal));
  return { ok: true, value: slots };
}

/**
 * A change to a Member that loosens a Hard Constraint or changes their name or sign-in email. It
 * describes the Member. One that does neither, or of a Member who doesn't exist (which the tool
 * refuses), needs no tap.
 */
function memberChange(sql: SqlStorage, name: MemberTool, input: ParsedToolInput<MemberTool>): ToolResult<Held | null> {
  const member: Member | undefined = readMembers(sql, input.id)[0];
  if (!member) return { ok: true, value: null };
  const state = JSON.stringify(member);
  if (name === "remove_member") {
    const hard = hardConstraintsOf(member);
    return { ok: true, value: hard.length > 0 ? { summary: describeRemoval(member.name, hard), state } : null };
  }
  const { name: newName, email, constraints } = input as ParsedToolInput<"update_member">;
  const after = constraints ?? member.constraints;
  const change: MemberChange = {
    ...(newName !== undefined && newName !== member.name && { name: newName }),
    ...(email !== undefined && email !== member.email && { email }),
    loosened: loosenedConstraints(member.constraints, after),
    after,
  };
  if (change.name === undefined && change.email === undefined && change.loosened.length === 0) {
    return { ok: true, value: null };
  }
  return { ok: true, value: { summary: describeMemberChange(member, change), state } };
}

/** Refuses a call that would fold `what` into a change waiting for a tap, which its button doesn't name. */
function foldedIn<T>(what: string): ToolResult<T> {
  return {
    ok: false,
    error: {
      code: "invalid_input",
      message: `This change waits for the person's tap, and its button can't also change ${what}: make that change in a separate call.`,
    },
  };
}
