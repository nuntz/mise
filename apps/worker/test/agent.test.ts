import { env } from "cloudflare:workers";
import {
  createModels,
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, test } from "vitest";
import { useAgentModels } from "../src/agent";

// Monday 26 October 2026 to Sunday 1 November.
const THURSDAY = "2026-10-29";

/** A Household whose Thursday dinner is Lemon chicken. */
async function householdWithThursdayDinner() {
  const household = env.Household.getByName(crypto.randomUUID());
  await household.callTool("setup_household", { name: "The Example Family", members: [{ name: "Robin" }] });
  await household.callTool("create_recipe", { title: "Lemon chicken", baseServings: 4, ingredients: ["1 chicken"] });
  await household.callTool("set_slot", { date: THURSDAY, meal: "dinner", kind: "recipe", recipeId: 1 });
  return household;
}

/** The text of a message's content. */
function textOf(message: TranscriptContext["messages"][number] | undefined): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  return (content ?? []).map((block) => ("text" in block ? block.text : "")).join("");
}

/** The text of the newest message, of whatever role. */
function lastText(context: TranscriptContext): string {
  return textOf(context.messages.at(-1));
}

/** Everything a request shows the model, as one text. */
function allText(context: TranscriptContext): string {
  return context.messages.map(textOf).join("\n");
}

/**
 * A scripted model in place of Claude, so no test calls a real one. Asked anything, it reads Thursday's
 * Week with `get_week`, then answers with the title of the dinner the tool returned.
 */
function dinnerReader(): FauxResponseFactory {
  return (context) => {
    const last = context.messages.at(-1);
    if (last?.role !== "toolResult") {
      return fauxAssistantMessage(fauxToolCall("get_week", { date: THURSDAY }), { stopReason: "toolUse" });
    }
    const week = JSON.parse(lastText(context)) as {
      slots: { date: string; meal: string; recipe: { title: string } | null }[];
    };
    const dinner = week.slots.find((slot) => slot.date === THURSDAY && slot.meal === "dinner");
    return fauxAssistantMessage(`Thursday's dinner is ${dinner?.recipe?.title ?? "not planned"}.`);
  };
}

/**
 * Puts the agent of households started from now on a faux model that answers every request with
 * `respond`. A household's models are fixed when it starts, so script the model before using it.
 */
function scriptModel(respond: FauxResponseFactory, { contextWindow }: { contextWindow?: number } = {}) {
  const faux = fauxProvider({ models: [{ id: "scripted", contextWindow }] });
  const models = createModels();
  models.setProvider(faux.provider);
  // Each request takes the next scripted response; one factory per request it might make.
  faux.setResponses(Array.from({ length: 200 }, () => respond));
  useAgentModels(() => ({ models, model: faux.getModel() }));
  return faux;
}

afterEach(() => useAgentModels(undefined));

describe("the agent", () => {
  test("answers what's for dinner Thursday from the Week it reads through get_week", async () => {
    scriptModel(dinnerReader());
    const household = await householdWithThursdayDinner();

    const reply = await household.chat("What's for dinner Thursday?");

    expect(reply).toEqual({ ok: true, value: { role: "agent", text: "Thursday's dinner is Lemon chicken." } });
  });

  test("keeps one conversation for the Household, without the tool calls in between", async () => {
    scriptModel(dinnerReader());
    const household = await householdWithThursdayDinner();

    await household.chat("What's for dinner Thursday?");
    await household.chat("And Thursday again?");

    expect(await household.conversation()).toEqual([
      { role: "member", text: "What's for dinner Thursday?" },
      { role: "agent", text: "Thursday's dinner is Lemon chicken." },
      { role: "member", text: "And Thursday again?" },
      { role: "agent", text: "Thursday's dinner is Lemon chicken." },
    ]);
  });

  test("refuses an empty message without asking the model", async () => {
    const faux = scriptModel(dinnerReader());
    const household = await householdWithThursdayDinner();

    const reply = await household.chat("   ");

    expect(reply).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(faux.state.callCount).toBe(0);
  });

  test("says when the model fails instead of answering", async () => {
    scriptModel(() =>
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "Your credit balance is too low" }),
    );
    const household = await householdWithThursdayDinner();

    const reply = await household.chat("What's for dinner Thursday?");

    expect(reply).toMatchObject({ ok: false, error: { code: "unanswered" } });
  });
});

describe("a long conversation", () => {
  const BIRTHDAY = "Remember that Sam's birthday dinner is on Saturday.";
  const SUMMARISER = "context summarization assistant";

  /**
   * Answers the birthday question from whatever it is shown, says "Noted." to anything else, and when
   * asked to summarise keeps only the birthday, if what it summarises (an earlier summary included) has it.
   */
  function rememberer(requests: string[]): FauxResponseFactory {
    return (context) => {
      const shown = allText(context);
      requests.push(shown);
      const known = /Sam's birthday dinner(?: is on|:) Saturday/.test(shown);
      if (shown.includes(SUMMARISER)) {
        return fauxAssistantMessage(known ? "Sam's birthday dinner: Saturday." : "Nothing to keep.");
      }
      if (lastText(context).startsWith("When is Sam's birthday dinner?")) {
        return fauxAssistantMessage(known ? "On Saturday." : "I don't know.");
      }
      return fauxAssistantMessage(`Noted. ${"Here is a long answer about meal planning. ".repeat(60)}`);
    };
  }

  test("keeps working after it is compacted, and keeps what the summary kept", async () => {
    const requests: string[] = [];
    // A small context window, so that forty long turns cross the default compaction thresholds.
    scriptModel(rememberer(requests), { contextWindow: 60_000 });
    const household = env.Household.getByName(crypto.randomUUID());
    await household.callTool("setup_household", { name: "The Example Family" });

    const replies = [await household.chat(BIRTHDAY)];
    for (let turn = 1; turn <= 40; turn++) {
      replies.push(await household.chat(`Turn ${turn}. ${"Some long chatter about what we might cook. ".repeat(60)}`));
    }
    const answer = await household.chat("When is Sam's birthday dinner?");

    expect(replies.filter((reply) => !reply.ok)).toEqual([]);
    const last = requests.at(-1) ?? "";
    expect(requests.some((request) => request.includes(SUMMARISER))).toBe(true);
    expect(last).toContain("<summary>");
    expect(last).not.toContain(BIRTHDAY);
    expect(answer).toEqual({ ok: true, value: { role: "agent", text: "On Saturday." } });
    // The chat still shows the turns the model now sees only as a summary.
    const conversation = await household.conversation();
    expect(conversation).toHaveLength(84);
    expect(conversation[0]).toEqual({ role: "member", text: BIRTHDAY });
  });
});

describe("the agent's conversation and the export", () => {
  const householdUrl = "http://mise.example.com/agents/household/household";

  test("stays out of the export, which still restores into a fresh deployment", async () => {
    scriptModel(dinnerReader());
    const household = await householdWithThursdayDinner();
    await household.chat("What's for dinner Thursday?");

    const exported = await (await household.fetch(`${householdUrl}/export`)).text();
    const fresh = env.Household.getByName(crypto.randomUUID());
    const restored = await fresh.fetch(`${householdUrl}/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: exported,
    });

    expect(Object.keys(JSON.parse(exported).tables).filter((table) => table.startsWith("pi_"))).toEqual([]);
    expect(exported).not.toContain("What's for dinner Thursday?");
    expect(restored.status).toBe(200);
    expect(await (await fresh.fetch(`${householdUrl}/export`)).text()).toBe(exported);
  });
});
