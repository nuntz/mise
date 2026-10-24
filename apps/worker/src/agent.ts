import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type Models, Type } from "@earendil-works/pi-ai";
import type { Conversation, Cursor, EntryRecord, Extension, ToolRegistration } from "@earendil-works/pi-durable";
import {
  type ChatMessage,
  type Household,
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

/** How the agent reaches a tool: the household's validated entry point (ADR 0002). */
export type CallTool = (name: ToolName, input: unknown) => Promise<ToolResult<unknown>>;

/** The tools the agent is offered, each described for the model. */
const AGENT_TOOLS: Partial<Record<ToolName, string>> = {
  get_week:
    "The Week containing `date` (YYYY-MM-DD), or this Week without one: every breakfast, lunch and dinner, " +
    "with its Recipe, Diners, Guests and Conflicts.",
};

/** Mise as a Pi extension: who the agent works for, and the tools it may call. */
export function miseExtension(callTool: CallTool): Extension {
  return {
    name: "mise",
    sections: [{ key: "preamble", tag: false, render: async () => preamble(await household(callTool)) }],
    tools: Object.entries(AGENT_TOOLS).map(([name, description]) => agentTool(name as ToolName, description, callTool)),
  };
}

function preamble(household: Household | null): string {
  if (!household) return "You are Mise, a family meal planner. This Household is not set up yet.";
  const today = localDate(new Date(), household.timezone);
  return [
    `You are Mise, the meal planner of ${household.name}. You talk with its Members in a short, friendly way.`,
    `Today is ${weekdayOf(today)} ${today} in the Household's timezone (${household.timezone}).`,
    "Answer from what the tools return. Never guess what is planned: read it.",
  ].join("\n");
}

async function household(callTool: CallTool): Promise<Household | null> {
  const result = await callTool("get_household", {});
  return result.ok ? (result.value as Household | null) : null;
}

/** A registry tool as Pi offers it: its input schema from the registry, the call through `callTool`. */
function agentTool(name: ToolName, description: string, callTool: CallTool): ToolRegistration {
  // A JSON round trip drops zod's non-enumerable `~standard`, which Pi would otherwise send the model.
  const { $schema: _, ...schema } = JSON.parse(JSON.stringify(z.toJSONSchema(tools[name].input, { io: "input" })));
  return {
    name,
    description,
    parameters: Type.Unsafe(schema),
    async execute(args) {
      const result = await callTool(name, args);
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      return { output: [{ type: "text", text: JSON.stringify(result.value) }] };
    },
  };
}

/**
 * The newest `count` turns of the conversation as the chat shows them, oldest first. Read from its
 * whole history: what compaction summarised for the model stays in the chat.
 */
export async function recentChat(conversation: Conversation, count: number): Promise<ChatMessage[]> {
  let messages: ChatMessage[] = [];
  let cursor: Cursor | undefined;
  do {
    // Newest first.
    const page = await conversation.entries({}, 100, cursor, BACKGROUND_CONTEXT);
    messages = [...chatMessages([...page.items].reverse()), ...messages];
    cursor = page.next;
  } while (cursor && messages.length < count);
  return messages.slice(-count);
}

/** Entries as the chat shows them: what Members said and the agent's answers, in the entries' order. */
function chatMessages(entries: readonly EntryRecord[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const entry of entries) {
    for (const message of entry.kind === "pi.user" || entry.kind === "pi.assistant" ? (entry.model ?? []) : []) {
      if (message.role !== "user" && message.role !== "assistant") continue;
      const text = textOf(message.content);
      if (text) messages.push({ role: message.role === "user" ? "member" : "agent", text });
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
