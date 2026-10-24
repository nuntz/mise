import { type Api, createModels, type Model, type Models, Type } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import {
  ALLERGENS,
  type Item,
  type Llm,
  LlmError,
  STORE_SECTIONS,
  SuggestedItem,
  type SuggestionAnswer,
  type SuggestionRequest,
  UNIT_FAMILIES,
} from "@mise/domain";
import { z } from "zod";

/** The model that makes Suggestions (SPEC §2): Allergens are worth the stronger model. */
export const SUGGESTION_MODEL = "claude-sonnet-5-5";

/** pi-ai's models with only Anthropic registered, calling with `apiKey`. */
export function anthropicModels(apiKey: string | undefined): Models {
  const models = createModels({
    authContext: {
      env: async (name) => (name === "ANTHROPIC_API_KEY" ? apiKey : undefined),
      fileExists: async () => false,
    },
  });
  models.setProvider(anthropicProvider());
  return models;
}

/** What opening the LLM needs from the Worker's environment; `bun run eval` passes its own. */
type LlmEnv = { ANTHROPIC_API_KEY?: string };

let replacement: ((env: LlmEnv) => Llm) | undefined;

/**
 * Makes households use another `Llm` from their next call, or Claude again with `undefined`. Tests
 * put them on a `FakeLlm`, so no test calls a real model.
 */
export function useLlm(open: ((env: LlmEnv) => Llm) | undefined): void {
  replacement = open;
}

/** The LLM a household asks: Claude, with the deployment's Anthropic key (a Worker secret). */
export function openLlm(env: LlmEnv): Llm {
  if (replacement) return replacement(env);
  const models = anthropicModels(env.ANTHROPIC_API_KEY);
  const model = models.getModel("anthropic", SUGGESTION_MODEL);
  if (!model) throw new Error(`pi-ai has no model ${SUGGESTION_MODEL}`);
  return claudeLlm(models, model);
}

const SUGGEST_TOOL = "suggest_items";

/** One answer as the model gives it; flatter than `SuggestedItem`, which models fill more reliably. */
const ModelAnswer = z.object({
  name: z.string().describe("The name exactly as it was asked about"),
  item: z.string().optional().describe("The id of the existing Item this name is another name for"),
  newItem: z
    .object({
      name: z.string().describe("The Item's plain singular name, as a shopper would say it"),
      section: z.enum(STORE_SECTIONS),
      unitFamily: z.enum(UNIT_FAMILIES).describe("What it is usually measured in"),
      allergens: z.array(z.enum(ALLERGENS)).describe("Every allergen it can contain; empty only if it has none"),
    })
    .optional()
    .describe("A new Item, when no existing Item fits"),
});

const ModelAnswers = z.object({ suggestions: z.array(z.unknown()) });

const SYSTEM_PROMPT = [
  "You help a family meal planner match recipe ingredient names to grocery Items.",
  "Each name was left unmatched by the planner's parser. For each one, either give the id of an existing Item",
  "the name is just another name for (a synonym, a translation, a brand, a more specific wording that buys the",
  "same thing), or describe a new Item.",
  "Pick an existing Item only when buying that Item is buying this ingredient. When unsure, describe a new Item.",
  "For a new Item, list every allergen it commonly contains, including hidden ones (fish sauce has fish,",
  "Worcestershire sauce has fish, most soy sauce has wheat, pesto often has tree nuts and milk). A family with",
  "allergies relies on this, so when an allergen is common in the usual product, include it.",
  'Skip a name that is not a food ("to taste", "for serving").',
  `Answer only by calling ${SUGGEST_TOOL}.`,
].join("\n");

/** An `Llm` that asks a Claude model through pi-ai, for one tool call with the answers. */
export function claudeLlm(models: Models, model: Model<Api>): Llm {
  const { $schema: _, ...parameters } = z.toJSONSchema(z.object({ suggestions: z.array(ModelAnswer) }));
  return {
    async makeSuggestions(request) {
      const message = await models.complete(
        model,
        {
          systemPrompt: SYSTEM_PROMPT,
          messages: [{ role: "user", content: prompt(request), timestamp: Date.now() }],
          tools: [
            {
              name: SUGGEST_TOOL,
              description: "Gives the answer for each name that is a food.",
              parameters: Type.Unsafe(parameters),
            },
          ],
        },
        // Not forced with `toolChoice`: Sonnet always thinks, and Anthropic refuses a forced tool
        // call while a model thinks. The prompt asks for the tool, and an answer without it fails.
        { maxTokens: 32_000 },
      );
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        throw new LlmError(message.errorMessage ?? message.stopReason);
      }
      const call = message.content.find((block) => block.type === "toolCall" && block.name === SUGGEST_TOOL);
      const answers = ModelAnswers.safeParse(call?.type === "toolCall" ? call.arguments : undefined);
      if (!answers.success) throw new LlmError(`no ${SUGGEST_TOOL} call`);
      // An answer that can't be read is left out, as one the model did not give.
      return answers.data.suggestions.flatMap((raw) => {
        const answer = ModelAnswer.safeParse(raw);
        if (!answer.success) return [];
        const { name, item, newItem } = answer.data;
        const suggested = SuggestedItem.safeParse(item ? { kind: "existing", item } : { kind: "new", ...newItem });
        return suggested.success ? [{ name, suggested: suggested.data } satisfies SuggestionAnswer] : [];
      });
    },
  };
}

function prompt({ names, catalogue }: SuggestionRequest): string {
  return [
    "Existing Items, one per line: id | name | other names | allergens",
    ...catalogue.map(catalogueLine),
    "",
    "Names to match:",
    ...names.map((name) => `- ${name}`),
  ].join("\n");
}

function catalogueLine(item: Item): string {
  return [item.id, item.name, item.aliases.join(", "), item.allergens.join(", ") || "none"].join(" | ");
}
