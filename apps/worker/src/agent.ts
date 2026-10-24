import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type Models, Type } from "@earendil-works/pi-ai";
import type {
  Conversation,
  ConversationId,
  Cursor,
  EntryRecord,
  Extension,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import {
  type Caller,
  type ChatMessage,
  type Constraint,
  capitalised,
  type Household,
  ItemId,
  localDate,
  type ToolName,
  type ToolResult,
  tools,
  weekdayOf,
} from "@mise/domain";
import type { PiModel } from "agents/harness/pi";
import { z } from "zod";
import { anthropicModels } from "./llm";

/** The agent's model (SPEC §2): Haiku, until multi-constraint requests show it drops clauses. */
export const AGENT_MODEL: PiModel = { provider: "anthropic", id: "claude-haiku-5-5" };

/** The models the agent can run on, and the one a new conversation starts with. */
export type AgentModels = { models: Models; model: PiModel };

let replacement: ((env: Env) => AgentModels) | undefined;

/**
 * Runs the agent on other models from the next household started, or on Claude again with
 * `undefined`. Tests put it on pi-ai's faux provider, so no test calls a real model.
 */
export function useAgentModels(open: ((env: Env) => AgentModels) | undefined): void {
  replacement = open;
}

/** Claude, with the deployment's Anthropic key (a Worker secret). */
export function agentModels(env: Env): AgentModels {
  if (replacement) return replacement(env);
  return { models: anthropicModels(env.ANTHROPIC_API_KEY), model: AGENT_MODEL };
}

/**
 * The transcript entry a Member's turn is placed as. Its data names the turn's speaker record (the
 * household's `chat_turn` row) and holds what they typed; the model is shown it with who said it and
 * from where (see `presentTurn`).
 */
export const TURN_ENTRY = "mise.turn";
export type TurnData = { turn: number; text: string };

/** What the agent needs from the household. */
export type AgentHost = {
  /** A tool call through the household's validated entry point (ADR 0002), made as `caller`. */
  callTool(name: ToolName, input: unknown, caller: Caller | null): Promise<ToolResult<unknown>>;
  /** The Caller of the turn the conversation is answering: the one its tools run as. */
  speakerIn(conversation: ConversationId): Promise<Caller | null>;
};

/**
 * The tools the agent is offered, each described for the model. Left out: `setup_household`, which
 * would recreate the Household; tools that take an upload, which comes over HTTP; deleting, clearing
 * and changing Members, which need a person's tap (ADR 0024, #40); accepting a Suggestion or a
 * Draft, resolving an Ingredient or stating an Item's Allergens, which only a person does (ADR 0023);
 * and rotating the calendar token, which stops every subscribed calendar until it is added again.
 */
const AGENT_TOOLS: Partial<Record<ToolName, string>> = {
  get_household:
    "The Household: its settings, Members (with ids and Constraints), default Effort Budgets and Store Sections.",
  get_caller: "Who is speaking: their email, and the Member they sign in as, if any.",
  update_household_settings: "Changes the Household's settings given: name, timezone, dinner time, week start, units.",
  set_effort_budgets: "Sets the Household's default Effort Budget (cooking minutes) for the weekdays given.",
  add_member: "Adds a Member to the Household, with any Constraints.",
  search_recipes: "Recipes whose title matches `query`, or with `tag`, in title order. Drafts are left out.",
  get_recipe: "One Recipe in full: Ingredients, steps, servings, time, Course and tags.",
  create_recipe: "Creates a Recipe from a title, base servings and Ingredient lines as written.",
  update_recipe: "Changes the fields given of a Recipe, or of a Draft before a person accepts it.",
  list_untagged_recipes: "Recipes missing a cuisine or a main protein.",
  list_unresolved_ingredients: "Ingredient lines no Item matches, grouped by text, most frequent first.",
  request_suggestions:
    "Asks the model for Suggestions for Unresolved Ingredients, one batch per call. Suggestions change nothing until a person accepts them on the Resolve Ingredients screen.",
  list_suggestions: "Suggestions waiting for a person to accept or dismiss them.",
  dismiss_suggestion: "Dismisses a Suggestion.",
  list_items: "Every Item (ingredient) Mise knows, with its id, name, aliases and Allergens.",
  import_url:
    "Imports the recipe at a link: a recipe page, a TikTok or an Instagram post. What a model read becomes a Draft for a person to check.",
  import_text: "Reads a recipe's pasted text into a Draft for a person to check.",
  sync_drive_folder: "Reads new and changed Google Docs from the Household's Drive folder into Drafts.",
  list_drafts: "Draft Recipes waiting for a person to check and accept them.",
  list_import_runs: "Import runs, newest first, with what each did.",
  list_import_flags: "Recipes an import flagged for a merge or as a possible duplicate.",
  get_week:
    "The Week containing `date` (YYYY-MM-DD), or this Week without one: every breakfast, lunch and dinner, " +
    "with its Recipe, Diners, Guests, Conflicts, whether it is Locked, and the Proposer's `reason` for a proposed one.",
  set_slot:
    "Sets what a Slot is: a Recipe (not a Draft), leftovers, eating out, unplanned or skipped. Refused with " +
    "`constraint_conflict` if it would bring a Conflict.",
  set_diners:
    "Sets which Members eat a Slot, or every meal of a day when `meal` is left out; null goes back to everyone. " +
    "Refused with `constraint_conflict` if it would bring a Conflict.",
  set_guests: "Sets how many Guests eat a Slot, and their Constraints. Refused if it would bring a Conflict.",
  link_leftovers: "Makes a Slot Leftovers of an earlier Slot that holds a Recipe, which is then cooked for both.",
  check_slot_constraints: "What Conflicts a change to a Slot would bring, without making it.",
  lock_slot: "Locks a Slot so proposing the Week again keeps it, or unlocks it.",
  propose_week:
    "Fills the Week's dinners that aren't Locked or decided by hand, each with a reason. `reroll: true` proposes " +
    "again differently; `useUp` lists Item ids on hand, to favour Recipes that use them.",
  set_week_effort_budgets: "Overrides the Effort Budget of the weekdays given for one Week; null goes back.",
  review_week: "Marks the Week as looked over since it was proposed, or not.",
  mark_cooked: "Marks a Slot cooked, today or earlier.",
  rate_recipe: "Rates a cooked Slot's Recipe for the Member speaking.",
  set_store_section_order: "Puts the Store Sections given first, in the order the Household walks its store.",
  get_calendar_token: "The calendar feed's token, for the feed's address; null until one is made on the screen.",
  build_grocery_list: "Builds or rebuilds the Week's Grocery List from its plan and Staples.",
  get_grocery_list: "The Week's Grocery List; null until it is first built.",
  set_have_tick: "Ticks a Grocery List line as already had, or unticks it, as of `at` (now).",
  add_grocery_line: "Adds a line to the Week's Grocery List.",
  upsert_staple: "Makes an Item a Staple, or changes how it is kept and checked.",
  remove_staple: "Stops an Item being a Staple.",
  list_staples: "The Household's Staples, with how each stands (stocked, low, out).",
  list_due_staples: "The Staples a pantry check-in asks about today.",
  record_staple_status: "Records a Staple as stocked, low or out. An Item must be a Staple first (`upsert_staple`).",
};

/** The tools that can carry Overrides, which only a person's tap may record (ADR 0024). */
const OVERRIDABLE: ReadonlySet<ToolName> = new Set(["set_slot", "set_diners", "set_guests", "link_leftovers"]);

/** Mise as a Pi extension: who the agent works for, and the tools it may call. */
export function miseExtension(host: AgentHost): Extension {
  return {
    name: "mise",
    sections: [{ key: "preamble", tag: false, render: async () => preamble(await household(host)) }],
    tools: Object.entries(AGENT_TOOLS).map(([name, description]) => agentTool(name as ToolName, description, host)),
  };
}

function preamble(household: Household | null): string {
  if (!household) return "You are Mise, a family meal planner. This Household is not set up yet.";
  const today = localDate(new Date(), household.timezone);
  return [
    `You are Mise, the meal planner of ${household.name}. You talk with its Members in a short, friendly way.`,
    `Today is ${capitalised(weekdayOf(today))} ${today} in the Household's timezone (${household.timezone}). ` +
      `Weeks start on ${capitalised(household.weekStartsOn)}; dinner is at ${household.dinnerTime}.`,
    "Members:",
    ...(household.members.length > 0
      ? household.members.map((member) => `- ${member.name} (Member ${member.id})${constraintsOf(member.constraints)}`)
      : ["- none yet"]),
    "",
    "Each message starts with who is speaking and the screen (and Week) they are looking at, in brackets. " +
      "“I”, “me” and “us” mean that speaker; “this week” and day names mean the Week they see.",
    "Change things only through the tools. Answer from what they return: never guess what is planned, read it.",
    "To explain a Proposal, use only each Slot's `reason` from `get_week`; don't invent others.",
    "When a change is refused for a Conflict, say who and which Allergen. You cannot override a Conflict, delete " +
      "anything, clear a Week, change or remove Members' Constraints, or accept Drafts and Suggestions: say the person " +
      "can do it on the screen.",
  ].join("\n");
}

function constraintsOf(constraints: readonly Constraint[]): string {
  if (constraints.length === 0) return "";
  return `: ${constraints.map(describeConstraint).join("; ")}`;
}

function describeConstraint(constraint: Constraint): string {
  const allergen = constraint.allergen?.replaceAll("_", " ");
  const what = [allergen, constraint.term && `“${constraint.term}”`].filter(Boolean).join(" ");
  switch (constraint.kind) {
    case "allergy":
      return `allergic to ${what}`;
    case "intolerance":
      return `intolerant of ${what}`;
    case "diet":
      return `avoids ${what} (diet)`;
    case "dislike":
      return `dislikes ${what}`;
  }
}

async function household(host: AgentHost): Promise<Household | null> {
  const result = await host.callTool("get_household", {}, null);
  return result.ok ? (result.value as Household | null) : null;
}

/**
 * A registry tool as Pi offers it: its input schema from the registry, the call through the household
 * as the turn's speaker. Overrides are left out of the schema, and refused if sent anyway.
 */
function agentTool(name: ToolName, description: string, host: AgentHost): ToolRegistration {
  const inputSchema = z.toJSONSchema(tools[name].input, {
    io: "input",
    // An Item id is a shipped Item's key or a Household Item's: a string, as `list_items` gives it,
    // rather than every key of the catalogue.
    unrepresentable: "any",
    override: ({ zodSchema, jsonSchema }) => {
      if (zodSchema !== ItemId) return;
      for (const key of Object.keys(jsonSchema)) delete jsonSchema[key];
      Object.assign(jsonSchema, { type: "string", description: "An Item's id, as `list_items` gives it" });
    },
  });
  // A JSON round trip drops zod's non-enumerable `~standard`, which Pi would otherwise send the model.
  const { $schema: _, ...schema } = JSON.parse(JSON.stringify(inputSchema));
  return {
    name,
    description,
    parameters: Type.Unsafe(OVERRIDABLE.has(name) ? withoutOverrides(schema) : schema),
    async execute(args, api) {
      if (OVERRIDABLE.has(name) && typeof args === "object" && args !== null && "overrides" in args) {
        throw new Error("Only a person can override a Conflict, on the Week screen. Tell them who and which Allergen.");
      }
      const result = await host.callTool(name, args, await host.speakerIn(api.conversationId));
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      return { output: [{ type: "text", text: JSON.stringify(result.value) }] };
    },
  };
}

type JsonSchema = { properties?: Record<string, unknown>; anyOf?: JsonSchema[]; oneOf?: JsonSchema[] };

/** A tool's input schema without `overrides`, in each of its alternatives. */
function withoutOverrides(schema: JsonSchema): JsonSchema {
  const { overrides: _, ...properties } = schema.properties ?? {};
  return {
    ...schema,
    ...(schema.properties && { properties }),
    ...(schema.anyOf && { anyOf: schema.anyOf.map(withoutOverrides) }),
    ...(schema.oneOf && { oneOf: schema.oneOf.map(withoutOverrides) }),
  };
}

/**
 * The turn the conversation is answering: the newest Member's turn placed in it. Turns are answered
 * one at a time, each placed as its run starts, so a run's tools find their own turn.
 */
export async function turnBeingAnswered(conversation: Conversation): Promise<number | null> {
  let cursor: Cursor | undefined;
  do {
    // Newest first.
    const page = await conversation.entries({}, 50, cursor, BACKGROUND_CONTEXT);
    const turn = page.items.find((entry) => entry.kind === TURN_ENTRY);
    if (turn) return (turn.data as TurnData).turn;
    cursor = page.next;
  } while (cursor);
  return null;
}

/**
 * The newest `count` turns of the conversation as the chat shows them, oldest first, each Member's
 * turn with its speaker as `speakerOf` names them. Read from its whole history: what compaction
 * summarised for the model stays in the chat.
 */
export async function recentChat(
  conversation: Conversation,
  count: number,
  speakerOf: (turn: number) => string | null,
): Promise<ChatMessage[]> {
  let messages: ChatMessage[] = [];
  let cursor: Cursor | undefined;
  do {
    // Newest first.
    const page = await conversation.entries({}, 100, cursor, BACKGROUND_CONTEXT);
    messages = [...chatMessages([...page.items].reverse(), speakerOf), ...messages];
    cursor = page.next;
  } while (cursor && messages.length < count);
  return messages.slice(-count);
}

/** Entries as the chat shows them: what Members said and the agent's answers, in the entries' order. */
function chatMessages(entries: readonly EntryRecord[], speakerOf: (turn: number) => string | null): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const entry of entries) {
    if (entry.kind === TURN_ENTRY) {
      const { turn, text } = entry.data as TurnData;
      messages.push({ role: "member", speaker: speakerOf(turn), text });
      continue;
    }
    if (entry.kind !== "pi.assistant") continue;
    for (const message of entry.model ?? []) {
      if (message.role !== "assistant") continue;
      const text = textOf(message.content);
      if (text) messages.push({ role: "agent", text });
    }
  }
  return messages;
}

function textOf(content: string | readonly { type: string; text?: string }[]): string {
  if (typeof content === "string") return content;
  return content
    .flatMap((block) => (block.type === "text" && block.text ? [block.text] : []))
    .join("")
    .trim();
}
