import { abortAllDurableObjects } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { type FauxResponseFactory, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { JsonObject } from "@earendil-works/pi-durable";
import type { ChatWhere, VoiceStartReply } from "@mise/domain";
import { afterEach, describe, expect, test, vi } from "vitest";
import { useAgentModels } from "../src/agent";
import { KEPT_EXCHANGES } from "../src/agentLog";
import { openAiLive, useLive } from "../src/live";
import { FAILURE_LINE, VOICE_TIME_WARNING, type VoiceExchange, VoiceSession } from "../src/voice";
import { connectAs } from "./connect";
import { type PretendSession, pretendLive } from "./liveService";
import { caller, dinnerOn, familyHousehold, type HouseholdStub, lastText, scriptModel, textOf } from "./scripted";

const ON_THE_WEEK: ChatWhere = { screen: "week", week: "2026-10-26" };
const OFFER = "v=0 offer";

afterEach(() => {
  useAgentModels(undefined);
  vi.useRealTimers();
});

/** Robin, signed in, with a Voice Session started on a pretend Live, and the agent answering with `respond`. */
async function robinTalking(
  respond: FauxResponseFactory = () => fauxAssistantMessage("Thursday's dinner is Rice bowl 2."),
) {
  const prompts: string[] = [];
  scriptModel((context, options, state, model) => {
    prompts.push(lastText(context));
    return respond(context, options, state, model);
  });
  const { live, sessions } = pretendLive();
  useLive(() => live);
  const household = await familyHousehold();
  const robin = await connectAs(household, "robin@example.com");
  const reply = (await robin.rpc("startVoice", [OFFER, ON_THE_WEEK])) as VoiceStartReply;
  const session = sessions[0];
  if (!session) throw new Error("No session was created");
  return { household, robin, reply, session, sessions, prompts };
}

describe("a Voice Session", () => {
  test("is created from the browser's offer with client delegation and nothing stored, and its sideband attached", async () => {
    const { reply, session } = await robinTalking();

    expect(reply).toEqual({ ok: true, value: { sdp: `answer to ${OFFER}` } });
    expect(session.offer).toBe(OFFER);
    expect(session.config).toMatchObject({ model: "gpt-live-1", delegation: { type: "client" }, store: false });
    expect(session.config.client.data_channel.allowed_client_events).toEqual(["session.close"]);
    expect(session.attached).toBe(true);
  });

  test("tells GPT-Live to delegate a “never mind”, which only Mise's agent can act on", async () => {
    const { session } = await robinTalking();

    const delegated = session.config.instructions.split("Do not generate")[0];

    expect(delegated).toMatch(/never mind/);
  });

  test("tells GPT-Live to delegate a “no” to the agent's question, bare or with a thanks, as an answer", async () => {
    const { session } = await robinTalking();

    const [delegated, kept] = session.config.instructions.split("Do not generate");

    expect(delegated).toMatch(/"No"/);
    expect(delegated).toMatch(/"No, thanks"/);
    expect(kept).toMatch(/thanks you or says goodbye, and answers no question/);
  });

  test("tells GPT-Live to say Mise's failure line as it is, never as a request to repeat", async () => {
    const { session } = await robinTalking();

    const speaking = session.config.instructions.split("# Speaking results")[1]?.split("\n# ")[0] ?? "";

    expect(speaking).toContain(FAILURE_LINE);
    expect(speaking).toMatch(/never ask the person to repeat/i);
  });

  test("answers a delegation with one turn of what was heard, as the Caller who started it, spoken back as commentary", async () => {
    const { household, session, prompts } = await robinTalking();

    session.serverSends({ type: "session.input_transcript.delta", delta: "What's for dinner " });
    session.serverSends({ type: "session.input_transcript.delta", delta: "Thursday?" });
    session.serverSends({ type: "session.delegation.created", delegation: { id: "item_1", type: "delegation" } });

    await vi.waitFor(() =>
      expect(session.sent).toEqual([
        { type: "session.commentary.append", delegation_id: "item_1", content: "Thursday's dinner is Rice bowl 2." },
      ]),
    );
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatch(/^\[Robin, .*\]\nWhat's for dinner Thursday\?$/);
    expect(await household.conversation()).toEqual([
      { role: "member", speaker: "Robin", text: "What's for dinner Thursday?" },
      { role: "agent", text: "Thursday's dinner is Rice bowl 2." },
    ]);
  });

  test("presents each turn as spoken, from where the person was when it was cut", async () => {
    const { robin, session, prompts } = await robinTalking(() => fauxAssistantMessage("Noted."));

    session.serverSends({ type: "session.input_transcript.delta", delta: "What's for dinner Tuesday?" });
    session.serverSends({ type: "session.delegation.created", delegation: { id: "item_1" } });
    await vi.waitFor(() => expect(session.sent).toHaveLength(1));
    session.serverSends({ type: "session.input_transcript.delta", delta: "We're out of cumin." });
    await robin.rpc("moveVoice", [{ screen: "pantry" }]);
    session.serverSends({ type: "session.delegation.created", delegation: { id: "item_2" } });
    await vi.waitFor(() => expect(session.sent).toHaveLength(2));

    expect(prompts[0]).toMatch(
      /^\[Robin, speaking on .*, on the Week screen, showing the Week of Monday 2026-10-26; answer for the ear: .*\]\n/,
    );
    expect(prompts[1]).toMatch(
      /^\[Robin, speaking on .*, on the Pantry screen, so day names mean the coming days: .*\]\n/,
    );
  });

  test("is moved only by the connection that started it", async () => {
    const { household, session, prompts } = await robinTalking(() => fauxAssistantMessage("Noted."));
    const alex = await connectAs(household, "alex@example.com");

    const moved = await alex.rpc("moveVoice", [{ screen: "pantry" }]);
    session.serverSends({ type: "session.input_transcript.delta", delta: "Hello." });
    session.serverSends({ type: "session.delegation.created", delegation: { id: "item_1" } });
    await vi.waitFor(() => expect(session.sent).toHaveLength(1));

    expect(moved).toBe(false);
    expect(prompts[0]).toMatch(/on the Week screen/);
  });

  test("refuses a move to nowhere, and keeps where the session was", async () => {
    const { robin, session, prompts } = await robinTalking(() => fauxAssistantMessage("Noted."));

    const moved = await robin.rpc("moveVoice", [{ screen: "attic" }]);
    session.serverSends({ type: "session.input_transcript.delta", delta: "Hello." });
    session.serverSends({ type: "session.delegation.created", delegation: { id: "item_1" } });
    await vi.waitFor(() => expect(session.sent).toHaveLength(1));

    expect(moved).toBe(false);
    expect(prompts[0]).toMatch(/on the Week screen/);
  });

  test("drops reflected audio: nothing of it reaches the agent or the conversation", async () => {
    const { household, session, prompts } = await robinTalking();

    session.serverSends({ type: "session.input_audio.append", audio: "QUJD".repeat(1000) });
    session.serverSends({ type: "session.input_transcript.delta", delta: "Hi there." });
    session.serverSends({ type: "session.output_audio.delta", delta: "REVG".repeat(1000) });
    session.serverSends({ type: "session.delegation.created", delegation: { id: "item_1" } });

    await vi.waitFor(() => expect(session.sent).toHaveLength(1));
    expect(prompts[0]).toMatch(/\nHi there\.$/);
    expect(await saidTurns(household)).toEqual(["Hi there."]);
  });

  test("speaks a failure line, not the agent's error, when the agent can't answer", async () => {
    const { session } = await robinTalking(() =>
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "model_error" }),
    );

    const spoken = await say(session, "Plan Friday.");

    expect(spoken).toBe("Mise couldn't answer that. Try again in a moment.");
    // Neither a mishearing, which the person would answer by repeating into the same failure, nor a
    // claim that nothing changed, which a change made before the failure would belie.
    expect(spoken).not.toMatch(/again\?|repeat|say (it|that)|catch|hear|nothing (changed|happened)|no change/i);
  });

  test("speaks the same failure line when a change was made before the agent failed, and the change stays", async () => {
    const FRIDAY = { date: "2026-10-30", meal: "dinner" };
    const { household, session } = await robinTalking((context) =>
      context.messages.some((message) => message.role === "toolResult")
        ? fauxAssistantMessage([], { stopReason: "error", errorMessage: "model_error" })
        : fauxAssistantMessage(fauxToolCall("set_slot", { ...FRIDAY, kind: "recipe", recipeId: 2 }), {
            stopReason: "toolUse",
          }),
    );

    expect(await say(session, "Plan Rice bowl 2 for Friday.")).toBe(FAILURE_LINE);
    expect(await dinnerOn(household, FRIDAY.date)).toMatchObject({ kind: "recipe", recipe: { id: 2 } });
  });

  test("after a turn it couldn't answer, presents the next one to be answered alone", async () => {
    let requests = 0;
    const { household, session, prompts } = await robinTalking(() =>
      ++requests === 1
        ? fauxAssistantMessage([], { stopReason: "error", errorMessage: "model_error" })
        : fauxAssistantMessage("Friday is Rice bowl 2."),
    );

    session.serverSends({ type: "session.input_transcript.delta", delta: "Plan Friday." });
    session.serverSends({ type: "session.delegation.created", delegation: { id: "item_1" } });
    await vi.waitFor(() => expect(session.sent).toHaveLength(1));
    session.serverSends({ type: "session.input_transcript.delta", delta: "Plan Friday, please." });
    session.serverSends({ type: "session.delegation.created", delegation: { id: "item_2" } });
    await vi.waitFor(() => expect(session.sent).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(session.sent).toEqual([
      { type: "session.commentary.append", delegation_id: "item_1", content: FAILURE_LINE },
      { type: "session.commentary.append", delegation_id: "item_2", content: "Friday is Rice bowl 2." },
    ]);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toMatch(/; Mise couldn't answer the messages before this one: answer only this message\]\n/);
    expect(await household.conversation()).toEqual([
      { role: "member", speaker: "Robin", text: "Plan Friday.", unanswered: true },
      { role: "member", speaker: "Robin", text: "Plan Friday, please." },
      { role: "agent", text: "Friday is Rice bowl 2." },
    ]);
  });

  test("ends when asked: session.close is sent, the sideband closes, and nothing more is answered", async () => {
    const { robin, session, prompts } = await robinTalking();

    await robin.rpc("endVoice", []);

    expect(session.sent).toEqual([{ type: "session.close" }]);
    await vi.waitFor(() => expect(session.closed).toBe(true));
    session.serverSends({ type: "session.input_transcript.delta", delta: "Hello?" });
    session.serverSends({ type: "session.delegation.created", delegation: { id: "item_1" } });
    expect(prompts).toEqual([]);
  });

  test("once ended, can be started again", async () => {
    const { robin, sessions } = await robinTalking();
    await robin.rpc("endVoice", []);
    await vi.waitFor(() => expect(sessions[0]?.closed).toBe(true));

    const again = (await robin.rpc("startVoice", [OFFER, ON_THE_WEEK])) as VoiceStartReply;

    expect(again.ok).toBe(true);
    expect(sessions).toHaveLength(2);
  });

  test("is one per Household: a second start is refused while one runs", async () => {
    const { household, sessions } = await robinTalking();
    const alex = await connectAs(household, "alex@example.com");

    const second = (await alex.rpc("startVoice", [OFFER, ON_THE_WEEK])) as VoiceStartReply;

    expect(second).toMatchObject({ ok: false, error: { code: "in_use" } });
    expect(sessions).toHaveLength(1);
  });

  test("ends once started when it was ended while starting, and the Household can start another", async () => {
    scriptModel(() => fauxAssistantMessage("Hello."));
    const { live, sessions, release } = pretendLive({ hold: true });
    useLive(() => live);
    const household = await familyHousehold();
    const robin = await connectAs(household, "robin@example.com");

    const starting = robin.rpc("startVoice", [OFFER, ON_THE_WEEK]);
    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    await robin.rpc("endVoice", []);
    release();

    expect(await starting).toMatchObject({ ok: false, error: { code: "not_started" } });
    expect(sessions[0]?.sent).toEqual([{ type: "session.close" }]);
    await vi.waitFor(() => expect(sessions[0]?.closed).toBe(true));
    const again = await robin.rpc("startVoice", [OFFER, ON_THE_WEEK]);
    expect(again).toMatchObject({ ok: true });
  });

  test("is refused when OpenAI refuses it, and the Household can start another", async () => {
    useLive(() => pretendLive({ refuse: true }).live);
    const household = await familyHousehold();
    const robin = await connectAs(household, "robin@example.com");

    const refused = await robin.rpc("startVoice", [OFFER, ON_THE_WEEK]);
    useLive(() => pretendLive().live);
    const again = await robin.rpc("startVoice", [OFFER, ON_THE_WEEK]);

    expect(refused).toMatchObject({ ok: false, error: { code: "not_started" } });
    expect(again).toMatchObject({ ok: true });
  });

  test("speaks a long answer cut at a sentence, within commentary's limit", async () => {
    const { session } = await robinTalking(() => fauxAssistantMessage("Dal is on Thursday. ".repeat(100)));

    session.serverSends({ type: "session.input_transcript.delta", delta: "Read me the week." });
    session.serverSends({ type: "session.delegation.created", delegation: { id: "item_1" } });

    await vi.waitFor(() => expect(session.sent).toHaveLength(1));
    const [commentary] = session.sent;
    const content = commentary?.type === "session.commentary.append" ? commentary.content : "";
    expect(content.length).toBeLessThanOrEqual(1200);
    expect(content.length).toBeGreaterThan(1000);
    expect(content.endsWith("Dal is on Thursday.")).toBe(true);
  });

  test("tells the agent to offer a long list it would read aloud, and not a list it would write", async () => {
    const results: string[] = [];
    const listing = caller([["search_recipes", {}]]);
    const { robin, session } = await robinTalking((context, ...rest) => {
      const last = context.messages.at(-1);
      if (last?.role === "toolResult") results.push(textOf(last));
      return listing(context, ...rest);
    });

    await say(session, "What recipes do we have?");
    expect(await robin.rpc("chat", ["What recipes do we have?", ON_THE_WEEK])).toMatchObject({ ok: true });

    expect(results).toHaveLength(2);
    expect(results[0], "spoken: the nine Recipes, then how to say them").toMatch(
      /"Satay".*\]Read aloud, 9 things are too many to take in\./,
    );
    expect(results[1], "typed: the nine Recipes alone").toMatch(/"Satay".*\]$/);
  });

  test("is refused to a request with no Caller, before anything is created", async () => {
    const { live, sessions } = pretendLive();
    useLive(() => live);
    const household = await familyHousehold();

    const reply = await household.startVoice(OFFER, ON_THE_WEEK);

    expect(reply).toMatchObject({ ok: false, error: { code: "not_signed_in" } });
    expect(sessions).toEqual([]);
  });

  test("is refused on a deployment without an OpenAI key", async () => {
    useLive(() => null);
    const household = await familyHousehold();
    const robin = await connectAs(household, "robin@example.com");

    const reply = (await robin.rpc("startVoice", [OFFER, ON_THE_WEEK])) as VoiceStartReply;

    expect(reply).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });

  test("is refused without an offer, or sent from nowhere", async () => {
    const { live, sessions } = pretendLive();
    useLive(() => live);
    const household = await familyHousehold();
    const robin = await connectAs(household, "robin@example.com");

    const noOffer = await robin.rpc("startVoice", [42, ON_THE_WEEK]);
    const nowhere = await robin.rpc("startVoice", [OFFER, { screen: "attic" }]);

    expect(noOffer).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(nowhere).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(sessions).toEqual([]);
  });
});

/**
 * A model that answers each spoken turn by what was said: it makes that turn's `calls` one after the
 * other, then says its `answer`.
 */
function byWhatWasSaid(turns: Record<string, { calls?: [string, JsonObject][]; answer: string }>): FauxResponseFactory {
  return (context) => {
    const fromLast = [...context.messages].reverse().findIndex((message) => message.role === "user");
    const asked =
      textOf(context.messages.at(-fromLast - 1))
        .split("\n")
        .at(-1) ?? "";
    const turn = turns[asked];
    if (!turn) throw new Error(`Nothing scripted for “${asked}”`);
    const made = context.messages.slice(-fromLast - 1).filter((message) => message.role === "toolResult").length;
    const next = turn.calls?.[made];
    if (next) return fauxAssistantMessage(fauxToolCall(...next), { stopReason: "toolUse" });
    return fauxAssistantMessage(turn.answer);
  };
}

/** Says `text` in the session, and waits for its answer's commentary. */
async function say(session: PretendSession, text: string): Promise<string> {
  const before = session.sent.length;
  session.serverSends({ type: "session.input_transcript.delta", delta: text });
  session.serverSends({ type: "session.delegation.created", delegation: { id: `item_${before + 1}` } });
  await vi.waitFor(() => expect(session.sent).toHaveLength(before + 1));
  const commentary = session.sent[before];
  return commentary?.type === "session.commentary.append" ? commentary.content : "";
}

const DELETE_SATAY: [string, JsonObject] = ["delete_recipe", { id: 1, confirm: true }];

async function confirmations(household: HouseholdStub) {
  return (await household.conversation()).filter((message) => message.role === "confirmation");
}

/** What was said in each turn of the conversation, as recorded. */
async function saidTurns(household: HouseholdStub): Promise<string[]> {
  return (await household.conversation()).filter((turn) => turn.role === "member").map((turn) => turn.text);
}

/** What was said in a turn as the agent was given it: its last line, below the header. */
function spokenLine(prompt: string): string | undefined {
  return prompt.split("\n").at(-1);
}

describe("cutting a Voice Session's turns", () => {
  test("cuts each turn from what was heard since the last one", async () => {
    const { household, session } = await robinTalking(() => fauxAssistantMessage("Noted."));

    session.serverSends({ type: "session.input_transcript.delta", delta: "We're out of rice." });
    session.serverSends({ type: "session.delegation.created", delegation: { id: "item_1" } });
    await vi.waitFor(() => expect(session.sent).toHaveLength(1));
    session.serverSends({ type: "session.input_transcript.delta", delta: "And cumin." });
    session.serverSends({ type: "session.delegation.created", delegation: { id: "item_2" } });
    await vi.waitFor(() => expect(session.sent).toHaveLength(2));

    expect(await saidTurns(household)).toEqual(["We're out of rice.", "And cumin."]);
  });

  test("keeps what was said before a backchannel GPT-Live answered itself in the next turn", async () => {
    const { household, session, prompts } = await robinTalking(() => fauxAssistantMessage("Saturday it is."));

    session.serverSends({ type: "session.input_transcript.delta", delta: "No," });
    // GPT-Live heard only a pause, and answered it itself: no delegation.
    session.serverSends({ type: "session.output_transcript.delta", delta: "Mm-hmm." });
    session.serverSends({ type: "session.input_transcript.delta", delta: " Saturday." });
    session.serverSends({ type: "session.delegation.created", delegation: { id: "item_2" } });
    await vi.waitFor(() => expect(session.sent).toHaveLength(1));

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatch(/\]\nNo, Saturday\.$/);
    expect(await saidTurns(household)).toEqual(["No, Saturday."]);
  });

  test("sends a one-word reply as a turn, read against the agent's question, without what GPT-Live said aloud", async () => {
    const contexts: string[][] = [];
    const { household, session, prompts } = await robinTalking((context) => {
      contexts.push(context.messages.map((message) => textOf(message)));
      return fauxAssistantMessage(
        ["Clear next week too?", "Done. The week after as well?"][contexts.length - 1] ?? "Done.",
      );
    });

    await say(session, "Clear this week.");
    session.serverSends({ type: "session.output_transcript.delta", delta: "Want me to clear next week as well?" });
    await say(session, "Yes.");
    session.serverSends({ type: "session.output_transcript.delta", delta: "Done. And the week after?" });
    await say(session, "No. Clear this week.");

    expect(prompts.map(spokenLine)).toEqual(["Clear this week.", "Yes.", "No. Clear this week."]);
    // Each reply follows the question it answers, and nothing GPT-Live paraphrased is in the conversation.
    expect(contexts[1]?.slice(-2)).toEqual(["Clear next week too?", expect.stringMatching(/\nYes\.$/)]);
    expect(contexts[2]?.slice(-2)).toEqual([
      "Done. The week after as well?",
      expect.stringMatching(/\nNo\. Clear this week\.$/),
    ]);
    expect(contexts.flat().join("\n")).not.toMatch(/Want me to/);
    expect(await saidTurns(household)).toEqual(["Clear this week.", "Yes.", "No. Clear this week."]);
  });

  test("queues a delegation that arrives while a turn runs as its own turn, each answered in order", async () => {
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => (releaseFirst = resolve));
    const { household, session, prompts } = await robinTalking(async (context) => {
      const asked = spokenLine(lastText(context));
      // The first turn is still being answered when the second delegation arrives.
      if (asked === "Plan Friday.") await firstHeld;
      return fauxAssistantMessage(`Answered “${asked}”`);
    });

    session.serverSends({ type: "session.input_transcript.delta", delta: "Plan Friday." });
    session.serverSends({ type: "session.delegation.created", delegation: { id: "item_1" } });
    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    session.serverSends({ type: "session.input_transcript.delta", delta: "And Saturday." });
    session.serverSends({ type: "session.delegation.created", delegation: { id: "item_2" } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(session.sent).toEqual([]);
    releaseFirst();
    await vi.waitFor(() => expect(session.sent).toHaveLength(2));

    expect(session.sent).toEqual([
      { type: "session.commentary.append", delegation_id: "item_1", content: "Answered “Plan Friday.”" },
      { type: "session.commentary.append", delegation_id: "item_2", content: "Answered “And Saturday.”" },
    ]);
    expect(prompts.map(spokenLine)).toEqual(["Plan Friday.", "And Saturday."]);
    expect(await saidTurns(household)).toEqual(["Plan Friday.", "And Saturday."]);
  });

  test("still answers a queued turn when the turn ahead of it fails, as the only one to answer", async () => {
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => (releaseFirst = resolve));
    const { household, session, prompts } = await robinTalking(async (context) => {
      if (spokenLine(lastText(context)) !== "Plan Friday.") return fauxAssistantMessage("Saturday is Rice bowl 2.");
      await firstHeld;
      return fauxAssistantMessage([], { stopReason: "error", errorMessage: "model_error" });
    });

    session.serverSends({ type: "session.input_transcript.delta", delta: "Plan Friday." });
    session.serverSends({ type: "session.delegation.created", delegation: { id: "item_1" } });
    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    session.serverSends({ type: "session.input_transcript.delta", delta: "And Saturday." });
    session.serverSends({ type: "session.delegation.created", delegation: { id: "item_2" } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    releaseFirst();
    await vi.waitFor(() => expect(session.sent).toHaveLength(2));

    expect(session.sent).toEqual([
      { type: "session.commentary.append", delegation_id: "item_1", content: FAILURE_LINE },
      { type: "session.commentary.append", delegation_id: "item_2", content: "Saturday is Rice bowl 2." },
    ]);
    expect(prompts[1]).toMatch(/answer only this message\]\nAnd Saturday\.$/);
    expect(await household.conversation()).toEqual([
      { role: "member", speaker: "Robin", text: "Plan Friday.", unanswered: true },
      { role: "member", speaker: "Robin", text: "And Saturday." },
      { role: "agent", text: "Saturday is Rice bowl 2." },
    ]);
  });

  test("takes a correction as its own turn after the first, which the agent can undo", async () => {
    const FRIDAY = { date: "2026-10-30", meal: "dinner" };
    const THURSDAY = { date: "2026-10-29", meal: "dinner" };
    const contexts: string[][] = [];
    const { household, session } = await robinTalking((context, ...rest) => {
      contexts.push(context.messages.map((message) => textOf(message)));
      return byWhatWasSaid({
        "Plan Rice bowl 2 for Friday.": {
          calls: [["set_slot", { ...FRIDAY, kind: "recipe", recipeId: 2 }]],
          answer: "Rice bowl 2 is on Friday.",
        },
        "Thursday, not Friday.": {
          calls: [
            ["set_slot", { ...FRIDAY, kind: "unplanned" }],
            ["set_slot", { ...THURSDAY, kind: "recipe", recipeId: 2 }],
          ],
          answer: "Moved it to Thursday.",
        },
      })(context, ...rest);
    });

    await say(session, "Plan Rice bowl 2 for Friday.");
    const correctionStart = contexts.length;
    expect(await say(session, "Thursday, not Friday.")).toBe("Moved it to Thursday.");

    // The correction's first request has the first turn, answered, before it.
    expect(contexts[correctionStart]?.slice(-2)).toEqual([
      "Rice bowl 2 is on Friday.",
      expect.stringMatching(/\nThursday, not Friday\.$/),
    ]);
    expect(await saidTurns(household)).toEqual(["Plan Rice bowl 2 for Friday.", "Thursday, not Friday."]);
    expect(await dinnerOn(household, "2026-10-30")).toMatchObject({ kind: "unplanned" });
    expect(await dinnerOn(household, "2026-10-29")).toMatchObject({ kind: "recipe", recipe: { id: 2 } });
  });

  test("answers two delegations that arrive together as two turns, in order", async () => {
    const { household, session, prompts } = await robinTalking((context) =>
      fauxAssistantMessage(`Answered “${spokenLine(lastText(context))}”`),
    );

    // Delivered in one tick: the second delegation comes before the first turn has been submitted.
    session.serverSends({ type: "session.input_transcript.delta", delta: "Plan Friday." });
    session.serverSends({ type: "session.delegation.created", delegation: { id: "item_1" } });
    session.serverSends({ type: "session.input_transcript.delta", delta: "And Saturday." });
    session.serverSends({ type: "session.delegation.created", delegation: { id: "item_2" } });
    await vi.waitFor(() => expect(session.sent).toHaveLength(2));

    expect(session.sent).toEqual([
      { type: "session.commentary.append", delegation_id: "item_1", content: "Answered “Plan Friday.”" },
      { type: "session.commentary.append", delegation_id: "item_2", content: "Answered “And Saturday.”" },
    ]);
    expect(prompts.map(spokenLine)).toEqual(["Plan Friday.", "And Saturday."]);
    expect(await saidTurns(household)).toEqual(["Plan Friday.", "And Saturday."]);
  });
});

describe("a held change during a Voice Session (ADR 0024)", () => {
  test("waits for a tap, and the commentary names the button to tap", async () => {
    const { household, session } = await robinTalking(
      byWhatWasSaid({ "Delete the Satay.": { calls: [DELETE_SATAY], answer: "Okay, it's waiting for you." } }),
    );

    const spoken = await say(session, "Delete the Satay.");

    expect(spoken).toBe("Okay, it's waiting for you. Tap Delete “Satay” on the screen.");
    expect(await confirmations(household)).toEqual([
      { role: "confirmation", id: 1, summary: "Delete “Satay”", status: "pending" },
    ]);
    expect(await household.callTool("get_recipe", { id: 1 })).toMatchObject({ ok: true });
    // Only the commentary names it: the conversation keeps the agent's own answer.
    expect((await household.conversation()).at(-1)).toEqual({ role: "agent", text: "Okay, it's waiting for you." });
  });

  test("is named once when the agent's answer already names its button", async () => {
    const { session } = await robinTalking(
      byWhatWasSaid({
        "Delete the Satay.": { calls: [DELETE_SATAY], answer: "Tap delete Satay on the screen to delete it." },
      }),
    );

    expect(await say(session, "Delete the Satay.")).toBe("Tap delete Satay on the screen to delete it.");
  });

  test("is not named again by a later turn that held nothing", async () => {
    const { session } = await robinTalking(
      byWhatWasSaid({
        "Delete the Satay.": { calls: [DELETE_SATAY], answer: "It's waiting for you." },
        "What's for dinner Thursday?": { answer: "Rice bowl 2." },
      }),
    );
    await say(session, "Delete the Satay.");

    expect(await say(session, "What's for dinner Thursday?")).toBe("Rice bowl 2.");
  });

  test("is not run by a spoken “yes”, only by a tap's confirm", async () => {
    const { household, robin, session } = await robinTalking(
      byWhatWasSaid({
        "Delete the Satay.": { calls: [DELETE_SATAY], answer: "It's waiting for you." },
        // The most the agent can do with a “yes” is to ask again.
        "Yes.": { calls: [DELETE_SATAY], answer: "Deleted." },
      }),
    );
    await say(session, "Delete the Satay.");

    await say(session, "Yes.");

    expect(await household.callTool("get_recipe", { id: 1 })).toMatchObject({ ok: true });
    expect((await confirmations(household)).map((shown) => shown.status)).toEqual(["pending", "pending"]);

    expect(await robin.rpc("confirm", [1])).toMatchObject({ ok: true });
    expect(await household.callTool("get_recipe", { id: 1 })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });

  test("keeps a long answer and its buttons within commentary's limit, the buttons first to keep", async () => {
    const { live, sessions } = pretendLive();
    const override = "Plan “Satay” for Friday dinner although Sam is allergic to peanut";
    const answers = [
      { text: "Dal is on Thursday. ".repeat(100), held: [override] },
      { text: "Okay.", held: Array.from({ length: 30 }, (_, index) => `${override} (${index})`) },
    ];
    const { session: voice } = await VoiceSession.start(
      live,
      OFFER,
      ON_THE_WEEK,
      {
        answer: async () => ({ turn: 1, reply: answers.shift() ?? null }),
        exchange: () => {},
        usage: () => {},
        end: () => {},
      },
      600,
    );
    const session = sessions[0];
    if (!session) throw new Error("No session was created");

    const first = await say(session, "Read me the week.");
    const second = await say(session, "Plan Satay every day.");
    voice.end();

    expect(first.length).toBeLessThanOrEqual(1200);
    expect(first).toMatch(
      /^Dal is on Thursday\. .*Dal is on Thursday\. Tap Plan “Satay” for Friday .* peanut on the screen\.$/,
    );
    expect(second.length).toBeLessThanOrEqual(1200);
    expect(second).toMatch(/^Okay\. Tap Plan “Satay”/);
  });
  test("is withdrawn by a spoken “never mind”, and a tap then runs nothing", async () => {
    const { household, robin, session } = await robinTalking(
      byWhatWasSaid({
        "Delete the Satay.": { calls: [DELETE_SATAY], answer: "It's waiting for you." },
        "Never mind.": { calls: [["cancel_confirmation", { id: 1 }]], answer: "Okay, I won't delete it." },
      }),
    );
    await say(session, "Delete the Satay.");

    expect(await say(session, "Never mind.")).toBe("Okay, I won't delete it.");

    expect(await confirmations(household)).toEqual([
      { role: "confirmation", id: 1, summary: "Delete “Satay”", status: "cancelled" },
    ]);
    expect(await robin.rpc("confirm", [1])).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await household.callTool("get_recipe", { id: 1 })).toMatchObject({ ok: true });
  });
});

describe("a Voice Session in Kitchen mode", () => {
  const MONDAY = "2026-11-02";
  const WEDNESDAY = "2026-11-04";
  const dinner = (date: string) => ({ date, meal: "dinner" as const });

  /** Garlic chicken (Recipe 10, for 4) planned for Monday's dinner, with Wednesday's dinner its Leftovers. */
  async function cookingGarlicChicken(household: HouseholdStub) {
    expect(
      await household.callTool("create_recipe", {
        title: "Garlic chicken",
        baseServings: 4,
        ingredients: ["2 cloves garlic", "400 g rice"],
        steps: ["Mince the garlic.", "Brown the chicken.", "Add the garlic and cook a minute."],
        effortMinutes: 30,
      }),
    ).toMatchObject({ ok: true, value: { id: 10 } });
    expect(await household.callTool("set_slot", { ...dinner(MONDAY), kind: "recipe", recipeId: 10 })).toMatchObject({
      ok: true,
    });
    expect(await household.callTool("link_leftovers", { ...dinner(WEDNESDAY), of: dinner(MONDAY) })).toMatchObject({
      ok: true,
      value: { kind: "leftovers", servings: 3 },
    });
  }

  /** Robin talking from Kitchen mode at `where`, with Alex connected on another device. */
  async function robinCooking(where: ChatWhere, respond: FauxResponseFactory) {
    const prompts: string[] = [];
    scriptModel((context, options, state, model) => {
      // One prompt per turn, however many requests answering it takes.
      const turn = textOf(context.messages.filter((message) => message.role === "user").at(-1));
      if (prompts.at(-1) !== turn) prompts.push(turn);
      return respond(context, options, state, model);
    });
    const { live, sessions } = pretendLive();
    useLive(() => live);
    const household = await familyHousehold();
    await cookingGarlicChicken(household);
    const robin = await connectAs(household, "robin@example.com");
    const alex = await connectAs(household, "alex@example.com");
    expect(await robin.rpc("startVoice", [OFFER, where])).toMatchObject({ ok: true });
    const session = sessions[0];
    if (!session) throw new Error("No session was created");
    return { household, robin, alex, session, prompts };
  }

  const AT_MONDAY_STEP_1: ChatWhere = { screen: "kitchen", recipe: 10, slot: dinner(MONDAY), step: 1 };

  test("on “next step”, shows the step read aloud on the device talking, and on no other", async () => {
    const { robin, alex, session, prompts } = await robinCooking(
      AT_MONDAY_STEP_1,
      byWhatWasSaid({
        "Next step.": { calls: [["show_step", { step: 2 }]], answer: "Brown the chicken." },
        "And then?": { answer: "Add the garlic." },
      }),
    );

    expect(await say(session, "Next step.")).toBe("Brown the chicken.");
    await vi.waitFor(() => expect(robin.steps).toEqual([2]));
    await say(session, "And then?");

    expect(alex.steps).toEqual([]);
    expect(prompts[0]).toMatch(/cooking Garlic chicken for the dinner of Monday 2026-11-02, .*showing step 1 of 3/);
    // The next turn is heard from the step shown, before the screen says it moved.
    expect(prompts[1]).toMatch(/showing step 2 of 3/);
  });

  test("answers “how much” from the Ingredients scaled to the Slot, its Leftovers included", async () => {
    const { session, prompts } = await robinCooking(
      AT_MONDAY_STEP_1,
      byWhatWasSaid({ "How much garlic?": { answer: "Three cloves." } }),
    );

    await say(session, "How much garlic?");

    expect(prompts[0]).toMatch(
      /\n\[Garlic chicken's Ingredients for 6 servings, as Kitchen mode shows them: 3 cloves garlic; 600 g rice\]\n/,
    );
  });

  test("answers “how much” at the Recipe's own servings when cooked from its page", async () => {
    const { session, prompts } = await robinCooking(
      { screen: "kitchen", recipe: 10, step: 1 },
      byWhatWasSaid({ "How much garlic?": { answer: "Two cloves." } }),
    );

    await say(session, "How much garlic?");

    expect(prompts[0]).toMatch(/cooking Garlic chicken as written, for 4 servings/);
    expect(prompts[0]).toMatch(/Ingredients for 4 servings, as Kitchen mode shows them: 2 cloves garlic; 400 g rice\]/);
  });

  test("shows no step for a typed turn from another device while the cook talks", async () => {
    const { robin, alex } = await robinCooking(
      AT_MONDAY_STEP_1,
      byWhatWasSaid({ "Show step 3.": { calls: [["show_step", { step: 3 }]], answer: "Refused." } }),
    );

    expect(await alex.rpc("chat", ["Show step 3.", { screen: "week" }])).toMatchObject({ ok: true });

    expect(robin.steps).toEqual([]);
  });

  test("shows no step outside Kitchen mode", async () => {
    const { robin, session } = await robinCooking(
      { screen: "pantry" },
      byWhatWasSaid({ "Next step.": { calls: [["show_step", { step: 2 }]], answer: "Refused." } }),
    );

    await say(session, "Next step.");

    expect(robin.steps).toEqual([]);
  });
});

describe("the voice Check-in", () => {
  /** Robin talking from the Pantry screen, with cumin and paprika due and `respond` answering. */
  async function robinInThePantry(respond: FauxResponseFactory) {
    const prompts: string[] = [];
    scriptModel((context, options, state, model) => {
      const turn = textOf(context.messages.filter((message) => message.role === "user").at(-1));
      if (prompts.at(-1) !== turn) prompts.push(turn);
      return respond(context, options, state, model);
    });
    const { live, sessions } = pretendLive();
    useLive(() => live);
    const household = await familyHousehold();
    for (const item of ["paprika", "cumin"]) {
      expect(await household.callTool("upsert_staple", { item })).toMatchObject({ ok: true });
    }
    const robin = await connectAs(household, "robin@example.com");
    expect(await robin.rpc("startVoice", [OFFER, { screen: "pantry" }])).toMatchObject({ ok: true });
    const session = sessions[0];
    if (!session) throw new Error("No session was created");
    return { household, robin, session, prompts };
  }

  test("is led through the Staples due in card order, each answer recorded, and the Pantry told", async () => {
    const { household, robin, session, prompts } = await robinInThePantry(
      byWhatWasSaid({
        "Let's check the pantry.": { answer: "Cumin?" },
        "Out.": { calls: [["record_staple_status", { item: "cumin", status: "out" }]], answer: "Paprika?" },
        "Low.": { calls: [["record_staple_status", { item: "paprika", status: "low" }]], answer: "All done." },
      }),
    );

    await say(session, "Let's check the pantry.");
    const before = robin.notices.filter((notice) => notice.topic === "grocery").length;
    expect(await say(session, "Out.")).toBe("Paprika?");
    expect(await say(session, "Low.")).toBe("All done.");

    expect(prompts[0]).toContain("lead the pantry Check-in");
    expect(prompts[0]).toContain(
      "[Staples due for the Check-in, in card order: cumin (Item cumin, stocked when last checked); " +
        "paprika (Item paprika, stocked when last checked)]",
    );
    // Each turn is given the Staples due as it is said: cumin, answered, is no longer asked about.
    expect(prompts[2]).toContain("in card order: paprika (Item paprika, stocked when last checked)]");
    expect(await household.callTool("list_staples", {})).toMatchObject({
      ok: true,
      value: [
        { item: "cumin", status: "out" },
        { item: "paprika", status: "low" },
      ],
    });
    expect(robin.notices.filter((notice) => notice.topic === "grocery").length).toBeGreaterThan(before);
  });
});

/** Robin, signed in, in a Household with `minutes` of voice a day, on a pretend Live. */
async function robinWithCap(minutes: number) {
  scriptModel(() => fauxAssistantMessage("Noted."));
  const { live, sessions } = pretendLive();
  useLive(() => live);
  const household = await familyHousehold();
  await household.callTool("update_household_settings", { voiceMinutesPerDay: minutes });
  const robin = await connectAs(household, "robin@example.com");
  const start = () => robin.rpc("startVoice", [OFFER, ON_THE_WEEK]) as Promise<VoiceStartReply>;
  /** Starts a session, lets `use` run it, and waits until its sideband is closed. */
  const talk = async (use: (session: PretendSession) => void) => {
    expect(await start()).toMatchObject({ ok: true });
    const session = sessions.at(-1);
    if (!session) throw new Error("No session was created");
    use(session);
    await vi.waitFor(() => expect(session.closed).toBe(true));
  };
  return { household, robin, start, talk, sessions };
}

describe("the daily voice cap", () => {
  test("counts each session's final usage, and refuses a start once the day's minutes are spent", async () => {
    const { start, talk } = await robinWithCap(1);

    await talk((session) => session.serverSends({ type: "session.closed", usage: { seconds: 50 } }));

    expect(await start()).toMatchObject({ ok: false, error: { code: "spent" } });
  });

  test("takes each usage update as the session's running total, never summing them", async () => {
    const { start, talk } = await robinWithCap(1);

    await talk((session) => {
      session.serverSends({ type: "session.usage.updated", usage: { seconds: 15 } });
      session.serverSends({ type: "session.usage.updated", usage: { seconds: 30 } });
      session.drop();
    });

    // 30 seconds used, not 45: the next session still has its start charge's worth.
    expect(await start()).toMatchObject({ ok: true });
  });

  test("keeps the latest usage of a session whose sideband dropped", async () => {
    const { start, talk } = await robinWithCap(1);

    await talk((session) => {
      session.serverSends({ type: "session.usage.updated", usage: { seconds: 50 } });
      session.drop();
    });

    expect(await start()).toMatchObject({ ok: false, error: { code: "spent" } });
  });

  test("counts the 15-second start charge of every session created, however soon it ends", async () => {
    const { start, talk } = await robinWithCap(1);

    for (let i = 0; i < 4; i++) await talk((session) => session.drop());

    expect(await start()).toMatchObject({ ok: false, error: { code: "spent" } });
  });

  test("puts each session's usage and the cap in the export", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-28T20:00:00-07:00"));
    const { household, talk, sessions } = await robinWithCap(20);
    await talk((session) => session.serverSends({ type: "session.closed", usage: { seconds: 42.4 } }));

    const response = await household.fetch("http://mise.example.com/agents/household/household/export");
    const { tables } = (await response.json()) as { tables: Record<string, Record<string, unknown>[]> };

    expect(tables.voice_session).toEqual([
      { id: sessions[0]?.id, day: "2026-10-28", seconds: 43, confirmed: 1, running: 0 },
    ]);
    expect(tables.household?.[0]).toMatchObject({ voice_minutes_per_day: 20 });
  });

  test("is refused with when the minutes come back: the Household's next local midnight", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-28T20:00:00-07:00"));
    const { start, talk } = await robinWithCap(1);
    await talk((session) => session.serverSends({ type: "session.closed", usage: { seconds: 60 } }));

    expect(await start()).toEqual({
      ok: false,
      error: { code: "spent", message: expect.any(String), until: "2026-10-29T07:00:00.000Z" },
    });
  });

  test("is refused as off when the cap is 0, since no midnight brings minutes back", async () => {
    const { start, sessions } = await robinWithCap(0);

    expect(await start()).toMatchObject({ ok: false, error: { code: "off" } });
    expect(sessions).toEqual([]);
  });

  test("gives the day's minutes back at the Household's local midnight", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-28T23:50:00-07:00"));
    const { start, talk } = await robinWithCap(1);
    await talk((session) => session.serverSends({ type: "session.closed", usage: { seconds: 60 } }));
    expect(await start()).toMatchObject({ ok: false, error: { code: "spent" } });

    vi.setSystemTime(new Date("2026-10-29T00:05:00-07:00"));

    expect(await start()).toMatchObject({ ok: true });
  });
});

/**
 * Tears the household down at once, as a restart or deploy does, its Voice Session's sideband lost
 * with it; resolves with a stub to the household that starts up next.
 */
async function restart(household: HouseholdStub, session: PretendSession | undefined): Promise<HouseholdStub> {
  session?.lose();
  await abortAllDurableObjects();
  return env.Household.get(household.id);
}

/** The Voice Sessions' usage as the Household's export gives it. */
async function exportedVoiceSessions(household: HouseholdStub) {
  const response = await household.fetch("http://mise.example.com/agents/household/household/export");
  const { tables } = (await response.json()) as { tables: Record<string, Record<string, unknown>[]> };
  return tables.voice_session;
}

describe("a Voice Session the household lost to a restart or deploy", () => {
  test("keeps the last usage seen, marked unconfirmed, so the cap still counts it", async () => {
    const { household, start, sessions } = await robinWithCap(30);
    expect(await start()).toMatchObject({ ok: true });
    sessions[0]?.serverSends({ type: "session.usage.updated", usage: { seconds: 50 } });
    await vi.waitFor(async () => expect(await exportedVoiceSessions(household)).toMatchObject([{ seconds: 50 }]));

    const restarted = await restart(household, sessions[0]);

    expect(await exportedVoiceSessions(restarted)).toEqual([
      { id: "live_1", day: expect.any(String), seconds: 50, confirmed: 0, running: 0 },
    ]);
  });

  test("is over for the screens that reconnect, and a new session may start", async () => {
    const { household, session } = await robinTalking();

    const robin = await connectAs(await restart(household, session), "robin@example.com");

    expect(await robin.rpc("voiceAvailability", [])).toEqual({ status: "available" });
    expect(await robin.rpc("startVoice", [OFFER, ON_THE_WEEK])).toMatchObject({ ok: true });
  });
});

describe("voice availability", () => {
  test("says voice is unavailable on a deployment without an OpenAI key", async () => {
    useLive(() => null);
    const household = await familyHousehold();
    const robin = await connectAs(household, "robin@example.com");

    expect(await robin.rpc("voiceAvailability", [])).toEqual({ status: "unavailable" });
  });

  test("says who is talking to Mise while a session runs, and is available again once it ends", async () => {
    const { household, robin } = await robinTalking();
    const alex = await connectAs(household, "alex@example.com");

    expect(await alex.rpc("voiceAvailability", [])).toEqual({ status: "in_use", by: "Robin", yours: false });
    expect(await robin.rpc("voiceAvailability", [])).toEqual({ status: "in_use", by: "Robin", yours: true });

    await robin.rpc("endVoice", []);
    await vi.waitFor(async () => expect(await alex.rpc("voiceAvailability", [])).toEqual({ status: "available" }));
  });

  test("refuses a second start with who is talking to Mise", async () => {
    const { household } = await robinTalking();
    const alex = await connectAs(household, "alex@example.com");

    const second = (await alex.rpc("startVoice", [OFFER, ON_THE_WEEK])) as VoiceStartReply;

    expect(second).toMatchObject({ ok: false, error: { code: "in_use", by: "Robin" } });
  });

  test("tells every device when a session starts and when it ends", async () => {
    const { household, robin } = await robinTalking();
    const alex = await connectAs(household, "alex@example.com");
    // Alex connected after the start: Robin's device saw it.
    await vi.waitFor(() => expect(robin.notices.map((notice) => notice.topic)).toContain("voice"));

    await robin.rpc("endVoice", []);

    await vi.waitFor(() => expect(alex.notices.map((notice) => notice.topic)).toContain("voice"));
  });

  test("says voice is off when the cap is 0", async () => {
    const { robin } = await robinWithCap(0);

    expect(await robin.rpc("voiceAvailability", [])).toEqual({ status: "off" });
  });

  test("says when the day's spent minutes come back", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-28T20:00:00-07:00"));
    const { robin, talk } = await robinWithCap(1);
    expect(await robin.rpc("voiceAvailability", [])).toEqual({ status: "available" });

    await talk((session) => session.serverSends({ type: "session.closed", usage: { seconds: 60 } }));

    expect(await robin.rpc("voiceAvailability", [])).toEqual({ status: "spent", until: "2026-10-29T07:00:00.000Z" });
  });

  test("answers a typed chat turn while a session runs", async () => {
    const { household } = await robinTalking();
    const alex = await connectAs(household, "alex@example.com");

    const reply = await alex.rpc("chat", ["What's for dinner Thursday?", ON_THE_WEEK]);

    expect(reply).toEqual({ ok: true, value: { role: "agent", text: "Thursday's dinner is Rice bowl 2." } });
  });
});

/** A Voice Session started straight on a pretend Live, with `allowance` seconds of the day left, on fake timers. */
async function sessionWithAllowance(allowance: number) {
  vi.useFakeTimers();
  const { live, sessions } = pretendLive();
  const ended: string[] = [];
  await VoiceSession.start(
    live,
    OFFER,
    ON_THE_WEEK,
    {
      answer: async () => ({ turn: 1, reply: { text: "Noted.", held: [] } }),
      exchange: () => {},
      usage: () => {},
      end: () => ended.push("ended"),
    },
    allowance,
  );
  const session = sessions[0];
  if (!session) throw new Error("No session was created");
  return { session, ended };
}

/** Long enough for the pretend sideband to deliver what was sent. */
const DELIVERED = 10;

const WARNING = { type: "session.commentary.append", delegation_id: null, content: VOICE_TIME_WARNING };

describe("a Voice Session's allowance", () => {
  test("warns half a minute before the day's minutes run out, then closes when they have", async () => {
    const { session } = await sessionWithAllowance(120);

    vi.advanceTimersByTime(89_000);
    expect(session.sent).toEqual([]);
    vi.advanceTimersByTime(1_000);
    expect(session.sent).toEqual([WARNING]);
    vi.advanceTimersByTime(29_000);
    expect(session.sent).toEqual([WARNING]);
    vi.advanceTimersByTime(1_000);
    expect(session.sent).toEqual([WARNING, { type: "session.close" }]);
  });

  test("follows Live's count of the time used, as each usage update gives it", async () => {
    const { session } = await sessionWithAllowance(120);

    vi.advanceTimersByTime(15_000);
    session.serverSends({ type: "session.usage.updated", usage: { seconds: 60 } });
    vi.advanceTimersByTime(DELIVERED);
    vi.advanceTimersByTime(30_000);

    expect(session.sent).toEqual([WARNING]);
    vi.advanceTimersByTime(30_000);
    expect(session.sent).toEqual([WARNING, { type: "session.close" }]);
  });

  test("warns at once when it starts with less than half a minute left", async () => {
    const { session } = await sessionWithAllowance(20);

    vi.advanceTimersByTime(10);
    expect(session.sent).toEqual([WARNING]);
    vi.advanceTimersByTime(20_000);
    expect(session.sent).toEqual([WARNING, { type: "session.close" }]);
  });

  test("closes after two minutes with nothing heard, counted from the last thing heard", async () => {
    const { session } = await sessionWithAllowance(1800);

    vi.advanceTimersByTime(90_000);
    session.serverSends({ type: "session.input_transcript.delta", delta: "Hmm." });
    vi.advanceTimersByTime(DELIVERED);
    vi.advanceTimersByTime(119_000);
    expect(session.sent).toEqual([]);
    vi.advanceTimersByTime(1_000);

    expect(session.sent).toEqual([{ type: "session.close" }]);
  });

  test("stops counting once it has ended", async () => {
    const { session, ended } = await sessionWithAllowance(120);

    session.serverSends({ type: "session.closed", reason: "remote_hangup" });
    vi.advanceTimersByTime(10);
    expect(ended).toEqual(["ended"]);
    vi.advanceTimersByTime(600_000);

    expect(session.sent).toEqual([]);
  });
});

describe("OpenAI's Live", () => {
  test("creates a session by posting the offer and the session config with the key", async () => {
    const requests: Request[] = [];
    const live = openAiLive("sk-test", async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({ session: { id: "live_1" }, transport: { type: "webrtc", sdp: "answer" } });
    });

    const created = await live.create(OFFER, {
      model: "gpt-live-1",
      instructions: "Delegate.",
      delegation: { type: "client" },
      store: false,
      client: { data_channel: { allowed_client_events: ["session.close"] } },
    });

    expect(created).toEqual({ id: "live_1", sdp: "answer" });
    const [request] = requests;
    expect(request?.url).toBe("https://api.openai.com/v1/live/sessions");
    expect(request?.headers.get("Authorization")).toBe("Bearer sk-test");
    expect(await request?.json()).toEqual({
      session: {
        model: "gpt-live-1",
        instructions: "Delegate.",
        delegation: { type: "client" },
        store: false,
        client: { data_channel: { allowed_client_events: ["session.close"] } },
      },
      transport: { type: "webrtc", sdp: OFFER },
    });
  });

  test("refuses a session OpenAI refused", async () => {
    const live = openAiLive("sk-test", async () =>
      Response.json({ error: { message: "Invalid key" } }, { status: 401 }),
    );

    await expect(live.create(OFFER, {} as never)).rejects.toThrow("OpenAI refused the session (401)");
  });

  test("attaches the sideband with the key, and passes its events on as text", async () => {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    server.accept();
    const fromHousehold: string[] = [];
    server.addEventListener("message", (event) => fromHousehold.push(String(event.data)));
    let attachedWith: Request | undefined;
    const live = openAiLive("sk-test", async (input, init) => {
      attachedWith = new Request(input, init);
      return new Response(null, { status: 101, webSocket: client });
    });

    const sideband = await live.attach("live_1");
    const heard: string[] = [];
    let closed = false;
    sideband.listen({ message: (data) => heard.push(data), close: () => (closed = true) });
    server.send('{"type":"session.input_transcript.delta","delta":"Hi"}');
    sideband.send({ type: "session.close" });
    await vi.waitFor(() => expect(heard).toHaveLength(1));
    await vi.waitFor(() => expect(fromHousehold).toHaveLength(1));
    server.close(1000, "done");

    expect(attachedWith?.url).toBe("https://api.openai.com/v1/live/sessions/live_1/attach");
    expect(attachedWith?.headers.get("Authorization")).toBe("Bearer sk-test");
    expect(heard).toEqual(['{"type":"session.input_transcript.delta","delta":"Hi"}']);
    expect(fromHousehold).toEqual(['{"type":"session.close"}']);
    await vi.waitFor(() => expect(closed).toBe(true));
  });
});

afterEach(() => useLive(undefined));

/** The Voice Sessions' exchanges as the agent log gives them, oldest first. */
async function exchanges(household: HouseholdStub) {
  return (await household.agentLog(10)).voice_exchange;
}

describe("what GPT-Live heard and said", () => {
  test("is recorded for an exchange it answered itself, as heard, said and not handed on", async () => {
    const { household, session } = await robinTalking();

    session.serverSends({ type: "session.input_transcript.delta", delta: "Thanks " });
    session.serverSends({ type: "session.input_transcript.delta", delta: "so much." });
    session.serverSends({ type: "session.output_transcript.delta", delta: "You're " });
    session.serverSends({ type: "session.output_transcript.delta", delta: "welcome!" });
    session.serverSends({ type: "session.input_transcript.delta", delta: "Bye." });

    await vi.waitFor(async () =>
      expect(await exchanges(household)).toEqual([
        {
          id: expect.any(Number),
          session_id: session.id,
          at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
          heard: "Thanks so much.",
          said: "You're welcome!",
          delegated: 0,
          turn: null,
        },
      ]),
    );
  });

  test("is recorded for an exchange handed on, as the turn it became and what GPT-Live said, not what was heard", async () => {
    const { household, robin, session } = await robinTalking();

    expect(await say(session, "What's for dinner Thursday?")).toBe("Thursday's dinner is Rice bowl 2.");
    session.serverSends({ type: "session.input_transcript.delta", delta: "Thanks." });
    session.serverSends({ type: "session.output_transcript.delta", delta: "You're welcome." });
    await robin.rpc("endVoice", []);

    await vi.waitFor(async () => expect(await exchanges(household)).toHaveLength(2));
    const turn = (await household.agentLog(10)).pi_entries
      .map((entry) => JSON.parse(entry.record) as { kind: string; data?: { turn: number } })
      .find((entry) => entry.kind === "mise.turn")?.data?.turn;
    expect(turn).toEqual(expect.any(Number));
    expect(await exchanges(household)).toMatchObject([
      {
        heard: null,
        // Transcript deltas mark no end of an utterance, so the two may run together.
        said: expect.stringMatching(/^Let me check\.\s*Thursday's dinner is Rice bowl 2\.$/),
        delegated: 1,
        turn,
      },
      { heard: "Thanks.", said: "You're welcome.", delegated: 0, turn: null },
    ]);
  });

  test("keeps what GPT-Live says of a turn with the turn, though more is heard before it answers", async () => {
    const { household, robin, session } = await robinTalking();

    session.serverSends({ type: "session.input_transcript.delta", delta: "What's for dinner" });
    session.serverSends({ type: "session.delegation.created", delegation: { id: "item_1" } });
    // The transcript's tail comes after the delegation, and the person goes on as GPT-Live acknowledges.
    session.serverSends({ type: "session.input_transcript.delta", delta: " Thursday?" });
    await vi.waitFor(() => expect(session.sent).toHaveLength(1));
    session.serverSends({ type: "session.input_transcript.delta", delta: " Thanks." });
    session.serverSends({ type: "session.output_transcript.delta", delta: "You're welcome." });
    await robin.rpc("endVoice", []);

    await vi.waitFor(async () => expect(await exchanges(household)).toHaveLength(2));
    expect(await exchanges(household)).toMatchObject([
      { delegated: 1, turn: expect.any(Number), said: expect.stringMatching(/Thursday's dinner is Rice bowl 2\.$/) },
      { heard: "Thanks.", said: "You're welcome.", delegated: 0 },
    ]);
  });

  test("keeps what was heard of a turn that failed to be recorded", async () => {
    const { live, sessions } = pretendLive();
    const recorded: VoiceExchange[] = [];
    await VoiceSession.start(
      live,
      OFFER,
      ON_THE_WEEK,
      {
        answer: async () => {
          throw new Error("The household is gone");
        },
        exchange: (exchange) => recorded.push(exchange),
        usage: () => {},
        end: () => {},
      },
      600,
    );
    const session = sessions[0];
    if (!session) throw new Error("No session was created");

    expect(await say(session, "Plan Friday.")).toBe(FAILURE_LINE);
    session.serverSends({ type: "session.input_transcript.delta", delta: "Hello?" });

    await vi.waitFor(() => expect(recorded).toHaveLength(1));
    expect(recorded[0]).toMatchObject({ heard: "Plan Friday.", delegated: true, turn: null });
  });

  test("keeps only the latest exchanges, and stays out of the export", async () => {
    const { household, robin, session } = await robinTalking();

    for (let index = 1; index <= KEPT_EXCHANGES + 1; index++) {
      session.serverSends({ type: "session.input_transcript.delta", delta: `Hello ${index}.` });
      session.serverSends({ type: "session.output_transcript.delta", delta: "Hi!" });
    }
    await robin.rpc("endVoice", []);

    await vi.waitFor(() => expect(session.closed).toBe(true));
    const kept = await exchanges(household);
    expect(kept).toHaveLength(KEPT_EXCHANGES);
    expect(kept[0]).toMatchObject({ heard: "Hello 2." });
    expect(kept.at(-1)).toMatchObject({ heard: `Hello ${KEPT_EXCHANGES + 1}.` });
    const response = await household.fetch("http://mise.example.com/agents/household/household/export");
    const { tables } = (await response.json()) as { tables: Record<string, unknown> };
    expect(tables.voice_session).toHaveLength(1);
    expect(tables).not.toHaveProperty("voice_exchange");
  });
});

describe("the agent log", () => {
  test("gives the latest turns asked for, with the exchanges since the first of them", async () => {
    const { household, robin, session } = await robinTalking(() => fauxAssistantMessage("Noted."));

    session.serverSends({ type: "session.input_transcript.delta", delta: "Hello." });
    session.serverSends({ type: "session.output_transcript.delta", delta: "Hi!" });
    await say(session, "We're out of rice.");
    await say(session, "And cumin.");
    session.serverSends({ type: "session.input_transcript.delta", delta: "Thanks." });
    session.serverSends({ type: "session.output_transcript.delta", delta: "Anytime." });
    await robin.rpc("endVoice", []);
    await vi.waitFor(async () => expect((await household.agentLog(10)).voice_exchange).toHaveLength(4));

    const log = await household.agentLog(1);

    const turns = log.pi_entries
      .map((entry) => JSON.parse(entry.record) as { kind: string; data?: { text: string } })
      .filter((entry) => entry.kind === "mise.turn");
    expect(turns.map((turn) => turn.data?.text)).toEqual(["And cumin."]);
    expect(log.voice_exchange).toMatchObject([
      { delegated: 1, said: expect.stringContaining("Noted.") },
      { heard: "Thanks.", said: "Anytime." },
    ]);
    expect(log.voice_session).toMatchObject([{ id: session.id }]);
  });
});
