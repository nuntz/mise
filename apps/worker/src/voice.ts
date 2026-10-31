import type { ChatWhere } from "@mise/domain";
import * as Sentry from "@sentry/cloudflare";
import { z } from "zod";
import type { Live, LiveSessionConfig, Sideband } from "./live";

/**
 * GPT-Live-1's instructions: it is only the voice, and Mise's agent answers everything that isn't
 * small talk (ADR 0028). `<|SpawnThinking|>` is how a Live prompt asks it to delegate.
 */
const INSTRUCTIONS = `You are the voice of Mise, a family's meal planner. You only listen and speak. A separate assistant, Mise's agent, knows the household's plan, recipes, groceries and pantry, and makes every change.

# Delegation policy
Generate <|SpawnThinking|> when:
- the person asks anything about their meals, recipes, the week, groceries, the pantry, the household or cooking;
- the person asks for any change, however small;
- the person answers a question Mise's agent asked, even in one word;
- you are unsure whether you know the answer.
Do not generate <|SpawnThinking|> when:
- the person only greets you, thanks you or says goodbye;
- the person only makes a backchannel sound, such as "mm-hmm" or "okay".

Never invent a recipe, an amount, a plan or a result. Never say a change is done until Mise's agent says so.

# Personality during tool calls
Concise: a brief receipt, then quiet until the answer arrives.

# Speaking results
Say Mise's agent's answer naturally and briefly. If it asks the person to tap a button to confirm, tell them to tap it on the screen.`;

/** The session as Mise creates it: client delegation, nothing kept by OpenAI, and a browser that can only hang up. */
export const VOICE_SESSION: LiveSessionConfig = {
  model: "gpt-live-1",
  instructions: INSTRUCTIONS,
  delegation: { type: "client" },
  store: false,
  client: { data_channel: { allowed_client_events: ["session.close"] } },
};

/**
 * Commentary takes at most 500 tokens. English runs about four characters a token; this leaves room
 * for answers dense in numbers and units, which take more.
 */
const MAX_COMMENTARY_CHARS = 1200;

/** Spoken when Mise's agent gives no answer: neither a mishearing nor a claim that nothing changed. */
export const FAILURE_LINE = "Mise couldn't answer that. Try again in a moment.";

/** Spoken when a delegation comes with nothing heard since the last turn. */
const NOTHING_HEARD = "Sorry, I didn't catch that.";

/** How long to wait for `session.closed` after asking for it, before the sideband is closed anyway. */
const CLOSE_FALLBACK_MS = 5000;

/**
 * Reflected audio, about 120 KB/s of base64 the household never needs: known by its type near the
 * start of the event, and dropped unparsed.
 */
const REFLECTED_AUDIO = /"type"\s*:\s*"session\.(input_audio\.append|output_audio\.delta)"/;
const TYPE_WITHIN = 200;

/** The server events a Voice Session acts on, as OpenAI's reference gives them (October 2026). */
const ServerEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session.input_transcript.delta"), delta: z.string() }),
  z.object({ type: z.literal("session.delegation.created"), delegation: z.object({ id: z.string() }) }),
  z.object({ type: z.literal("session.closed"), reason: z.string().optional() }),
]);

/**
 * One Voice Session the household holds the sideband of. Every delegation becomes a turn of what
 * was heard since the last one, from where the person was when it was cut, answered by `answer` (the
 * shared conversation's path) and spoken back as commentary. Only the person's words leave here, as
 * turn text; no audio is kept.
 */
export class VoiceSession {
  /** The input transcript heard since the last turn was cut. */
  private heard = "";
  private ending = false;
  private ended = false;

  private constructor(
    private readonly sideband: Sideband,
    private where: ChatWhere,
    private readonly answer: (text: string, where: ChatWhere) => Promise<string | null>,
    private readonly onEnd: (session: VoiceSession) => void,
  ) {}

  /**
   * Creates the session from the browser's offer and attaches the sideband, before the browser has
   * its answer, so that nothing said is missed. Resolves with the session and the SDP answer; throws
   * `LiveError` if either step is refused.
   */
  static async start(
    live: Live,
    offer: string,
    where: ChatWhere,
    answer: (text: string, where: ChatWhere) => Promise<string | null>,
    onEnd: (session: VoiceSession) => void,
  ): Promise<{ session: VoiceSession; sdp: string }> {
    const created = await Sentry.startSpan({ name: "voice create", op: "mise.voice" }, () =>
      live.create(offer, VOICE_SESSION),
    );
    const sideband = await Sentry.startSpan({ name: "voice attach", op: "mise.voice" }, () => live.attach(created.id));
    const session = new VoiceSession(sideband, where, answer, onEnd);
    sideband.listen({ message: (data) => session.onMessage(data), close: () => session.finish("sideband_closed") });
    return { session, sdp: created.sdp };
  }

  /** Whether the session still runs: not yet closed by Live, by the household or by the sideband dropping. */
  get running(): boolean {
    return !this.ended;
  }

  /** Where the person is now: the screen and Week the next turn cut is sent from. */
  moveTo(where: ChatWhere): void {
    this.where = where;
  }

  /** Asks Live to close the session; the sideband is closed either way once it has, or soon after. */
  end(): void {
    if (this.ending || this.ended) return;
    this.ending = true;
    this.sideband.send({ type: "session.close" });
    setTimeout(() => this.finish("unconfirmed"), CLOSE_FALLBACK_MS);
  }

  private onMessage(data: string): void {
    if (this.ended || REFLECTED_AUDIO.test(data.slice(0, TYPE_WITHIN))) return;
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    const event = ServerEvent.safeParse(json);
    if (!event.success) return;
    switch (event.data.type) {
      case "session.input_transcript.delta":
        this.heard += event.data.delta;
        return;
      case "session.delegation.created": {
        // The delegation carries no utterance: the turn is what was heard since the last one.
        const text = this.heard.trim();
        this.heard = "";
        void this.delegate(event.data.delegation.id, text, this.where);
        return;
      }
      case "session.closed":
        this.finish(event.data.reason ?? "closed");
        return;
    }
  }

  private async delegate(id: string, text: string, where: ChatWhere): Promise<void> {
    let content = NOTHING_HEARD;
    if (text) {
      // A turn that throws is answered like one the agent failed, and reported.
      const reply = await this.answer(text, where).catch((error: unknown) => {
        Sentry.captureException(error);
        return null;
      });
      content = reply ? commentaryOf(reply) : FAILURE_LINE;
    }
    if (!this.ended) this.sideband.send({ type: "session.commentary.append", delegation_id: id, content });
  }

  private finish(reason: string): void {
    if (this.ended) return;
    this.ended = true;
    Sentry.startSpan({ name: "voice close", op: "mise.voice", attributes: { "mise.voice.reason": reason } }, () =>
      this.sideband.close(),
    );
    this.onEnd(this);
  }
}

/** The agent's answer cut to fit commentary, at the end of a sentence where there is one to cut at. */
function commentaryOf(answer: string): string {
  if (answer.length <= MAX_COMMENTARY_CHARS) return answer;
  const cut = answer.slice(0, MAX_COMMENTARY_CHARS);
  const sentenceEnd = Math.max(
    cut.lastIndexOf(". "),
    cut.lastIndexOf("! "),
    cut.lastIndexOf("? "),
    cut.lastIndexOf("\n"),
  );
  return sentenceEnd > 0 ? cut.slice(0, sentenceEnd + 1).trimEnd() : cut;
}
