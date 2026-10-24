import {
  createModels,
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { FakeLlm, type Llm, LlmError, SHIPPED_ITEMS, type SuggestedItem } from "@mise/domain";
import { describe, expect, test, vi } from "vitest";
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
