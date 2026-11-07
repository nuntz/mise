import { evictDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxToolCall,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ChatWhere, WeekForTheAgent } from "@mise/domain";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AGENT_MODEL, agentModels, claudeAgentModels, useAgentModels } from "../src/agent";
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
    const week = JSON.parse(lastText(context)) as WeekForTheAgent;
    const thursday = week.days.find((day) => day.date === THURSDAY);
    const dinner = thursday?.meals.find((slot) => slot.meal === "dinner");
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

/** What the agent was given by the last tool it called, from a `caller` model's "Done: …" answer. */
function lastResult(reply: unknown): unknown {
  const text = (reply as { value?: { text?: string } }).value?.text ?? "";
  if (!text.startsWith("Done: ")) throw new Error(`No tool result in ${JSON.stringify(reply)}`);
  return JSON.parse(text.slice("Done: ".length));
}

// Given all 21 meals, each by ISO date alone, the agent listed six dinners for seven days, a day off (#142).
describe("the Week as the agent reads it", () => {
  test("goes day by day, each day named, with its dinner and only the breakfasts and lunches that hold something", async () => {
    scriptModel(caller([["get_week", { date: THURSDAY }]]));
    const household = await householdWithThursdayDinner();
    await household.callTool("set_slot", { date: TUESDAY, meal: "lunch", kind: "eat_out" });

    const week = lastResult(await household.chat("What's planned?", ON_THE_WEEK)) as WeekForTheAgent;

    expect(week.days.map(({ date, weekday }) => `${weekday} ${date}`)).toEqual([
      "Monday 2026-10-26",
      "Tuesday 2026-10-27",
      "Wednesday 2026-10-28",
      "Thursday 2026-10-29",
      "Friday 2026-10-30",
      "Saturday 2026-10-31",
      "Sunday 2026-11-01",
    ]);
    expect(week.days.map((day) => day.meals.map(({ meal, kind }) => `${meal} ${kind}`))).toEqual([
      ["dinner unplanned"],
      ["lunch eat_out", "dinner unplanned"],
      ["dinner unplanned"],
      ["dinner recipe"],
      ["dinner unplanned"],
      ["dinner unplanned"],
      ["dinner unplanned"],
    ]);
    expect(week.days[3]?.meals[0]).toMatchObject({
      recipe: { title: "Lemon chicken" },
      reason: null,
      pencilled: false,
    });
  });

  test("is how a Proposal returns it too, with whether it changed a dinner", async () => {
    scriptModel(caller([["propose_week", { date: THURSDAY }]]));
    // Nine Recipes, so that Mise has some to choose; Thursday's dinner is chosen by hand.
    const household = await familyHousehold();
    await household.callTool("set_slot", { date: THURSDAY, meal: "dinner", kind: "recipe", recipeId: 2 });

    const proposed = lastResult(await household.chat("Plan the week", ON_THE_WEEK)) as {
      week: WeekForTheAgent;
      changed: boolean;
    };

    expect(proposed.changed).toBe(true);
    expect(proposed.week.days.map((day) => day.weekday)).toHaveLength(7);
    const dinners = proposed.week.days.map((day) => day.meals.find(({ meal }) => meal === "dinner"));
    expect(dinners[3], "Thursday's is the Household's own").toMatchObject({ reason: null, pencilled: false });
    expect(dinners[0], "Monday's is pencilled").toMatchObject({ pencilled: true });
    expect(dinners[0]?.reason).not.toBeNull();
  });
});

/** A scripted model that answers "OK." to every turn, keeping each turn as the model is shown it in `seen`. */
function seeing(seen: string[]): FauxResponseFactory {
  return (context) => {
    seen.push(lastUserText(context));
    return fauxAssistantMessage("OK.");
  };
}

// Changes made on a screen never reach the conversation, so the agent once called a dinner Kept on the
// screen Mise's, and a breakfast cleared on the screen planned, from earlier turns (#142).
describe("a turn from the Week screen", () => {
  test("gives a dinner Kept on the screen since the last turn as the Household's own", async () => {
    const seen: string[] = [];
    scriptModel(seeing(seen));
    const household = await familyHousehold();
    await household.callTool("propose_week", { date: MONDAY });
    const thursday = (await dinnerOn(household, THURSDAY))?.recipe?.title;

    await household.chat("What's pencilled?", ON_THE_WEEK);
    await household.callTool("keep_slot", { date: THURSDAY, meal: "dinner" });
    await household.chat("And now?", ON_THE_WEEK);

    expect(seen[0]).toContain(`Thursday ${THURSDAY}: dinner ${thursday} (pencilled)`);
    expect(seen[1]).toContain(`Thursday ${THURSDAY}: dinner ${thursday} (the Household's own)`);
  });

  test("gives a Week cleared on the screen since the last turn as unplanned", async () => {
    const seen: string[] = [];
    scriptModel(seeing(seen));
    const household = await familyHousehold();
    const SUNDAY = "2026-11-01";
    await household.callTool("set_slot", { date: SUNDAY, meal: "breakfast", kind: "recipe", recipeId: 2 });

    await household.chat("What's for breakfast Sunday?", ON_THE_WEEK);
    await household.callTool("clear_week", { date: MONDAY, confirm: true });
    await household.chat("And now?", ON_THE_WEEK);

    expect(seen[0]).toContain(`Sunday ${SUNDAY}: breakfast Rice bowl 2, dinner nothing planned`);
    expect(seen[1]).toContain(`Sunday ${SUNDAY}: dinner nothing planned`);
    expect(seen[1]).not.toContain("breakfast Rice bowl 2");
  });

  test("gives no Week from another screen, even one showing a Week", async () => {
    const seen: string[] = [];
    scriptModel(seeing(seen));
    const household = await familyHousehold();

    await household.chat("What do we need?", { screen: "grocery", week: MONDAY });

    expect(seen[0]).not.toContain("The Week on screen");
  });
});

/**
 * A scripted model that fails the requests `failing` names (by the message's text), and otherwise
 * answers like a model shown several waiting messages: every message since its last answer, unless
 * the newest says to answer only it.
 */
function failingOn(...failing: string[]): FauxResponseFactory {
  return (context) => {
    const newest = lastUserText(context);
    if (failing.some((text) => newest.endsWith(`\n${text}`))) {
      return fauxAssistantMessage([], { stopReason: "error", errorMessage: "model_error" });
    }
    const answered = context.messages.map((message) => message.role).lastIndexOf("assistant");
    const sinceAnswer = context.messages.slice(answered + 1).filter((message) => message.role === "user");
    const waiting = /answer only this message/i.test(newest) ? [newest] : sinceAnswer.map(textOf);
    return fauxAssistantMessage(`Answering: ${waiting.map((text) => text.split("\n").at(-1)).join(" and ")}`);
  };
}

describe("after a failed turn", () => {
  test("the failed turn is shown unanswered, also once the conversation is read again", async () => {
    scriptModel(failingOn("What's for dinner Thursday?"));
    const household = await householdWithThursdayDinner();

    await household.chat("What's for dinner Thursday?", ON_THE_WEEK);
    const shown = await household.conversation();
    await evictDurableObject(household);

    const unanswered = { role: "member", speaker: null, text: "What's for dinner Thursday?", unanswered: true };
    expect(shown).toEqual([unanswered]);
    expect(await household.conversation()).toEqual([unanswered]);
  });

  test("the next message gets one answer, to it only", async () => {
    scriptModel(failingOn("What's for dinner Thursday?"));
    const household = await householdWithThursdayDinner();

    await household.chat("What's for dinner Thursday?", ON_THE_WEEK);
    const reply = await household.chat("Plan Friday", ON_THE_WEEK);

    expect(reply).toEqual({ ok: true, value: { role: "agent", text: "Answering: Plan Friday" } });
    expect(await household.conversation()).toEqual([
      { role: "member", speaker: null, text: "What's for dinner Thursday?", unanswered: true },
      { role: "member", speaker: null, text: "Plan Friday" },
      { role: "agent", text: "Answering: Plan Friday" },
    ]);
  });

  test("a turn answered after the failure leaves the turns answered before it as they read", async () => {
    const seen: TranscriptContext[] = [];
    const answer = failingOn("Plan Friday");
    scriptModel((context, ...rest) => {
      seen.push(context);
      return answer(context, ...rest);
    });
    const household = await householdWithThursdayDinner();

    await household.chat("Hello", ON_THE_WEEK);
    await household.chat("Plan Friday", ON_THE_WEEK);
    await household.chat("Plan Saturday", ON_THE_WEEK);
    await household.chat("Thanks", ON_THE_WEEK);

    expect(await household.conversation()).toEqual([
      { role: "member", speaker: null, text: "Hello" },
      { role: "agent", text: "Answering: Hello" },
      { role: "member", speaker: null, text: "Plan Friday", unanswered: true },
      { role: "member", speaker: null, text: "Plan Saturday" },
      { role: "agent", text: "Answering: Plan Saturday" },
      { role: "member", speaker: null, text: "Thanks" },
      { role: "agent", text: "Answering: Thanks" },
    ]);
    // Only the turn sent after the failure is told to answer alone; the others read as they were sent.
    const users = (seen.at(-1)?.messages ?? []).filter((message) => message.role === "user").map(textOf);
    expect(users.map((text) => /answer only this message/.test(text))).toEqual([false, false, true, false]);
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

  test("the system prompt says how to answer a spoken turn", async () => {
    const seen: string[] = [];
    scriptModel((context) => {
      seen.push(systemOf(context).sections);
      return fauxAssistantMessage("Hello.");
    });
    const household = await familyHousehold();

    await household.chat("Hello", ON_THE_WEEK);

    const system = seen[0] ?? "";
    expect(system).toMatch(/spoken turns/i);
    expect(system).toMatch(/one or two plain sentences/i);
    expect(system).toMatch(/weekday/i);
    expect(system).toMatch(/never name more than three/i);
    expect(system, "a long list ends by saying what to say for more, not with a question").toMatch(/say “more”/i);
    expect(system).not.toMatch(/ask whether to go on/i);
    expect(system).toMatch(/already passed/i);
    expect(system).toMatch(/anyone in the room/i);
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
      "propose_dinner",
      "set_use_up",
      "set_slot",
      "set_diners",
      "set_guests",
      "keep_slot",
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
      // Retired: Keep does what Lock did (ADR 0030).
      "lock_slot",
    ]) {
      expect(tools).not.toContain(tool);
    }
  });
});

describe("what the agent is told about pencilled dinners", () => {
  test("a dinner marked pencilled has a reason, and a Re-roll leaves the Household's own", async () => {
    const offered: { name: string; description: string }[][] = [];
    scriptModel((context) => {
      const system = context.messages.find((message) => (message.role as string) === "system") as
        | { toolsAdded?: (typeof offered)[number] }
        | undefined;
      offered.push(system?.toolsAdded ?? []);
      return fauxAssistantMessage("Hello.");
    });
    const household = await familyHousehold();

    await household.chat("Hello", ON_THE_WEEK);

    const described = (name: string) => offered[0]?.find((tool) => tool.name === name)?.description ?? "";
    expect(described("get_week")).toMatch(/with `pencilled: true` is pencilled/);
    expect(described("get_week")).toMatch(/`pencilled: false` is the Household's own/);
    expect(described("propose_week")).toMatch(/leaves the Household's own dinners as they are/);
    expect(described("propose_week")).not.toMatch(/decided by hand/);
    expect(described("propose_dinner")).toMatch(/Let Mise choose Friday/);
    expect(described("propose_dinner")).toMatch(/pick something else for Friday/);
    expect(described("propose_dinner")).toMatch(/Recurring/);
    expect(described("keep_slot")).toMatch(/“keep Wednesday”/);
    for (const name of ["get_week", "propose_week", "propose_dinner", "set_use_up", "keep_slot"]) {
      expect(described(name)).not.toMatch(/suggestion/i);
    }
    expect(described("propose_week")).toMatch(/pencilled dinners/);
    expect(described("keep_slot")).toMatch(/Keeps a pencilled dinner/);
  });
});

describe("what the agent is told about Use it up", () => {
  test("the Week keeps it: set_use_up sets it, and propose_week takes no Items", async () => {
    const offered: { name: string; description: string; parameters: { properties?: object } }[][] = [];
    scriptModel((context) => {
      const system = context.messages.find((message) => (message.role as string) === "system") as
        | { toolsAdded?: (typeof offered)[number] }
        | undefined;
      offered.push(system?.toolsAdded ?? []);
      return fauxAssistantMessage("Hello.");
    });
    const household = await familyHousehold();

    await household.chat("Hello", ON_THE_WEEK);

    const tool = (name: string) => offered[0]?.find((offer) => offer.name === name);
    expect(tool("set_use_up")?.description).toMatch(/use up the spinach/);
    expect(Object.keys(tool("set_use_up")?.parameters.properties ?? {})).toEqual(["date", "items"]);
    expect(tool("propose_week")?.description).toMatch(/Use it up/);
    expect(Object.keys(tool("propose_week")?.parameters.properties ?? {})).not.toContain("useUp");
  });
});

describe("what the agent is told when nothing changed", () => {
  test("propose_week, set_use_up and propose_dinner say whether a dinner changed, and what to say when none did", async () => {
    const offered: { name: string; description: string }[][] = [];
    scriptModel((context) => {
      const system = context.messages.find((message) => (message.role as string) === "system") as
        | { toolsAdded?: (typeof offered)[number] }
        | undefined;
      offered.push(system?.toolsAdded ?? []);
      return fauxAssistantMessage("Hello.");
    });
    const household = await familyHousehold();

    await household.chat("Hello", ON_THE_WEEK);

    const described = (name: string) => offered[0]?.find((tool) => tool.name === name)?.description ?? "";
    expect(described("propose_week")).toMatch(/`changed: false`/);
    expect(described("propose_week")).toMatch(/Nothing to re-roll: every dinner is yours, or has only one Recipe/);
    expect(described("set_use_up")).toMatch(/`changed: false`/);
    expect(described("set_use_up")).toMatch(/No dinner changed: nothing that fits uses/);
    expect(described("propose_dinner")).toMatch(/`changed: false`/);
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

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-27T12:00:00-07:00"));
    const reply = await robin.rpc("chat", ["Who am I?", ON_THE_WEEK]);
    vi.useRealTimers();

    expect(seen).toEqual([
      "[Robin, writing on Tuesday 2026-10-27, on the Week screen, showing the Week of Monday 2026-10-26]\n" +
        "[The Week on screen, as it is now (a breakfast or lunch not named has nothing planned): " +
        "Monday 2026-10-26: dinner nothing planned (the Household's own); " +
        "Tuesday 2026-10-27: dinner nothing planned (the Household's own); " +
        "Wednesday 2026-10-28: dinner nothing planned (the Household's own); " +
        "Thursday 2026-10-29: dinner nothing planned (the Household's own); " +
        "Friday 2026-10-30: dinner nothing planned (the Household's own); " +
        "Saturday 2026-10-31: dinner nothing planned (the Household's own); " +
        "Sunday 2026-11-01: dinner nothing planned (the Household's own)]" +
        "\nWho am I?",
    ]);
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
  test("“pick something else for Friday” proposes Friday's dinner again and leaves the rest", async () => {
    scriptModel(caller([["propose_dinner", { date: FRIDAY }]]));
    const household = await familyHousehold();
    await household.callTool("set_slot", { date: FRIDAY, meal: "dinner", kind: "recipe", recipeId: 2 });
    await household.callTool("set_slot", { date: THURSDAY, meal: "dinner", kind: "recipe", recipeId: 3 });

    expect(await household.chat("Pick something else for Friday", ON_THE_WEEK)).toMatchObject({ ok: true });

    expect(await dinnerOn(household, FRIDAY)).toMatchObject({ kind: "recipe", reason: { kind: "chosen" } });
    expect((await dinnerOn(household, FRIDAY))?.recipe?.id).not.toBe(2);
    expect(await dinnerOn(household, THURSDAY)).toMatchObject({ recipe: { id: 3 }, reason: null });
  });

  test("“re-roll the week but keep Tuesday” keeps Tuesday and re-rolls the rest", async () => {
    scriptModel(
      caller([
        ["keep_slot", { date: TUESDAY, meal: "dinner" }],
        ["propose_week", { date: MONDAY, reroll: true }],
      ]),
    );
    // Pencilled rather than set by hand, which a Re-roll would leave anyway.
    const household = await familyHousehold();
    await household.callTool("propose_week", { date: MONDAY });
    const proposed = (await dinnerOn(household, TUESDAY))?.recipe?.id;

    const reply = await household.chat("Re-roll the week but keep Tuesday", ON_THE_WEEK);

    expect(reply).toMatchObject({ ok: true });
    const dinners = (await weekOf(household, MONDAY)).slots.filter((slot) => slot.meal === "dinner");
    expect(dinners.find((slot) => slot.date === TUESDAY)).toMatchObject({ recipe: { id: proposed }, reason: null });
    expect(dinners.filter((slot) => slot.recipe !== null)).toHaveLength(7);
  });

  test("keeping Tuesday holds when the Keep and the Re-roll come in one round", async () => {
    scriptModel((context) => {
      if (context.messages.at(-1)?.role === "toolResult") return fauxAssistantMessage("Done.");
      return fauxAssistantMessage(
        [
          fauxToolCall("keep_slot", { date: TUESDAY, meal: "dinner" }),
          fauxToolCall("propose_week", { date: MONDAY, reroll: true }),
        ],
        { stopReason: "toolUse" },
      );
    });
    const household = await familyHousehold();
    await household.callTool("propose_week", { date: MONDAY });
    const proposed = (await dinnerOn(household, TUESDAY))?.recipe?.id;

    expect(await household.chat("Re-roll the week but keep Tuesday", ON_THE_WEEK)).toMatchObject({ ok: true });

    expect(await dinnerOn(household, TUESDAY)).toMatchObject({ recipe: { id: proposed }, reason: null });
  });

  test("“use up the spinach” sets the Week's Use it up, and the Week adjusts", async () => {
    scriptModel(caller([["set_use_up", { date: MONDAY, items: ["spinach"] }]]));
    const household = await familyHousehold();
    await household.callTool("create_recipe", {
      title: "Spinach pie",
      baseServings: 4,
      ingredients: ["200 g spinach"],
      effortMinutes: 30,
    });
    await household.callTool("propose_week", { date: MONDAY });

    expect(await household.chat("Use up the spinach this week", ON_THE_WEEK)).toMatchObject({ ok: true });

    const week = await weekOf(household, MONDAY);
    expect(week.useUp).toEqual(["spinach"]);
    expect(week.slots.find((slot) => slot.date === MONDAY && slot.meal === "dinner")).toMatchObject({
      recipe: { title: "Spinach pie" },
      reason: { factors: expect.arrayContaining([{ kind: "uses_up", items: ["spinach"] }]) },
    });
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

  test("on the agent's model, with its million-token window, is compacted before a request reaches 80,000 tokens", async () => {
    const requests: string[] = [];
    scriptModel(rememberer(requests), { ...AGENT_MODEL, contextWindow: 1_000_000 });
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

describe("a new agent model", () => {
  test("once deployed, answers the turns of a Household whose conversation began on the old one", async () => {
    scriptModel(() => fauxAssistantMessage("The old model answers."), { id: "old" });
    const household = env.Household.getByName(crypto.randomUUID());
    await household.callTool("setup_household", { name: "The Example Family" });
    expect(await household.chat("Hello", ON_THE_WEEK)).toMatchObject({ value: { text: "The old model answers." } });

    // A deploy: the Household starts again, on the new model.
    scriptModel(() => fauxAssistantMessage("The new model answers."), { id: "new" });
    await evictDurableObject(household);

    expect(await household.chat("Hello again", ON_THE_WEEK)).toEqual({
      ok: true,
      value: { role: "agent", text: "The new model answers." },
    });
  });
});

describe("the agent's system prompt, as Claude takes it", () => {
  // A section that changes (the date every day, a deploy's new rule) must not reach the model as a
  // system message after the person's words: it has recited or refused one as if it were theirs.
  test("the agent's model, and one the eval names, take no system message mid-conversation", () => {
    for (const { models, model } of [agentModels(env), claudeAgentModels("a key", "claude-sonnet-5-5")]) {
      expect(models.getModel(model.provider, model.id)?.compat, model.id).toMatchObject({
        supportsMidConvoSystemMessages: false,
        supportsMidConvoToolChanges: false,
      });
    }
  });

  // Claude's own provider builds the request, which is caught before it is sent: pi-ai hands it to
  // `onPayload` first, and the throw there ends the stream, so no model is called.
  test("a request after a section and a tool change leads with them, and holds no other system text", async () => {
    const { models, model: ref } = claudeAgentModels("a key");
    const model = models.getModel(ref.provider, ref.id);
    if (!model) throw new Error(`pi-ai has no model ${ref.id}`);
    const showStep = {
      name: "show_step",
      description: "Shows a step.",
      parameters: { type: "object", properties: { step: { type: "number" } }, required: ["step"] },
    };
    let sent:
      | { system?: { text: string }[]; tools?: { name: string }[]; messages: { role: string; content: unknown }[] }
      | undefined;
    const stream = models.stream(
      model,
      {
        messages: [
          {
            role: "system",
            content: "You help a family plan.",
            sections: { voice: "<voice>Old rule.</voice>" },
            toolsAdded: [{ ...showStep, name: "get_recipe", description: "One Recipe." }],
            timestamp: 1,
          },
          { role: "user", content: "Hello", timestamp: 2 },
          fauxAssistantMessage("Hello."),
          {
            role: "system",
            content: "",
            sections: { voice: "<voice>New rule.</voice>" },
            toolsAdded: [showStep],
            timestamp: 3,
          },
          { role: "user", content: "Next step", timestamp: 4 },
        ],
      },
      {
        onPayload: (payload) => {
          sent = payload as typeof sent;
          throw new Error("Not sent");
        },
      },
    );
    await stream.result();

    const system = (sent?.system ?? []).map((block) => block.text).join("\n");
    expect(system).toContain("You help a family plan.");
    expect(system).toContain("<voice>New rule.</voice>");
    expect(system).not.toContain("Old rule.");
    expect(sent?.tools?.map((tool) => tool.name)).toEqual(["get_recipe", "show_step"]);
    // The model's effort is set by empty system blocks between messages: none holds any text.
    const later = sent?.messages.filter((message) => message.role === "system") ?? [];
    expect(later.filter((message) => !Array.isArray(message.content) || message.content.length > 0)).toEqual([]);
    expect(JSON.stringify(sent?.messages)).not.toMatch(/rule\.|system prompt|show_step/i);
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
