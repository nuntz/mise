import { type FauxResponseFactory, fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ChatWhere, VoiceStartReply } from "@mise/domain";
import { afterEach, describe, expect, test, vi } from "vitest";
import { useAgentModels } from "../src/agent";
import { openAiLive, useLive } from "../src/live";
import { connectAs } from "./connect";
import { pretendLive } from "./liveService";
import { familyHousehold, lastText, scriptModel } from "./scripted";

const ON_THE_WEEK: ChatWhere = { screen: "week", week: "2026-10-26" };
const OFFER = "v=0 offer";

afterEach(() => useAgentModels(undefined));

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

  test("cuts each turn from what was heard since the last one", async () => {
    const { household, session } = await robinTalking(() => fauxAssistantMessage("Noted."));

    session.serverSends({ type: "session.input_transcript.delta", delta: "We're out of rice." });
    session.serverSends({ type: "session.delegation.created", delegation: { id: "item_1" } });
    await vi.waitFor(() => expect(session.sent).toHaveLength(1));
    session.serverSends({ type: "session.input_transcript.delta", delta: "And cumin." });
    session.serverSends({ type: "session.delegation.created", delegation: { id: "item_2" } });
    await vi.waitFor(() => expect(session.sent).toHaveLength(2));

    const said = (await household.conversation()).filter((turn) => turn.role === "member").map((turn) => turn.text);
    expect(said).toEqual(["We're out of rice.", "And cumin."]);
  });

  test("drops reflected audio: nothing of it reaches the agent or the conversation", async () => {
    const { household, session, prompts } = await robinTalking();

    session.serverSends({ type: "session.input_audio.append", audio: "QUJD".repeat(1000) });
    session.serverSends({ type: "session.input_transcript.delta", delta: "Hi there." });
    session.serverSends({ type: "session.output_audio.delta", delta: "REVG".repeat(1000) });
    session.serverSends({ type: "session.delegation.created", delegation: { id: "item_1" } });

    await vi.waitFor(() => expect(session.sent).toHaveLength(1));
    expect(prompts[0]).toMatch(/\nHi there\.$/);
    const said = (await household.conversation()).filter((turn) => turn.role === "member").map((turn) => turn.text);
    expect(said).toEqual(["Hi there."]);
  });

  test("speaks a failure line, not the agent's error, when the agent can't answer", async () => {
    const { session } = await robinTalking(() =>
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "model_error" }),
    );

    session.serverSends({ type: "session.input_transcript.delta", delta: "Plan Friday." });
    session.serverSends({ type: "session.delegation.created", delegation: { id: "item_1" } });

    await vi.waitFor(() =>
      expect(session.sent).toEqual([
        {
          type: "session.commentary.append",
          delegation_id: "item_1",
          content: "Mise couldn't answer that. Try again in a moment.",
        },
      ]),
    );
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
