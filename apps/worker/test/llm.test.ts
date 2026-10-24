import {
  createModels,
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  FakeLlm,
  type Llm,
  LlmError,
  type ModelReading,
  type RecipeReading,
  SHIPPED_ITEMS,
  type SuggestedItem,
} from "@mise/domain";
import { describe, expect, test, vi } from "vitest";
import type { z } from "zod";
import { claudeLlm, openLlm, useLlm } from "../src/llm";

type Answers = Record<string, SuggestedItem>;

/** What the real adapter and the fake both promise; the real one runs on pi-ai's faux provider. */
type Adapter = { llm: Llm; fail: () => void };

const tahiniPaste: SuggestedItem = { kind: "existing", item: "tahini" };
const gochujang: SuggestedItem = {
  kind: "new",
  name: "gochujang",
  section: "international",
  unitFamily: "volume",
  allergens: ["wheat", "soy"],
};

/** A scripted model that answers, in the tool's shape, for each listed name it has an answer for. */
function scriptedClaude(answers: Answers): Adapter {
  let failing = false;
  const respond: FauxResponseFactory = (context) => {
    if (failing) return fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded" });
    const prompt = context.messages.map((message) => (typeof message.content === "string" ? message.content : ""));
    const asked = prompt.join("\n").split("Names to match:\n")[1]?.split("\n") ?? [];
    const suggestions = asked.flatMap((line): object[] => {
      const name = line.replace(/^- /, "");
      const answer = answers[name];
      if (!answer) return [];
      if (answer.kind === "existing") return [{ name, item: answer.item }];
      const { kind: _, ...newItem } = answer;
      return [{ name, newItem }];
    });
    // Through JSON, as tool arguments arrive from the API.
    const args = JSON.parse(JSON.stringify({ suggestions }));
    return fauxAssistantMessage(fauxToolCall("suggest_items", args), { stopReason: "toolUse" });
  };
  const faux = fauxProvider();
  faux.setResponses(Array.from({ length: 10 }, () => respond));
  const models = createModels();
  models.setProvider(faux.provider);
  return {
    llm: claudeLlm(models, faux.getModel()),
    fail: () => {
      failing = true;
    },
  };
}

function fake(answers: Answers): Adapter {
  const llm = new FakeLlm(answers);
  return {
    llm,
    fail: () => {
      llm.failing = true;
    },
  };
}

describe.each([
  ["Claude through pi-ai", scriptedClaude],
  ["the fake", fake],
])("the LLM adapter: %s", (_, open) => {
  const request = { names: ["tahini paste", "gochujang", "for serving"], catalogue: SHIPPED_ITEMS.items };

  test("answers for each name it has a Suggestion for, and leaves out the rest", async () => {
    const { llm } = open({ "tahini paste": tahiniPaste, gochujang });

    expect(await llm.makeSuggestions(request)).toEqual([
      { name: "tahini paste", suggested: tahiniPaste },
      { name: "gochujang", suggested: gochujang },
    ]);
  });

  test("throws LlmError when the model fails", async () => {
    const adapter = open({ gochujang });
    adapter.fail();

    await expect(adapter.llm.makeSuggestions(request)).rejects.toThrow(LlmError);
  });
});

/** A reading as a model may give it. */
type ModelAnswer = z.input<typeof ModelReading>;

/** What both adapters promise when reading a recipe; the real one answers `reading` in the tool's shape. */
type Reader = { llm: Llm; fail: () => void };

/** A scripted model that reads every source as `reading`. */
function scriptedReader(reading: ModelAnswer): Reader {
  let failing = false;
  const faux = fauxProvider();
  faux.setResponses([
    () =>
      failing
        ? fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded" })
        : fauxAssistantMessage(fauxToolCall("read_recipe", JSON.parse(JSON.stringify(reading))), {
            stopReason: "toolUse",
          }),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  return {
    llm: claudeLlm(models, faux.getModel()),
    fail: () => {
      failing = true;
    },
  };
}

function fakeReader(reading: ModelAnswer): Reader {
  const llm = new FakeLlm();
  llm.reading = reading;
  return {
    llm,
    fail: () => {
      llm.failing = true;
    },
  };
}

describe.each([
  ["Claude through pi-ai", scriptedReader],
  ["the fake", fakeReader],
])("reading a recipe: %s", (_, open) => {
  const caption = "Grandma's dal 🍲 serves 4, 40 min\n1 cup red lentils\n2 tbsp ghee\nSimmer, then temper.";
  const dal: RecipeReading = {
    isRecipe: true,
    title: "Grandma's dal",
    ingredients: ["1 cup red lentils", "2 tbsp ghee"],
    steps: ["Simmer, then temper."],
    servings: 4,
    minutes: 40,
    course: "main",
  };

  test("gives the recipe it read, with each Ingredient line as written", async () => {
    expect(await open(dal).llm.readRecipe({ text: caption })).toEqual(dal);
  });

  test("says when the source holds no recipe", async () => {
    expect(await open({ isRecipe: false }).llm.readRecipe({ text: "Recipe in bio!" })).toEqual({ isRecipe: false });
  });

  test("reads servings or a time out of range as unknown, rather than failing the read", async () => {
    const toast = { isRecipe: true, title: "Toast", ingredients: ["1 slice bread"], servings: 0, minutes: 2.5 };

    expect(await open(toast).llm.readRecipe({ text: "Toast" })).toEqual({
      isRecipe: true,
      title: "Toast",
      ingredients: ["1 slice bread"],
      steps: [],
      servings: null,
      minutes: null,
      course: null,
    });
  });

  test("throws LlmError for a recipe with no title", async () => {
    await expect(open({ isRecipe: true, ingredients: ["1 egg"] }).llm.readRecipe({ text: "1 egg" })).rejects.toThrow(
      LlmError,
    );
  });

  test("throws LlmError when the model fails", async () => {
    const reader = open(dal);
    reader.fail();

    await expect(reader.llm.readRecipe({ text: caption })).rejects.toThrow(LlmError);
  });
});

describe("the Claude adapter", () => {
  test("leaves out an answer it cannot read, such as an Item id that does not exist", async () => {
    const faux = fauxProvider();
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("suggest_items", {
          suggestions: [
            { name: "tahini paste", item: "no_such_item" },
            { name: "gochujang", newItem: { name: "gochujang", section: "international" } },
            { name: "beurre", item: "butter" },
          ],
        }),
        { stopReason: "toolUse" },
      ),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);

    const answers = await claudeLlm(models, faux.getModel()).makeSuggestions({
      names: ["tahini paste", "gochujang", "beurre"],
      catalogue: SHIPPED_ITEMS.items,
    });

    expect(answers).toEqual([{ name: "beurre", suggested: { kind: "existing", item: "butter" } }]);
  });

  test("throws LlmError when the model reads a recipe without the tool", async () => {
    const faux = fauxProvider();
    faux.setResponses([fauxAssistantMessage("That's a dal recipe.")]);
    const models = createModels();
    models.setProvider(faux.provider);

    await expect(claudeLlm(models, faux.getModel()).readRecipe({ text: "dal" })).rejects.toThrow(LlmError);
  });

  test("throws LlmError when the model answers without the tool", async () => {
    const faux = fauxProvider();
    faux.setResponses([fauxAssistantMessage("I think tahini paste is tahini.")]);
    const models = createModels();
    models.setProvider(faux.provider);

    await expect(
      claudeLlm(models, faux.getModel()).makeSuggestions({ names: ["tahini paste"], catalogue: SHIPPED_ITEMS.items }),
    ).rejects.toThrow(LlmError);
  });
});

describe("the deployed LLM", () => {
  test("asks a model that always thinks without forcing the tool, which Anthropic refuses", async () => {
    // The request is answered here, so no test reaches Anthropic.
    const sent: Record<string, unknown>[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return Response.json(
        { type: "error", error: { type: "invalid_request_error", message: "test" } },
        { status: 400 },
      );
    });
    useLlm(undefined);

    await expect(
      openLlm({ ANTHROPIC_API_KEY: "test-key" }).makeSuggestions({ names: ["beurre"], catalogue: SHIPPED_ITEMS.items }),
    ).rejects.toThrow(LlmError);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ model: "claude-sonnet-5-5", thinking: { type: "adaptive" } });
    // Only "auto" works with thinking: a forced tool ("tool" or "any") is a 400 on every request.
    expect([undefined, "auto"]).toContain((sent[0]?.tool_choice as { type?: string } | undefined)?.type);
    vi.restoreAllMocks();
  });
});
