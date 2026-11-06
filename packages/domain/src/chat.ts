import { z } from "zod";
import type { ConfirmationStatus, PendingConfirmation } from "./confirmations";
import { scaledLines } from "./ingredients";
import { type Recipe, RecipeId } from "./recipes";
import type { Staple } from "./staples";
import { type ToolName, thingsListed } from "./tools";
import { addDays, isPencilled, LocalDate, type Slot, SlotRef, type Week, weekdayOf } from "./weeks";

/** The longest message a Member can send the agent. */
export const MAX_CHAT_MESSAGE = 4000;

/** What a Member sends the agent. */
export const ChatInput = z.string().trim().min(1).max(MAX_CHAT_MESSAGE);

/** The screens the chat can be opened from. */
export const ChatScreen = z.enum(["week", "recipes", "grocery", "pantry", "household"]);
export type ChatScreen = z.infer<typeof ChatScreen>;

/**
 * Kitchen mode, as a Voice Session hears it: the Recipe cooked, the Slot it is cooked for (none when
 * cooked from the Recipe's page), and the step on screen, counted from 1 (none when it has no steps).
 */
export const KitchenWhere = z
  .object({
    screen: z.literal("kitchen"),
    recipe: RecipeId,
    slot: z.object(SlotRef).strict().optional(),
    step: z.number().int().min(1).optional(),
  })
  .strict();
export type KitchenWhere = z.infer<typeof KitchenWhere>;

/**
 * Where the chat was opened from, sent with each message so that "this week" and "Thursday" mean
 * what the person sees: the screen, and the Week it shows, if it shows one; or Kitchen mode, where
 * only a Voice Session is heard from.
 */
export const ChatWhere = z.union([z.object({ screen: ChatScreen, week: LocalDate.optional() }).strict(), KitchenWhere]);
export type ChatWhere = z.infer<typeof ChatWhere>;

/**
 * Sent to the one device a Voice Session talks through when the agent reads a step of Kitchen mode
 * aloud, so that its screen moves to it, counted from 1. No other device moves.
 */
export const ShowStep = z.object({ type: z.literal("mise:show-step"), step: z.number().int().min(1) });
export type ShowStep = z.infer<typeof ShowStep>;

/**
 * What a turn from Kitchen mode is shown of the Recipe cooked: as the household read it when the
 * turn was said, and the `servings` its Ingredients are scaled to, as Kitchen mode shows them.
 */
export type Cooking = {
  recipe: Pick<Recipe, "title" | "baseServings" | "readyMade" | "ingredients" | "steps">;
  servings: number;
  locale: string;
};

/** A Staple a spoken turn from the Pantry screen asks about, as `list_due_staples` gives it, in card order. */
export type CheckInStaple = Pick<Staple, "item" | "name" | "status">;

/**
 * One turn of the Household's shared conversation with the agent, as the chat shows it. A Member's
 * turn names who said it: the Member's name, the Caller's email when no Member signs in with it, or
 * null when no one signed in (calls from inside the deployment), and is `unanswered` when the run
 * answering it failed. A confirmation is a call the agent made that waits for a person's tap (ADR
 * 0024), shown where the agent made it.
 */
export type ChatMessage =
  | { role: "member"; speaker: string | null; text: string; unanswered?: true }
  | { role: "agent"; text: string }
  | { role: "confirmation"; id: number; summary: string; status: ConfirmationStatus };

/** The agent's answer, or why there is none (the model failed, or the message was refused). */
export type ChatReply =
  | { ok: true; value: Extract<ChatMessage, { role: "agent" }> }
  | { ok: false; error: { code: "invalid_input" | "unanswered"; message: string } };

const SCREEN_NAMES: Record<ChatScreen, string> = {
  week: "Week",
  recipes: "Recipes",
  grocery: "Grocery List",
  pantry: "Pantry",
  household: "Household",
};

/**
 * A turn as the model is shown it: who is speaking, whether they wrote or spoke (`spoken`, a turn
 * of a Voice Session, which only the household marks), on which day in the Household's timezone
 * (the conversation spans days, so "tomorrow" in an earlier turn meant another day), and from where,
 * then what they said. From Kitchen mode, that is the Recipe `cooking`, its Slot and the step on
 * screen, then its steps and its Ingredients scaled as the screen shows them, so that "next step" and
 * "how much garlic" are answered without a tool call, and amounts aren't left to the model's arithmetic. A spoken turn from a screen with no Week is given the dates of the coming
 * seven days, so that "Tuesday" said on a Friday means next Tuesday, not the one eaten already.
 * A spoken turn from the Pantry screen is given the Staples due, `checkIn`, in the order the Pantry's
 * cards ask about them, with their Items to record each answer by, so that it can lead the Check-in.
 * A turn from the Week screen is given the `week` it shows, as it is when the turn is presented: changes
 * made on a screen never reach the conversation, so the agent once kept this Week's Wednesday with next
 * Week shown, called a Kept dinner Mise's, and said a cleared breakfast was planned, all from earlier
 * turns (#142).
 * A turn `afterUnanswered`, sent after a turn whose run failed, is to be answered alone: the model
 * would otherwise answer every message still waiting at once.
 * Once the conversation has held a call for a tap (ADR 0024), every turn says which are `waiting` for
 * one now: a button may have been tapped, cancelled or expired on a screen since the call said it was
 * held, and the conversation is never told. Undefined says nothing, for a conversation that never held one.
 */
export function presentTurn(turn: {
  speaker: string | null;
  today: LocalDate;
  where: ChatWhere;
  cooking?: Cooking;
  checkIn?: readonly CheckInStaple[];
  spoken: boolean;
  afterUnanswered?: boolean;
  waiting?: readonly PendingConfirmation[];
  week?: Week;
  text: string;
}): string {
  const { where } = turn;
  const parts = [
    turn.speaker ?? "Someone not signed in",
    `${turn.spoken ? "speaking" : "writing"} on ${dayOf(turn.today)}`,
  ];
  const kitchen = where.screen === "kitchen" ? kitchenLines(where, turn.cooking) : undefined;
  if (where.screen === "kitchen") parts.push(...(kitchen?.parts ?? ["in Kitchen mode"]));
  else parts.push(`on the ${SCREEN_NAMES[where.screen]} screen`);
  if ("week" in where && where.week) parts.push(`showing the Week of ${dayOf(where.week)}`);
  else if (turn.spoken) {
    const coming = Array.from({ length: 7 }, (_, days) => dayOf(addDays(turn.today, days)));
    parts.push(`so day names mean the coming days: ${coming.join(", ")}`);
  }
  const checkIn = turn.spoken && where.screen === "pantry" && turn.checkIn?.length ? turn.checkIn : undefined;
  const header = [parts.join(", ")];
  if (turn.spoken) header.push(FOR_THE_EAR);
  if (checkIn) header.push(LEAD_THE_CHECK_IN);
  if (turn.afterUnanswered) header.push(ONLY_THIS_ONE);
  const waiting = turn.waiting ? [waitingLine(turn.waiting)] : [];
  const lines = kitchen?.lines ?? (checkIn ? [checkInLine(checkIn)] : turn.week ? [weekLine(turn.week)] : []);
  return [`[${header.join("; ")}]`, ...waiting, ...lines, turn.text].join("\n");
}

/** What a turn from Kitchen mode says of the Recipe `cooking`: in its header, and on lines of their own. */
function kitchenLines(where: KitchenWhere, cooking: Cooking | undefined) {
  if (!cooking) return undefined;
  const { recipe, servings, locale } = cooking;
  const parts = [
    "in Kitchen mode",
    `cooking ${recipe.title} ${where.slot ? `for the ${where.slot.meal} of ${dayOf(where.slot.date)}` : "as written"}`,
    `for ${servings} servings`,
  ];
  if (where.step && recipe.steps.length > 0) {
    parts.push(`showing step ${Math.min(where.step, recipe.steps.length)} of ${recipe.steps.length}`);
  }
  const lines = [];
  if (recipe.steps.length > 0) {
    lines.push(`[${recipe.title}'s steps: ${recipe.steps.map((step, index) => `${index + 1}. ${step}`).join(" ")}]`);
  }
  if (recipe.ingredients.length > 0) {
    const scaled = scaledLines(recipe, servings, locale).join("; ");
    lines.push(`[${recipe.title}'s Ingredients for ${servings} servings, as Kitchen mode shows them: ${scaled}]`);
  }
  return { parts, lines };
}

/** The Week on screen, as a turn from the Week screen gives it: day by day, as `weekForTheAgent` tells it. */
function weekLine(week: Week): string {
  const days = weekForTheAgent(week).days.map(
    ({ date, weekday, meals }) => `${weekday} ${date}: ${meals.map(mealLine).join(", ")}`,
  );
  return `[The Week on screen, as it is now (a breakfast or lunch not named has nothing planned): ${days.join("; ")}]`;
}

/** A meal in a turn's Week: what it is, its note, and for a dinner whether it is pencilled; and if it was cooked. */
function mealLine(meal: MealForTheAgent): string {
  const about = [];
  if (meal.pencilled !== undefined) about.push(meal.pencilled ? "pencilled" : "the Household's own");
  if (meal.cookedAt) about.push("cooked");
  const note = meal.note ? ` (note: “${meal.note}”)` : "";
  return `${meal.meal} ${whatItIs(meal)}${note}${about.length > 0 ? ` (${about.join(", ")})` : ""}`;
}

function whatItIs(meal: MealForTheAgent): string {
  switch (meal.kind) {
    case "recipe":
      return meal.recipe?.title ?? "a Recipe";
    case "leftovers":
      return meal.leftoversOf?.recipe ? `Leftovers of ${meal.leftoversOf.recipe.title}` : "Leftovers";
    case "eat_out":
      return "eating out";
    case "skip":
      return "skipped";
    case "unplanned":
      return "nothing planned";
  }
}

/** The held calls waiting for a tap, by their confirmation ids and what their buttons say. */
function waitingLine(waiting: readonly PendingConfirmation[]): string {
  if (waiting.length === 0) return "[Nothing is waiting for a tap]";
  return `[Waiting for a tap: ${waiting.map(({ id, summary }) => `${id} “${summary}”`).join("; ")}]`;
}

/** The Staples due, as a spoken turn from the Pantry screen lists them. */
function checkInLine(staples: readonly CheckInStaple[]): string {
  const named = staples.map(({ item, name, status }) => `${name} (Item ${item}, ${status} when last checked)`);
  return `[Staples due for the Check-in, in card order: ${named.join("; ")}]`;
}

/** What a spoken turn from the Pantry screen, with Staples due, says beside the message. */
const LEAD_THE_CHECK_IN =
  "lead the pantry Check-in: ask about the Staples due in card order, up to three at once, never again about one skipped, and record each answer as it comes";

/**
 * How to answer a spoken turn, said with the turn itself: the model follows a rule beside the
 * message more closely than one in the system prompt. A long list is offered by `offerLongList`, beside
 * the list itself: said here, the model asked whether to go on after every answer, list or not.
 */
const FOR_THE_EAR = "answer for the ear: one or two plain sentences";

/**
 * What a spoken turn's agent is told beside a tool's result listing more than three things: said
 * right after the list, where the model reads it last, it is followed where a rule in the system
 * prompt or the turn's header was not (#112).
 */
export function offerLongList(tool: ToolName, output: unknown): string | undefined {
  const count = thingsListed(tool, output);
  if (count <= 3) return undefined;
  return (
    `Read aloud, ${count} things are too many to take in. Say there are ${count}, name at most three, and ask ` +
    "whether to go on. When they ask to go on, name only the next three, and ask again while any are left."
  );
}

/** What a turn after an unanswered one says, so that the messages left waiting aren't answered with it. */
const ONLY_THIS_ONE = "Mise couldn't answer the messages before this one: answer only this message";

/** A meal of a Week as the agent reads it: a dinner says whether it is pencilled. */
export type MealForTheAgent = Omit<Slot, "date"> & { pencilled?: boolean };

/** A Week as the agent reads it; see `weekForTheAgent`. */
export type WeekForTheAgent = Omit<Week, "slots"> & {
  days: { date: LocalDate; weekday: string; meals: MealForTheAgent[] }[];
};

/**
 * A Week as the agent is given it, by a tool or in a turn: day by day, each day named by its weekday,
 * with every dinner and only the breakfasts and lunches that are planned or have a note, and each
 * dinner saying whether it is pencilled. Given all of a Week's meals, each by its ISO date alone, the agent miscounted the
 * dinners, put them on the wrong days and took a dinner without a `reason` for a pencilled one (#142).
 */
export function weekForTheAgent({ slots, ...week }: Week): WeekForTheAgent {
  const days: WeekForTheAgent["days"] = [];
  for (const { date, ...slot } of slots) {
    let day = days.at(-1);
    if (day?.date !== date) {
      day = { date, weekday: capitalised(weekdayOf(date)), meals: [] };
      days.push(day);
    }
    if (!told(slot)) continue;
    day.meals.push(slot.meal === "dinner" ? { ...slot, pencilled: isPencilled(slot) } : slot);
  }
  return { ...week, days };
}

/** Whether the agent is told of a meal: every dinner, and a breakfast or lunch that is planned or has a note. */
function told(slot: Pick<Slot, "meal" | "kind" | "note">): boolean {
  return slot.meal === "dinner" || slot.kind !== "unplanned" || slot.note !== null;
}

/** `date` with its weekday, as a turn names it. */
function dayOf(date: LocalDate): string {
  return `${capitalised(weekdayOf(date))} ${date}`;
}

/** `word` with its first letter in upper case, as a weekday is named in a sentence. */
export function capitalised(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}
