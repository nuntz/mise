import { env } from "cloudflare:workers";
import {
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxToolCall,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ChatWhere } from "@mise/domain";
import { afterEach, describe, expect, test } from "vitest";
import { useAgentModels } from "../src/agent";
import { connectAs } from "./connect";
import { caller, dinnerOn, familyHousehold, lastText, scriptModel, textOf, weekOf } from "./scripted";

// Monday 26 October 2026 to Sunday 1 November.
const MONDAY = "2026-10-26";
const TUESDAY = "2026-10-27";
const THURSDAY = "2026-10-29";
const FRIDAY = "2026-10-30";

const ON_THE_WEEK: ChatWhere = { screen: "week", week: MONDAY };

/** A Household whose Thursday dinner is Lemon chicken. */
async function householdWithThursdayDinner() {
  const household = env.Household.getByName(crypto.randomUUID());
  await household.callTool("setup_household", { name: "The Example Family", members: [{ name: "Robin" }] });
  await household.callTool("create_recipe", { title: "Lemon chicken", baseServings: 4, ingredients: ["1 chicken"] });
  await household.callTool("set_slot", { date: THURSDAY, meal: "dinner", kind: "recipe", recipeId: 1 });
  return household;
}

/** Everything a request shows the model, as one text. */
function allText(context: TranscriptContext): string {
  return context.messages.map(textOf).join("\n");
}

/** The newest message a person sent, as the model sees it. */
function lastUserText(context: TranscriptContext): string {
  return textOf([...context.messages].reverse().find((message) => message.role === "user"));
}

/** The system prompt's sections and the tools offered, as the first request of a conversation shows them. */
function systemOf(context: TranscriptContext): { sections: string; tools: string[] } {
  const system = context.messages.find((message) => (message.role as string) === "system") as
    | { sections?: Record<string, string>; toolsAdded?: { name: string }[] }
    | undefined;
  return {
    sections: Object.values(system?.sections ?? {}).join("\n"),
    tools: (system?.toolsAdded ?? []).map((tool) => tool.name),
  };
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

afterEach(() => useAgentModels(undefined));

describe("the agent", () => {
  test("answers what's for dinner Thursday from the Week it reads through get_week", async () => {
    scriptModel(dinnerReader());
    const household = await householdWithThursdayDinner();

    const reply = await household.chat("What's for dinner Thursday?", ON_THE_WEEK);

    expect(reply).toEqual({ ok: true, value: { role: "agent", text: "Thursday's dinner is Lemon chicken." } });
  });

  test("keeps one conversation for the Household, without the tool calls in between", async () => {
    scriptModel(dinnerReader());
    const household = await householdWithThursdayDinner();

    await household.chat("What's for dinner Thursday?", ON_THE_WEEK);
    await household.chat("And Thursday again?", ON_THE_WEEK);

    expect(await household.conversation()).toEqual([
      { role: "member", speaker: null, text: "What's for dinner Thursday?" },
      { role: "agent", text: "Thursday's dinner is Lemon chicken." },
      { role: "member", speaker: null, text: "And Thursday again?" },
      { role: "agent", text: "Thursday's dinner is Lemon chicken." },
    ]);
  });

  test("refuses an empty message, or one sent from nowhere, without asking the model", async () => {
    const faux = scriptModel(dinnerReader());
    const household = await householdWithThursdayDinner();

    const empty = await household.chat("   ", ON_THE_WEEK);
    const nowhere = await household.chat("What's for dinner?", { screen: "attic" });

    expect(empty).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(nowhere).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(faux.state.callCount).toBe(0);
  });

  test("says when the model fails instead of answering", async () => {
    scriptModel(() =>
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "Your credit balance is too low" }),
    );
    const household = await householdWithThursdayDinner();

    const reply = await household.chat("What's for dinner Thursday?", ON_THE_WEEK);

    expect(reply).toMatchObject({ ok: false, error: { code: "unanswered" } });
  });
});

describe("what the agent is told", () => {
  test("the system prompt describes the Household, its Members and their Constraints", async () => {
    const seen: string[] = [];
    scriptModel((context) => {
      seen.push(systemOf(context).sections);
      return fauxAssistantMessage("Hello.");
    });
    const household = await familyHousehold();

    await household.chat("Hello", ON_THE_WEEK);

    const system = seen[0] ?? "";
    expect(system).toContain("The Example Family");
    expect(system).toContain("America/Vancouver");
    expect(system).toMatch(/Robin \(Member 1\).*allergic to peanut/);
    expect(system).toContain("Alex (Member 2)");
    expect(system).toContain("Sam (Member 3)");
  });

  test("is offered the tool catalogue, except setup, uploads and what only a person may do", async () => {
    const offered: string[][] = [];
    scriptModel((context) => {
      offered.push(systemOf(context).tools);
      return fauxAssistantMessage("Hello.");
    });
    const household = await familyHousehold();

    await household.chat("Hello", ON_THE_WEEK);

    const tools = offered[0] ?? [];
    for (const tool of [
      "get_household",
      "get_caller",
      "get_week",
      "propose_week",
      "set_slot",
      "set_diners",
      "set_guests",
      "lock_slot",
      "search_recipes",
      "get_recipe",
      "list_items",
      "list_staples",
      "upsert_staple",
      "record_staple_status",
      "build_grocery_list",
      "import_url",
      "import_text",
      // Wait for a person's tap (ADR 0024).
      "delete_recipe",
      "clear_week",
      "update_member",
      "update_member_constraints",
      "remove_member",
      "link_leftovers",
    ]) {
      expect(tools).toContain(tool);
    }
    for (const tool of [
      // Never: it would recreate the Household (ADR 0024).
      "setup_household",
      // Uploads come over HTTP, which the agent can't make.
      "run_paprika_import",
      "import_screenshots",
      // Only a person accepts what a model read or suggested (ADR 0023), or states an Item's Allergens.
      "accept_suggestion",
      "accept_draft",
      "create_item",
      "update_item",
      "resolve_ingredient",
    ]) {
      expect(tools).not.toContain(tool);
    }
  });
});

describe("what the agent is offered, as Anthropic takes it", () => {
  // Anthropic takes a tool's input as one object, and pi-ai sends only the root's `properties` and
  // `required`: a schema of alternatives at the root reaches the model as a tool without parameters.
  test("every tool's input is one object with its properties at the root", async () => {
    const offered: { name: string; parameters: { type?: string; properties?: object; oneOf?: unknown } }[][] = [];
    scriptModel((context) => {
      const system = context.messages.find((message) => (message.role as string) === "system") as
        | { toolsAdded?: (typeof offered)[number] }
        | undefined;
      offered.push(system?.toolsAdded ?? []);
      return fauxAssistantMessage("Hello.");
    });
    const household = await familyHousehold();

    await household.chat("Hello", ON_THE_WEEK);

    for (const tool of offered[0] ?? []) {
      expect(tool.parameters, tool.name).toMatchObject({ type: "object", properties: expect.any(Object) });
      expect(tool.parameters, tool.name).not.toHaveProperty("oneOf");
    }
    const setSlot = offered[0]?.find((tool) => tool.name === "set_slot");
    expect(Object.keys(setSlot?.parameters.properties ?? {})).toEqual(
      expect.arrayContaining(["date", "meal", "kind", "recipeId", "overrides"]),
    );
    expect(setSlot?.parameters).toMatchObject({ required: ["date", "meal", "kind"] });
  });

  test("“a rice bowl for breakfast Friday” plans breakfast", async () => {
    scriptModel(caller([["set_slot", { date: FRIDAY, meal: "breakfast", kind: "recipe", recipeId: 2 }]]));
    const household = await familyHousehold();

    await household.chat("Rice bowl for breakfast Friday", ON_THE_WEEK);

    const breakfast = (await weekOf(household, FRIDAY)).slots.find(
      (slot) => slot.date === FRIDAY && slot.meal === "breakfast",
    );
    expect(breakfast).toMatchObject({ kind: "recipe", recipe: { id: 2 } });
  });
});

describe("who is speaking", () => {
  test("each turn is shown to the model with its speaker and where the chat was opened, and its tools run as them", async () => {
    const seen: string[] = [];
    scriptModel((context) => {
      if (context.messages.at(-1)?.role !== "toolResult") {
        seen.push(lastUserText(context));
        return fauxAssistantMessage(fauxToolCall("get_caller", {}), { stopReason: "toolUse" });
      }
      const caller = JSON.parse(lastText(context)) as { email: string };
      return fauxAssistantMessage(`You are ${caller.email}.`);
    });
    const household = await familyHousehold();
    const robin = await connectAs(household, "robin@example.com");

    const reply = await robin.rpc("chat", ["Who am I?", ON_THE_WEEK]);

    expect(seen).toEqual(["[Robin, on the Week screen, showing the Week of Monday 2026-10-26]\nWho am I?"]);
    expect(reply).toEqual({ ok: true, value: { role: "agent", text: "You are robin@example.com." } });
    expect(await household.conversation()).toEqual([
      { role: "member", speaker: "Robin", text: "Who am I?" },
      { role: "agent", text: "You are robin@example.com." },
    ]);
  });

  test("a Caller who is no Member is shown by their email", async () => {
    scriptModel(() => fauxAssistantMessage("Hello."));
    const household = await familyHousehold();
    const guest = await connectAs(household, "guest@example.com");

    await guest.rpc("chat", ["Hello", { screen: "recipes" }]);

    expect(await household.conversation()).toContainEqual({
      role: "member",
      speaker: "guest@example.com",
      text: "Hello",
    });
  });

  test("two people's messages are answered one after the other, each as its own speaker", async () => {
    let releaseRobin!: () => void;
    const robinHeld = new Promise<void>((resolve) => (releaseRobin = resolve));
    const requests: string[] = [];
    scriptModel(async (context) => {
      const last = context.messages.at(-1);
      requests.push(last?.role === "toolResult" ? "tool result" : lastUserText(context));
      if (last?.role !== "toolResult") {
        // Robin's turn is held at its first request, until Alex has sent theirs.
        if (lastUserText(context).endsWith("Robin here")) await robinHeld;
        return fauxAssistantMessage(fauxToolCall("get_caller", {}), { stopReason: "toolUse" });
      }
      const caller = JSON.parse(lastText(context)) as { email: string };
      return fauxAssistantMessage(`You are ${caller.email}.`);
    });
    const household = await familyHousehold();
    const robin = await connectAs(household, "robin@example.com");
    const alex = await connectAs(household, "alex@example.com");

    const robinReply = robin.rpc("chat", ["Robin here", ON_THE_WEEK]);
    // Give Robin's turn time to start, then send Alex's while it runs.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const alexReply = alex.rpc("chat", ["Alex here", ON_THE_WEEK]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    releaseRobin();

    expect(await robinReply).toEqual({ ok: true, value: { role: "agent", text: "You are robin@example.com." } });
    expect(await alexReply).toEqual({ ok: true, value: { role: "agent", text: "You are alex@example.com." } });
    expect(requests.map((request) => request.split("\n").at(-1))).toEqual([
      "Robin here",
      "tool result",
      "Alex here",
      "tool result",
    ]);
    expect(await household.conversation()).toEqual([
      { role: "member", speaker: "Robin", text: "Robin here" },
      { role: "agent", text: "You are robin@example.com." },
      { role: "member", speaker: "Alex", text: "Alex here" },
      { role: "agent", text: "You are alex@example.com." },
    ]);
  });
});

describe("typical turns", () => {
  test("“re-propose the week but keep Tuesday” locks Tuesday and proposes the rest again", async () => {
    scriptModel(
      caller([
        ["lock_slot", { date: TUESDAY, meal: "dinner", locked: true }],
        ["propose_week", { date: MONDAY, reroll: true }],
      ]),
    );
    const household = await familyHousehold();
    await household.callTool("set_slot", { date: TUESDAY, meal: "dinner", kind: "recipe", recipeId: 2 });

    const reply = await household.chat("Re-propose the week but keep Tuesday", ON_THE_WEEK);

    expect(reply).toMatchObject({ ok: true });
    const dinners = (await weekOf(household, MONDAY)).slots.filter((slot) => slot.meal === "dinner");
    expect(dinners.find((slot) => slot.date === TUESDAY)).toMatchObject({ recipe: { id: 2 }, locked: true });
    expect(dinners.filter((slot) => slot.recipe !== null)).toHaveLength(7);
  });

  test("“just the two of us Friday” sets Friday's Diners", async () => {
    scriptModel(caller([["set_diners", { date: FRIDAY, diners: [1, 2] }]]));
    const household = await familyHousehold();

    await household.chat("Just the two of us Friday", ON_THE_WEEK);

    expect(await dinnerOn(household, FRIDAY)).toMatchObject({ diners: [1, 2] });
  });

  test("“swap Thursday for something with the chicken we have” searches, then sets Thursday", async () => {
    scriptModel(
      caller([
        ["search_recipes", { query: "chicken" }],
        ["set_slot", { date: THURSDAY, meal: "dinner", kind: "recipe", recipeId: 1 }],
      ]),
    );
    const household = await householdWithThursdayDinner();
    await household.callTool("set_slot", { date: THURSDAY, meal: "dinner", kind: "eat_out" });

    await household.chat("Swap Thursday for something with the chicken we have", ON_THE_WEEK);

    expect(await dinnerOn(household, THURSDAY)).toMatchObject({ kind: "recipe", recipe: { title: "Lemon chicken" } });
  });

  test("“we're out of cumin” records cumin as out in one call, making it a Staple", async () => {
    scriptModel(caller([["record_staple_status", { item: "cumin", status: "out" }]]));
    const household = await familyHousehold();

    const reply = await household.chat("We're out of cumin", { screen: "pantry" });

    expect(reply).toMatchObject({ ok: true });
    expect(await household.callTool("list_staples", {})).toMatchObject({
      value: [{ item: "cumin", status: "out" }],
    });
  });

  test("a pasted link is imported", async () => {
    scriptModel(caller([["import_url", { url: "https://kitchen.example.com/recipes/dal/" }]]));
    const household = await familyHousehold();

    await household.chat("https://kitchen.example.com/recipes/dal/", { screen: "recipes" });

    expect(await household.callTool("list_drafts", {})).toMatchObject({ value: [{ recipe: { draft: true } }] });
  });

  test("an Override waits for a person's tap, and the Slot stays as it was", async () => {
    scriptModel(
      caller([
        [
          "set_slot",
          {
            date: FRIDAY,
            meal: "dinner",
            kind: "recipe",
            recipeId: 1,
            overrides: [{ who: 1, allergen: "peanut", reason: "We'll make Robin's without the sauce" }],
          },
        ],
      ]),
    );
    const household = await familyHousehold();

    const reply = await household.chat("Plan Satay Friday anyway", ON_THE_WEEK);

    expect(reply).toMatchObject({ ok: true, value: { text: expect.stringMatching(/^Done: Nothing is changed yet/) } });
    expect(await dinnerOn(household, FRIDAY)).toMatchObject({ recipe: null });
  });

  test("a Conflict the agent runs into names the person and the Allergen", async () => {
    scriptModel(caller([["set_slot", { date: FRIDAY, meal: "dinner", kind: "recipe", recipeId: 1 }]]));
    const household = await familyHousehold();

    const reply = await household.chat("Plan Satay Friday", ON_THE_WEEK);

    expect(reply).toMatchObject({ ok: true, value: { text: expect.stringContaining("constraint_conflict") } });
    expect(reply).toMatchObject({ ok: true, value: { text: expect.stringContaining("peanut") } });
    expect(await dinnerOn(household, FRIDAY)).toMatchObject({ recipe: null });
  });
});

describe("screens and the agent", () => {
  test("what the agent changes is announced to every connected screen, and so is each answer", async () => {
    scriptModel(caller([["set_diners", { date: FRIDAY, diners: [1, 2] }]]));
    const household = await familyHousehold();
    const screen = await connectAs(household, "alex@example.com");

    await household.chat("Just the two of us Friday", ON_THE_WEEK);
    // Notices arrive over the socket a moment after the answer.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(screen.notices.map((notice) => notice.topic)).toEqual(["plan", "chat"]);
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
      if (lastText(context).endsWith("When is Sam's birthday dinner?")) {
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

    const replies = [await household.chat(BIRTHDAY, ON_THE_WEEK)];
    for (let turn = 1; turn <= 40; turn++) {
      const chatter = `Turn ${turn}. ${"Some long chatter about what we might cook. ".repeat(60)}`;
      replies.push(await household.chat(chatter, ON_THE_WEEK));
    }
    const answer = await household.chat("When is Sam's birthday dinner?", ON_THE_WEEK);

    expect(replies.filter((reply) => !reply.ok)).toEqual([]);
    const last = requests.at(-1) ?? "";
    expect(requests.some((request) => request.includes(SUMMARISER))).toBe(true);
    expect(last).toContain("<summary>");
    expect(last).not.toContain(BIRTHDAY);
    expect(answer).toEqual({ ok: true, value: { role: "agent", text: "On Saturday." } });
    // The chat still shows the turns the model now sees only as a summary.
    const conversation = await household.conversation();
    expect(conversation).toHaveLength(84);
    expect(conversation[0]).toEqual({ role: "member", speaker: null, text: BIRTHDAY });
  });

  test("on Haiku, with its million-token window, is compacted before a request reaches 80,000 tokens", async () => {
    const requests: string[] = [];
    scriptModel(rememberer(requests), { provider: "anthropic", id: "claude-haiku-5-5", contextWindow: 1_000_000 });
    const household = env.Household.getByName(crypto.randomUUID());
    await household.callTool("setup_household", { name: "The Example Family" });

    // About 1,300 tokens a turn: some 100,000 tokens in all, were nothing compacted.
    for (let turn = 1; turn <= 80; turn++) {
      const chatter = `Turn ${turn}. ${"Some long chatter about what we might cook. ".repeat(60)}`;
      expect(await household.chat(chatter, ON_THE_WEEK)).toMatchObject({ ok: true });
    }

    expect(requests.some((request) => request.includes(SUMMARISER))).toBe(true);
    const largest = Math.max(...requests.map((request) => request.length / 4));
    expect(largest).toBeLessThan(80_000);
  });
});

describe("the agent's conversation and the export", () => {
  const householdUrl = "http://mise.example.com/agents/household/household";

  test("the speaker records are exported and restored; what was said stays out", async () => {
    scriptModel(dinnerReader());
    const household = await familyHousehold();
    const robin = await connectAs(household, "robin@example.com");
    await robin.rpc("chat", ["What's for dinner Thursday?", ON_THE_WEEK]);

    const exported = await (await household.fetch(`${householdUrl}/export`)).text();
    const fresh = env.Household.getByName(crypto.randomUUID());
    const restored = await fresh.fetch(`${householdUrl}/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: exported,
    });

    const tables = JSON.parse(exported).tables as Record<string, Record<string, unknown>[]>;
    expect(Object.keys(tables).filter((table) => table.startsWith("pi_"))).toEqual([]);
    expect(tables.chat_turn).toEqual([
      { id: 1, email: "robin@example.com", member_id: 1, speaker: "Robin", sent_at: expect.any(String) },
    ]);
    expect(exported).not.toContain("What's for dinner Thursday?");
    expect(restored.status).toBe(200);
    expect(await (await fresh.fetch(`${householdUrl}/export`)).text()).toBe(exported);
  });
});
