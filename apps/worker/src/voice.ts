import { type ChatWhere, VOICE_START_CHARGE_SECONDS } from "@mise/domain";
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
Say Mise's agent's answer naturally and briefly. If it asks the person to tap a button to confirm, tell them to tap it on the screen.

# Voice time
When Mise says today's voice time is almost up, tell the person at once, in a sentence.`;

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

/** Sent for GPT-Live to say, this long before the day's voice minutes run out and the session is closed. */
const WARN_BEFORE_SECONDS = 30;
export const VOICE_TIME_WARNING = "Today's voice time is almost up: Mise will hang up in half a minute.";

/** A session that hears nothing for this long was forgotten, and is closed. */
const SILENCE_MS = 2 * 60 * 1000;

/**
 * Reflected audio, about 120 KB/s of base64 the household never needs: known by its type near the
 * start of the event, and dropped unparsed.
 */
const REFLECTED_AUDIO = /"type"\s*:\s*"session\.(input_audio\.append|output_audio\.delta)"/;
const TYPE_WITHIN = 200;

/** The server events a Voice Session acts on, as OpenAI's reference gives them (October 2026). */
const Usage = z.object({ seconds: z.number().nonnegative() });
const ServerEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session.input_transcript.delta"), delta: z.string() }),
  z.object({ type: z.literal("session.delegation.created"), delegation: z.object({ id: z.string() }) }),
  z.object({ type: z.literal("session.usage.updated"), usage: Usage }),
  z.object({ type: z.literal("session.closed"), reason: z.string().optional(), usage: Usage.optional() }),
]);

/**
 * A session's billed time as the household records it: `seconds` so far, at least the start
 * charge, and `confirmed` once `session.closed` gave the final count.
 */
export type VoiceUsage = { id: string; seconds: number; confirmed: boolean };

/** What a Voice Session asks of the household that holds it. */
export type VoiceHooks = {
  /** Answers a turn heard from `where` through the shared conversation; null when the agent couldn't. */
  answer(text: string, where: ChatWhere): Promise<string | null>;
  /** Records the session's usage, each time it changes: from its creation to its end. */
  usage(usage: VoiceUsage): void;
  /** Called once, when the session has ended. */
  end(session: VoiceSession): void;
};

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
  /** Live's latest cumulative count, never below the start charge billed at creation. */
  private seconds = VOICE_START_CHARGE_SECONDS;
  private warned = false;
  /** The warning, the close when the allowance runs out, and the close after a silence. */
  private warning: ReturnType<typeof setTimeout> | undefined;
  private runOut: ReturnType<typeof setTimeout> | undefined;
  private silence: ReturnType<typeof setTimeout> | undefined;

  private constructor(
    private readonly id: string,
    private readonly sideband: Sideband,
    private where: ChatWhere,
    private readonly hooks: VoiceHooks,
    private readonly allowance: number,
  ) {}

  /**
   * Creates the session from the browser's offer and attaches the sideband, before the browser has
   * its answer, so that nothing said is missed. Resolves with the session and the SDP answer; throws
   * `LiveError` if either step is refused. The start charge is recorded once the session is created,
   * whether or not the sideband attaches. The session closes itself once it has used `allowance`,
   * the seconds of voice the day has left, or has heard nothing for two minutes.
   */
  static async start(
    live: Live,
    offer: string,
    where: ChatWhere,
    hooks: VoiceHooks,
    allowance: number,
  ): Promise<{ session: VoiceSession; sdp: string }> {
    const created = await Sentry.startSpan({ name: "voice create", op: "mise.voice" }, () =>
      live.create(offer, VOICE_SESSION),
    );
    hooks.usage({ id: created.id, seconds: VOICE_START_CHARGE_SECONDS, confirmed: false });
    const sideband = await Sentry.startSpan({ name: "voice attach", op: "mise.voice" }, () => live.attach(created.id));
    const session = new VoiceSession(created.id, sideband, where, hooks, allowance);
    sideband.listen({ message: (data) => session.onMessage(data), close: () => session.finish("sideband_closed") });
    // Billing started at creation, a moment before the sideband attached: the first usage update corrects for it.
    session.armAllowance(0);
    session.hearSomething();
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
        this.hearSomething();
        return;
      case "session.delegation.created": {
        // The delegation carries no utterance: the turn is what was heard since the last one.
        const text = this.heard.trim();
        this.heard = "";
        void this.delegate(event.data.delegation.id, text, this.where);
        return;
      }
      case "session.usage.updated":
        // Each update is the session's total so far: it replaces the last, never adds to it.
        this.count(event.data.usage.seconds, false);
        this.armAllowance(event.data.usage.seconds);
        return;
      case "session.closed":
        if (event.data.usage) this.count(event.data.usage.seconds, true);
        this.finish(event.data.reason ?? "closed");
        return;
    }
  }

  private async delegate(id: string, text: string, where: ChatWhere): Promise<void> {
    let content = NOTHING_HEARD;
    if (text) {
      // A turn that throws is answered like one the agent failed, and reported.
      const reply = await this.hooks.answer(text, where).catch((error: unknown) => {
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
    clearTimeout(this.warning);
    clearTimeout(this.runOut);
    clearTimeout(this.silence);
    Sentry.startSpan({ name: "voice close", op: "mise.voice", attributes: { "mise.voice.reason": reason } }, () =>
      this.sideband.close(),
    );
    this.hooks.end(this);
  }

  /** Times the warning and the close from `used`, the seconds Live has counted so far. */
  private armAllowance(used: number): void {
    if (this.ended) return;
    const left = this.allowance - used;
    clearTimeout(this.warning);
    clearTimeout(this.runOut);
    if (!this.warned) this.warning = setTimeout(() => this.warn(), Math.max(0, left - WARN_BEFORE_SECONDS) * 1000);
    this.runOut = setTimeout(() => this.end(), Math.max(0, left) * 1000);
  }

  private warn(): void {
    if (this.warned || this.ended) return;
    this.warned = true;
    this.sideband.send({ type: "session.commentary.append", delegation_id: null, content: VOICE_TIME_WARNING });
  }

  /** Starts the silence over: the person said something. */
  private hearSomething(): void {
    clearTimeout(this.silence);
    this.silence = setTimeout(() => this.end(), SILENCE_MS);
  }

  private count(seconds: number, confirmed: boolean): void {
    this.seconds = Math.max(VOICE_START_CHARGE_SECONDS, Math.ceil(seconds));
    this.hooks.usage({ id: this.id, seconds: this.seconds, confirmed });
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
