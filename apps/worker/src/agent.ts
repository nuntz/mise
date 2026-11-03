import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type Models, type StopReason, Type } from "@earendil-works/pi-ai";
import type {
  CompactionSettings,
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
  type ConfirmationStatus,
  type Constraint,
  capitalised,
  changeTopicOf,
  type Household,
  ItemId,
  localDate,
  offerLongList,
  type PendingConfirmation,
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

/** The most of the conversation a request shows the model: well under the 100,000 tokens above which Claude costs more. */
const CONTEXT_LIMIT = 80_000;
/** From how many tokens the conversation is summarised in the background, while the chat carries on. */
const COMPACT_FROM = 50_000;
/** How much of the newest conversation a summary leaves as it was said. */
const KEEP_RECENT = 20_000;

/**
 * Compaction for the agent's model. Pi measures its thresholds back from the model's context window,
 * so on Haiku's million tokens it would summarise only near a million, and every request above 100,000
 * costs more. Pi has no setting for the context to work in, so `reserveTokens` (the room kept for the
 * answer) holds back all of the window but `CONTEXT_LIMIT`; a summary may then be as long as an answer.
 */
export function agentCompaction({ models, model }: AgentModels): CompactionSettings {
  const window = models.getModel(model.provider, model.id)?.contextWindow ?? 0;
  if (window <= CONTEXT_LIMIT) return {};
  return {
    modelOverrides: {
      [`${model.provider}/${model.id}`]: {
        reserveTokens: window - CONTEXT_LIMIT,
        backgroundTokens: CONTEXT_LIMIT - COMPACT_FROM,
        keepRecentTokens: KEEP_RECENT,
      },
    },
  };
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

/** A tool call from the agent: its result, or the confirmation it waits for, held instead of run (ADR 0024). */
export type AgentCallResult = ToolResult<unknown> | { held: PendingConfirmation };

/** What the agent needs from the household. */
export type AgentHost = {
  /**
   * A tool call through the household's validated entry point (ADR 0002), made as `caller`; held for
   * a person's tap when it needs one.
   */
  callTool(name: ToolName, input: unknown, caller: Caller | null): Promise<AgentCallResult>;
  /** The Caller of the turn the conversation is answering: the one its tools run as. */
  speakerIn(conversation: ConversationId): Promise<Caller | null>;
  /**
   * Moves Kitchen mode's screen to `step`, on the device a Voice Session from Kitchen mode talks
   * through, while the conversation answers one of its spoken turns: the step shown, or null.
   */
  showStep(step: number, conversation: ConversationId): Promise<number | null>;
  /** Whether the conversation is answering a turn spoken in a Voice Session: its answer is read aloud. */
  answersSpoken(conversation: ConversationId): Promise<boolean>;
};

/**
 * The tools the agent is offered, each described for the model. Left out: `setup_household`, which
 * would recreate the Household (ADR 0024); tools that take an upload, which comes over HTTP;
 * accepting a Suggestion or a Draft, resolving an Ingredient or stating an Item's Allergens, which
 * only a person does (ADR 0023); rotating the calendar token, which stops every subscribed calendar
 * until it is added again; Kitchen Displays, whose token is shown once and never to a model (ADR
 * 0027); and a device's notifications, which only that device can turn on.
 * Deleting, clearing, Overrides and loosening a Hard Constraint are offered, and wait for a person's
 * tap (ADR 0024).
 */
const AGENT_TOOLS: Partial<Record<ToolName, string>> = {
  get_household:
    "The Household: its settings, Members (with ids and Constraints), default Effort Budgets and Store Sections.",
  get_caller: "Who is speaking: their email, and the Member they sign in as, if any.",
  cancel_confirmation:
    "Withdraws a button still waiting for the person's tap, when they no longer want it (“never mind”, or a " +
    "plain “no” to it), by the confirmation id the held call gave. Never tell them to ignore a button: withdraw it.",
  update_household_settings: "Changes the Household's settings given: name, timezone, dinner time, week start, units.",
  set_effort_budgets: "Sets the Household's default Effort Budget (cooking minutes) for the weekdays given.",
  add_member: "Adds a Member to the Household, with any Constraints.",
  update_member:
    "Changes a Member's name, sign-in email or Constraints (the list given replaces theirs). A new name or email, " +
    "or loosening a Hard Constraint, waits for the person's tap.",
  update_member_constraints:
    "Replaces a Member's Constraints with the list given. Removing a Hard Constraint, or making one a dislike, " +
    "waits for the person's tap; adding one doesn't.",
  remove_member: "Removes a Member. Removing one with a Hard Constraint waits for the person's tap.",
  search_recipes: "Recipes whose title matches `query`, or with `tag`, in title order. Drafts are left out.",
  get_recipe: "One Recipe in full: Ingredients, steps, servings, time, Course and tags.",
  create_recipe: "Creates a Recipe from a title, base servings and Ingredient lines as written.",
  update_recipe: "Changes the fields given of a Recipe, or of a Draft before a person accepts it.",
  delete_recipe: "Deletes a Recipe, once the person taps to confirm; pass `confirm: true`.",
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
  sync_drive_folder:
    "Starts reading new and changed Google Docs from the Household's Drive folder into Drafts, and answers at once, before any is read. The sync takes minutes; its Import Run appears in list_import_runs when it finishes.",
  list_drafts: "Draft Recipes waiting for a person to check and accept them.",
  list_import_runs: "Import runs, newest first, with what each did.",
  list_import_flags: "Recipes an import flagged for a merge or as a possible duplicate.",
  get_week:
    "The Week containing `date` (YYYY-MM-DD), or this Week without one: every breakfast, lunch and dinner, " +
    "with its Recipe, Diners, Guests, Conflicts and whether it is Locked. A dinner with a `reason` is Mise's " +
    "Suggestion, which a Re-roll may change, and the reason says why Mise chose it; a dinner without one is the " +
    "Household's own: chosen, changed or cooked by someone, and no Proposal changes it.",
  set_slot:
    "Sets what a Slot is, at breakfast, lunch or dinner: a Recipe (not a Draft, `recipeId` with kind `recipe`), " +
    "leftovers, eating out, unplanned or skipped. Moving a dinner to another day takes two calls: " +
    "set the new day to it, then the old day to unplanned. When the new day has a dinner already, first ask " +
    "whether to replace it or swap the two, and do what they say. Refused with " +
    "`constraint_conflict` if it would bring a Conflict, unless `overrides` gives the person's reason for each, " +
    "which waits for their tap.",
  set_diners:
    "Sets which Members eat a Slot, or every meal of a day when `meal` is left out; null goes back to everyone. " +
    "Refused with `constraint_conflict` if it would bring a Conflict; `overrides` as for set_slot.",
  set_guests:
    "Sets how many Guests eat a Slot, and their Constraints (kept when left out). Refused if it would bring a " +
    "Conflict; `overrides` as for set_slot. Removing a Hard Constraint of theirs waits for the person's tap.",
  link_leftovers:
    "Makes a Slot Leftovers of an earlier Slot that holds a Recipe, which is then cooked for both. Both become the " +
    "Household's own, so a Re-roll keeps them. `overrides` as for set_slot.",
  check_slot_constraints: "What Conflicts a change to a Slot would bring, without making it.",
  lock_slot: "Locks a Slot so proposing the Week again keeps it, or unlocks it.",
  clear_week:
    "Puts every Slot of the Week back as it starts, Locked ones too, but not cooked ones, once the person taps " +
    "to confirm; pass `confirm: true`.",
  propose_week:
    "Fills the Week's unplanned dinners and Mise's Suggestions, each with a reason, and leaves the Household's own " +
    "dinners as they are. `reroll: true` proposes again differently; `useUp` lists Item ids on hand, to favour " +
    "Recipes that use them.",

  set_week_effort_budgets: "Overrides the Effort Budget of the weekdays given for one Week; null goes back.",
  review_week: "Marks the Week as looked over since it was proposed, or not.",
  mark_cooked: "Marks a Slot cooked, today or earlier.",
  rate_recipe: "Rates a cooked Slot's Recipe for the Member speaking.",
  set_store_section_order: "Puts the Store Sections given first, in the order the Household walks its store.",
  get_calendar_token: "The calendar feed's token, for the feed's address; null until one is made on the screen.",
  build_grocery_list:
    "Builds or rebuilds the Week's Grocery List from its plan as it is now and the Staples low, out or always bought.",
  get_grocery_list:
    "The Week's Grocery List as it was last built; null until it is first built. `planChanged` or `staplesChanged` " +
    "means it is out of date: rebuild it before saying what it holds or lacks. A Staple to buy that a planned Recipe " +
    "also needs is bought on that Recipe's line, in the Recipe's amount, not on a line of its own; each line's " +
    "`recipes` names the Recipes it is for.",
  set_have_tick: "Ticks a Grocery List line as already had, or unticks it, as of `at` (now).",
  add_grocery_line: "Adds a line to the Week's Grocery List.",
  upsert_staple: "Makes an Item a Staple, or changes how it is kept and checked.",
  remove_staple: "Stops an Item being a Staple.",
  list_staples: "The Household's Staples, with how each stands (stocked, low, out).",
  list_due_staples: "The Staples a pantry check-in asks about today.",
  record_staple_status:
    "Records an Item as stocked, low or out (“we're out of cumin”), making it a Staple if it isn't one yet.",
};

/** Mise as a Pi extension: who the agent works for, and the tools it may call. */
export function miseExtension(host: AgentHost): Extension {
  return {
    name: "mise",
    sections: [
      { key: "preamble", tag: false, render: async () => preamble(await household(host)) },
      { key: "voice", tag: false, render: async () => SPOKEN_TURNS },
    ],
    tools: [
      ...Object.entries(AGENT_TOOLS).map(([name, description]) => agentTool(name as ToolName, description, host)),
      showStepTool(host),
    ],
  };
}

const ShowStepInput = z.object({ step: z.number().int().min(1) });

/**
 * Moves Kitchen mode's screen to the step the agent reads aloud. Not a registry tool: it changes no
 * Household data, only what one device shows, and only a Voice Session from Kitchen mode has a screen
 * to move.
 */
function showStepTool(host: AgentHost): ToolRegistration {
  return {
    name: "show_step",
    description:
      "In Kitchen mode, during a Voice Session: moves the screen to step `step`, counted from 1. Call it each time " +
      "you read a step aloud (“next step”, “back”, “repeat that”).",
    parameters: Type.Unsafe({
      type: "object",
      properties: { step: { type: "integer", minimum: 1, description: "The step's number, from 1" } },
      required: ["step"],
    }),
    replay: "safe",
    async execute(args, api) {
      const input = ShowStepInput.safeParse(args);
      const shown = input.success ? await host.showStep(input.data.step, api.conversationId) : null;
      if (shown === null) throw new Error("Only a turn spoken in Kitchen mode has a screen to show a step on");
      return { output: [{ type: "text", text: `Step ${shown} is on the screen.` }] };
    },
  };
}

/** How to answer a turn spoken in a Voice Session: the answer is read aloud, to whoever is in the kitchen. */
const SPOKEN_TURNS = [
  "Spoken turns: a message marked “speaking” was said aloud in a Voice Session, and your answer is read aloud.",
  "- Answer in one or two plain sentences, with no Markdown, lists or symbols. Say dates as weekdays " +
    "(“this Friday”, “next Tuesday”), never as numbers.",
  "- Never name more than three things in one answer. With more, say how many there are, name up to three, " +
    "and end by telling them to say “more” for the next ones (“Twelve recipes use chicken, among them Butter " +
    "chicken and Chicken pho. Say more for others.”). Never end it with a question such as “Want the rest?”: " +
    "the voice answers a “no” to it itself, and you never hear it. Name the next ones only once asked for " +
    "them, such as with “more” or “what about the others?”: the offer names none of them (not “Say more for the last three, Risotto, Pho and Pie”, nor “Shall " +
    "I name the next three, starting with Risotto?”). Asked for the same list again, answer afresh the same way: " +
    "how many, up to three of them, then “say more”. This rule holds even when your earlier answers in the " +
    "conversation ended otherwise, such as with “Want the next three?”: answer by this rule, not by them.",
  "- From a screen with no Week, a day name means the date the message gives for it, among the coming days: " +
    "on a Friday, “Tuesday” is next Tuesday. Only “last Tuesday”, or asking what was eaten, means one past.",
  "- Before changing a day that has already passed, ask first (“Tuesday has passed. Change it anyway?”), " +
    "and change it only once they say yes.",
  "- When a change waits for a tap, name the button by what it says (“tap Delete Lemon chicken on the " +
    "screen”), never “the button above”: the person may be across the kitchen.",
  "- In Kitchen mode, the message gives the Recipe's steps and its Ingredients as the screen shows them. For " +
    "“next step”, “back” or “repeat that”, read that step aloud as written and call show_step with its number. " +
    "For an amount, say the one given, already scaled: never work one out.",
  "- A spoken turn may come from anyone in the room: “I” and “me” mean the speaker shown, unless they say a " +
    "Member's name.",
  "- On the Pantry screen, the message lists the Staples due for the Check-in, in the order the screen's cards " +
    "ask about them. Lead the Check-in through them in that order by name alone (“Cumin?”). Record each answer " +
    "with record_staple_status as it comes: “out” is out, “low” is low, “fine”, “got it” or “plenty” is stocked. " +
    "On “skip”, record nothing and go on to the next: a Staple skipped stays listed as due, but isn't asked " +
    "about again in this Check-in. With more than three due, ask about three at once " +
    "(“Cumin, paprika, oregano: any low?”) and take the ones not named as stocked. Take answers out of order too " +
    "(“we're out of rice and cumin”). When a recorded Staple says suggestAlwaysBuy, ask whether to always buy it, " +
    "and set alwaysBuy with upsert_staple only if they say yes. When none is left, say in one sentence that the Check-in is done and what is out or low, leaving skipped ones unmentioned, and ask nothing more " +
    "(“That's the Check-in done: cumin's out and paprika's low.”).",
].join("\n");

function preamble(household: Household | null): string {
  if (!household) return "You are Mise, a family meal planner. This Household is not set up yet.";
  const today = localDate(new Date(), household.timezone);
  return [
    `You are Mise, the meal planner of ${household.name}. You talk with its Members in a short, friendly way.`,
    "The chat shows plain text: write no Markdown. Don't say what you are about to do or which tools you call, " +
      "and never mention ids; just answer once you have done it.",
    `Today is ${capitalised(weekdayOf(today))} ${today} in the Household's timezone (${household.timezone}). ` +
      `Weeks start on ${capitalised(household.weekStartsOn)}; dinner is at ${household.dinnerTime}.`,
    "Members:",
    ...(household.members.length > 0
      ? household.members.map((member) => `- ${member.name} (Member ${member.id})${constraintsOf(member.constraints)}`)
      : ["- none yet"]),
    "",
    "Each message starts, in brackets, with who is speaking, the day they wrote it, and the screen (and Week) " +
      "they are looking at. " +
      "“I”, “me” and “us” mean that speaker; “this week” and day names mean the Week they see. " +
      "“Today”, “tonight” and “tomorrow” count from the day the message was written, whatever Week they see.",
    "Change things only through the tools. Answer from what they return: never guess what is planned, read it. " +
      "Don't say why something happened, or what a Week or list holds, unless a tool you just called says so; " +
      "if the tools don't tell you, say you don't know. " +
      "Earlier turns may be out of date: people change things on the screens too. Check with a tool before " +
      "relying on what was said or done earlier, and when a tool disagrees with the conversation, the tool is right.",
    "To explain a Proposal, use only each Slot's `reason` from `get_week`; don't invent others.",
    "When a change is refused for a Conflict, say who and which Allergen. Override it only with the reason the " +
      "person gave for planning it anyway.",
    "Deleting a Recipe, clearing a Week, overriding a Conflict, changing a Member's name or sign-in email, and " +
      "removing a Hard Constraint (a Member's or the Guests'), making one a dislike or removing a Member who has " +
      "one wait for the person: the tool changes nothing, and the chat shows them a button saying what will happen. " +
      "Only their tap does it, whatever they type: tell them to tap it, and never say it is done. If they no longer " +
      "want it, withdraw it with cancel_confirmation. You cannot accept Drafts and Suggestions: say the person can " +
      "do it on the screen.",
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
  return "ok" in result && result.ok ? (result.value as Household | null) : null;
}

/**
 * A registry tool as Pi offers it: its input schema from the registry, the call through the household
 * as the turn's speaker. A call held for a person's tap tells the model so, and names its confirmation
 * in the result's details, where the chat finds it.
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
    parameters: Type.Unsafe(asOneObject(schema)),
    // A tool that only reads runs again if the household was evicted during it; one that changes
    // something is answered as interrupted instead, and never runs twice.
    replay: changeTopicOf(name) ? "unsafe" : "safe",
    async execute(args, api) {
      const result = await host.callTool(name, args, await host.speakerIn(api.conversationId));
      if ("held" in result) {
        const { id, summary } = result.held;
        const text =
          `Nothing is changed yet (confirmation ${id}). The chat now shows the person a button, just above your ` +
          `answer, saying what will happen (“${summary}”); only their tap does it. Tell them in a few words to tap ` +
          "it if they want it, without repeating what it says, and don't say it is done.";
        const details: ConfirmationDetails = { confirmation: id };
        return { output: [{ type: "text", text }], details };
      }
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      const output = [{ type: "text" as const, text: JSON.stringify(result.value) }];
      const note = offerLongList(name, result.value);
      if (note && (await host.answersSpoken(api.conversationId))) output.push({ type: "text", text: note });
      return { output };
    },
  };
}

type JsonSchema = {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
};

/**
 * A tool's input as one object. Anthropic takes a tool's input that way, and pi-ai sends only the
 * root's `properties` and `required`, so alternatives at the root (`set_slot`'s, one for a Recipe and
 * one for every other kind) would reach the model as a tool without parameters. Their properties are
 * merged, a property the alternatives describe differently taking any of its descriptions, and only
 * what every alternative requires is required; the household still validates the call as it is.
 */
function asOneObject(schema: JsonSchema): JsonSchema {
  const alternatives = schema.oneOf ?? schema.anyOf;
  if (!alternatives) return schema;
  const properties: Record<string, unknown[]> = {};
  for (const alternative of alternatives) {
    for (const [key, property] of Object.entries(alternative.properties ?? {})) {
      const seen = properties[key] ?? [];
      if (!seen.some((other) => JSON.stringify(other) === JSON.stringify(property))) seen.push(property);
      properties[key] = seen;
    }
  }
  const required = alternatives
    .map((alternative) => alternative.required ?? [])
    .reduce((all, some) => all.filter((key) => some.includes(key)));
  return {
    type: "object",
    properties: Object.fromEntries(
      Object.entries(properties).map(([key, [only, ...more]]) => [
        key,
        more.length > 0 ? { anyOf: [only, ...more] } : only,
      ]),
    ),
    required,
  };
}

/** What a held call's tool result keeps for the chat: the confirmation it waits for. */
type ConfirmationDetails = { confirmation: number };

/**
 * The turn the conversation is answering: the newest Member's turn placed in it. Turns are answered
 * one at a time, each placed as its run starts, so a run's tools find their own turn.
 */
export async function turnBeingAnswered(conversation: Conversation): Promise<number | null> {
  for await (const entry of newestFirst(conversation)) {
    if (entry.kind === TURN_ENTRY) return (entry.data as TurnData).turn;
  }
  return null;
}

/**
 * Whether the newest Member's turn placed in the conversation went unanswered: its run failed. A turn
 * still being answered hasn't.
 */
export async function lastTurnUnanswered(conversation: Conversation): Promise<boolean> {
  // A run's last answer comes before its turn.
  for await (const entry of newestFirst(conversation)) {
    if (entry.kind === TURN_ENTRY) return false;
    if (entry.kind !== "pi.assistant") continue;
    const answer = [...(entry.model ?? [])].reverse().find((message) => message.role === "assistant");
    if (answer?.role === "assistant") return FAILED.has(answer.stopReason);
  }
  return false;
}

/**
 * The confirmations held since `turn` was said, oldest first: the calls the run answering it made
 * that wait for a tap, and any a later run has made since.
 */
export async function confirmationsSince(conversation: Conversation, turn: number): Promise<number[]> {
  const ids: number[] = [];
  for await (const entry of newestFirst(conversation)) {
    if (entry.kind === TURN_ENTRY && (entry.data as TurnData).turn === turn) break;
    if (entry.kind !== "pi.assistant" && entry.kind !== "pi.tool-result") continue;
    for (const message of [...(entry.model ?? [])].reverse()) {
      const id = message.role === "toolResult" ? confirmationIn(message.details) : null;
      if (id !== null) ids.push(id);
    }
  }
  return ids.reverse();
}

/** The conversation's entries, newest first, read a page at a time as they are asked for. */
async function* newestFirst(conversation: Conversation): AsyncGenerator<EntryRecord> {
  let cursor: Cursor | undefined;
  do {
    const page = await conversation.entries({}, 50, cursor, BACKGROUND_CONTEXT);
    yield* page.items;
    cursor = page.next;
  } while (cursor);
}

/** What the chat shows a transcript entry with: who said each turn, and what became of each confirmation. */
export type ChatLookups = {
  speakerOf(turn: number): string | null;
  confirmation(id: number): { summary: string; status: ConfirmationStatus } | null;
};

/**
 * The newest `count` turns of the conversation as the chat shows them, oldest first, each Member's
 * turn with its speaker and each confirmation as `lookups` give them. Read from its whole history:
 * what compaction summarised for the model stays in the chat.
 */
export async function recentChat(
  conversation: Conversation,
  count: number,
  lookups: ChatLookups,
): Promise<ChatMessage[]> {
  let entries: EntryRecord[] = [];
  let messages: ChatMessage[] = [];
  let cursor: Cursor | undefined;
  do {
    // Newest first. Read again as a whole: a turn and the run answering it may be on two pages.
    const page = await conversation.entries({}, 100, cursor, BACKGROUND_CONTEXT);
    entries = [...[...page.items].reverse(), ...entries];
    messages = chatMessages(entries, lookups);
    cursor = page.next;
  } while (cursor && messages.length < count);
  return messages.slice(-count);
}

/**
 * Entries as the chat shows them, in their order: what Members said, the agent's answers, and the
 * confirmations its held calls wait for, where it made them. A turn whose run failed is marked
 * unanswered, whatever its run did before failing.
 */
function chatMessages(entries: readonly EntryRecord[], lookups: ChatLookups): ChatMessage[] {
  const messages: ChatMessage[] = [];
  let latestTurn: Extract<ChatMessage, { role: "member" }> | undefined;
  for (const entry of entries) {
    if (entry.kind === TURN_ENTRY) {
      const { turn, text } = entry.data as TurnData;
      latestTurn = { role: "member", speaker: lookups.speakerOf(turn), text };
      messages.push(latestTurn);
      continue;
    }
    if (entry.kind !== "pi.assistant" && entry.kind !== "pi.tool-result") continue;
    for (const message of entry.model ?? []) {
      if (message.role === "toolResult") {
        const id = confirmationIn(message.details);
        const shown = id === null ? null : lookups.confirmation(id);
        if (id !== null && shown) messages.push({ role: "confirmation", id, ...shown });
      }
      if (message.role !== "assistant") continue;
      if (latestTurn && FAILED.has(message.stopReason)) latestTurn.unanswered = true;
      const text = textOf(message.content);
      if (text) messages.push({ role: "agent", text });
    }
  }
  return messages;
}

/** How a run that answered nothing ends: its model failed, or the run was stopped. */
const FAILED: ReadonlySet<StopReason> = new Set(["error", "aborted"]);

/** The confirmation a tool result's details name, if they name one. */
function confirmationIn(details: unknown): number | null {
  const id = (details as Partial<ConfirmationDetails> | undefined)?.confirmation;
  return typeof id === "number" ? id : null;
}

function textOf(content: string | readonly { type: string; text?: string }[]): string {
  if (typeof content === "string") return content;
  return content
    .flatMap((block) => (block.type === "text" && block.text ? [block.text] : []))
    .join("")
    .trim();
}
