import { env } from "cloudflare:workers";
import {
  createModels,
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { JsonObject } from "@earendil-works/pi-durable";
import type { Slot, ToolResult, Week } from "@mise/domain";
import { useAgentModels } from "../src/agent";

/** The agent on a scripted model, and the Households it is tried on, for the Worker tests. */

export type HouseholdStub = ReturnType<typeof env.Household.getByName>;

/**
 * A Household of Robin (robin@example.com, allergic to peanut), Alex (alex@example.com) and Sam,
 * Members 1, 2 and 3. Recipe 1 is Satay (peanut); Recipes 2 to 9 are rice bowls, safe for everyone.
 */
export async function familyHousehold() {
  const household = env.Household.getByName(crypto.randomUUID());
  await household.callTool("setup_household", {
    name: "The Example Family",
    members: [
      { name: "Robin", email: "robin@example.com", constraints: [{ kind: "allergy", allergen: "peanut" }] },
      { name: "Alex", email: "alex@example.com" },
      { name: "Sam" },
    ],
  });
  await household.callTool("create_recipe", {
    title: "Satay",
    baseServings: 4,
    ingredients: ["2 tbsp peanut butter"],
    effortMinutes: 30,
  });
  for (let index = 2; index <= 9; index++) {
    await household.callTool("create_recipe", {
      title: `Rice bowl ${index}`,
      baseServings: 4,
      ingredients: ["400 g rice"],
      effortMinutes: 30,
    });
  }
  return household;
}

type Message = TranscriptContext["messages"][number];

/** The text of a message's content. */
export function textOf(message: Message | undefined): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  return (content ?? []).map((block) => ("text" in block ? block.text : "")).join("");
}

/** The text of the newest message, of whatever role. */
export function lastText(context: TranscriptContext): string {
  return textOf(context.messages.at(-1));
}

/**
 * A scripted model that answers each message by making `calls` one after the other, then saying what
 * the last tool returned, or "Refused: <the error>" if it failed.
 */
export function caller(calls: [string, JsonObject][]): FauxResponseFactory {
  return (context) => {
    const fromLast = [...context.messages].reverse().findIndex((message) => message.role === "user");
    const made = context.messages.slice(-fromLast - 1).filter((message) => message.role === "toolResult");
    const failed = made.find((message) => (message as { isError?: boolean }).isError);
    if (failed) return fauxAssistantMessage(`Refused: ${textOf(failed)}`);
    const next = calls[made.length];
    if (!next) return fauxAssistantMessage(`Done: ${lastText(context)}`);
    return fauxAssistantMessage(fauxToolCall(...next), { stopReason: "toolUse" });
  };
}

/**
 * Puts the agent of households started from now on a faux model that answers every request with
 * `respond`. A household's models are fixed when it starts, so script the model before using it.
 * Put it back with `useAgentModels(undefined)` after each test. `provider` and `id` name the model it
 * stands in for, so settings for that model apply.
 */
export function scriptModel(
  respond: FauxResponseFactory,
  { contextWindow, provider, id = "scripted" }: { contextWindow?: number; provider?: string; id?: string } = {},
) {
  const faux = fauxProvider({ provider, models: [{ id, contextWindow }] });
  const models = createModels();
  models.setProvider(faux.provider);
  // Each request takes the next scripted response; one factory per request it might make.
  faux.setResponses(Array.from({ length: 200 }, () => respond));
  useAgentModels(() => ({ models, model: faux.getModel() }));
  return faux;
}

export async function weekOf(household: HouseholdStub, date: string): Promise<Week> {
  const result = (await household.callTool("get_week", { date })) as ToolResult<unknown>;
  if (!result.ok) throw new Error(result.error.message);
  return result.value as Week;
}

export async function dinnerOn(household: HouseholdStub, date: string): Promise<Slot | undefined> {
  return (await weekOf(household, date)).slots.find((slot) => slot.date === date && slot.meal === "dinner");
}
