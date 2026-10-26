import { z } from "zod";
import type { ConfirmationStatus } from "./confirmations";
import { LocalDate, weekdayOf } from "./weeks";

/** The longest message a Member can send the agent. */
export const MAX_CHAT_MESSAGE = 4000;

/** What a Member sends the agent. */
export const ChatInput = z.string().trim().min(1).max(MAX_CHAT_MESSAGE);

/** The screens the chat can be opened from. */
export const ChatScreen = z.enum(["week", "recipes", "grocery", "pantry", "household"]);
export type ChatScreen = z.infer<typeof ChatScreen>;

/**
 * Where the chat was opened from, sent with each message so that "this week" and "Thursday" mean
 * what the person sees: the screen, and the Week it shows, if it shows one.
 */
export const ChatWhere = z.object({ screen: ChatScreen, week: LocalDate.optional() }).strict();
export type ChatWhere = z.infer<typeof ChatWhere>;

/**
 * One turn of the Household's shared conversation with the agent, as the chat shows it. A Member's
 * turn names who said it: the Member's name, the Caller's email when no Member signs in with it, or
 * null when no one signed in (calls from inside the deployment). A confirmation is a call the agent
 * made that waits for a person's tap (ADR 0024), shown where the agent made it.
 */
export type ChatMessage =
  | { role: "member"; speaker: string | null; text: string }
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
 * A turn as the model is shown it: who is speaking, on which day in the Household's timezone (the
 * conversation spans days, so "tomorrow" in an earlier turn meant another day), and from where, then
 * what they said.
 */
export function presentTurn(turn: {
  speaker: string | null;
  today: LocalDate;
  where: ChatWhere;
  text: string;
}): string {
  const parts = [
    turn.speaker ?? "Someone not signed in",
    `writing on ${capitalised(weekdayOf(turn.today))} ${turn.today}`,
    `on the ${SCREEN_NAMES[turn.where.screen]} screen`,
  ];
  if (turn.where.week) parts.push(`showing the Week of ${capitalised(weekdayOf(turn.where.week))} ${turn.where.week}`);
  return `[${parts.join(", ")}]\n${turn.text}`;
}

/** `word` with its first letter in upper case, as a weekday is named in a sentence. */
export function capitalised(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}
