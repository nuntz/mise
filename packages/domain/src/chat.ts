import { z } from "zod";

/** The longest message a Member can send the agent. */
export const MAX_CHAT_MESSAGE = 4000;

/** What a Member sends the agent. */
export const ChatInput = z.string().trim().min(1).max(MAX_CHAT_MESSAGE);

/** One turn of the Household's shared conversation with the agent, as the chat shows it. */
export type ChatMessage = { role: "member" | "agent"; text: string };

/** The agent's answer, or why there is none (the model failed, or the message was refused). */
export type ChatReply =
  | { ok: true; value: ChatMessage }
  | { ok: false; error: { code: "invalid_input" | "unanswered"; message: string } };
