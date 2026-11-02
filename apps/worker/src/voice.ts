import { type ChatWhere, VOICE_START_CHARGE_SECONDS } from "@mise/domain";
import * as Sentry from "@sentry/cloudflare";
import { z } from "zod";
import type { Live, LiveSessionConfig, Sideband } from "./live";

/** Spoken when Mise's agent gives no answer: neither a mishearing nor a claim that nothing changed. */
export const FAILURE_LINE = "Mise couldn't answer that. Try again in a moment.";

/**
 * GPT-Live-1's instructions: it is only the voice, and Mise's agent answers everything that isn't
 * small talk (ADR 0028). `<|SpawnThinking|>` is how a Live prompt asks it to delegate.
 */
const INSTRUCTIONS = `You are the voice of Mise, a family's meal planner. You only listen and speak. A separate assistant, Mise's agent, knows the household's plan, recipes, groceries and pantry, and makes every change.

# Delegation policy
Generate <|SpawnThinking|> when:
- the person asks anything about their meals, recipes, the week, groceries, the pantry, the household or cooking;
- the person asks for any change, however small;
- the person answers a question Mise's agent asked, even in one word, and even when the answer declines, such as "No", "Nope" or "No, thanks": a "no" is an answer, not small talk. A question you spoke from Mise's agent's answer is its question, an offer such as "Want the rest?" too. Mise's agent is waiting for the answer even when nothing will change, so never answer it yourself;
- the person takes back or cancels something they asked for, such as "never mind", "cancel that" or "don't": only Mise's agent can withdraw it, and until it does, the button stays on the screen;
- the person follows up on what you just spoke for Mise's agent, such as "Are you done?", "What about the others?", "You didn't say…" or "What did you mean?": these belong to Mise's agent, even when they sound like talk about the conversation, so never answer them yourself;
- you are unsure whether you know the answer.
Do not generate <|SpawnThinking|> when:
- the person only greets you, thanks you or says goodbye, and answers no question Mise's agent asked;
- the person only makes a backchannel sound, such as "mm-hmm" or "okay".

Never invent a recipe, an amount, a plan or a result. Never say a change is done until Mise's agent says so.

# Personality during tool calls
Concise: a brief receipt, then quiet until the answer arrives.

# Speaking results
Say Mise's agent's answer as it gives it, naturally and briefly. You may shorten it, but a question stays a question and an offer stays an offer: never turn a question or an offer into a statement, or into an announcement of what you will do. If it asks the person to tap a button to confirm, tell them to tap it on the screen.
When Mise says "${FAILURE_LINE}", say exactly that. The person was heard, and something may have changed before Mise failed: never ask the person to repeat themselves, and never say that nothing changed.

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
  z.object({ type: z.literal("session.output_transcript.delta"), delta: z.string() }),
  z.object({ type: z.literal("session.delegation.created"), delegation: z.object({ id: z.string() }) }),
  z.object({ type: z.literal("session.usage.updated"), usage: Usage }),
  z.object({ type: z.literal("session.closed"), reason: z.string().optional(), usage: Usage.optional() }),
]);

/**
 * A session's billed time as the household records it: `seconds` so far, at least the start
 * charge, `confirmed` once `session.closed` gave the final count, and `running` until it has ended.
 */
export type VoiceUsage = { id: string; seconds: number; confirmed: boolean; running: boolean };

/**
 * One exchange of a Voice Session, `at` when it began: what GPT-Live `heard` and `said`, and whether
 * it was `delegated` to the agent. A delegated exchange keeps the `turn` it became instead of what
 * was heard, which is in the conversation; one with no turn, as nothing was heard or the turn
 * couldn't be recorded, keeps what was heard.
 */
export type VoiceExchange = {
  session: string;
  at: string;
  heard: string | null;
  said: string;
  delegated: boolean;
  turn: number | null;
};

/**
 * An exchange still going on: what was heard and said so far and, once delegated, the turn it is
 * `becoming`, and how much had been said when the agent's answer was sent (`saidBeforeAnswer`).
 */
type OpenExchange = {
  at: string;
  heard: string;
  said: string;
  becoming?: Promise<number | null>;
  saidBeforeAnswer?: number;
};

/** What a Voice Session asks of the household that holds it. */
export type VoiceHooks = {
  /**
   * Answers a turn heard from `where` through the shared conversation: the turn as recorded, and the
   * answer with what the buttons say of the changes it held for a tap (ADR 0024), null when the
   * agent couldn't.
   */
  answer(text: string, where: ChatWhere): Promise<{ turn: number; reply: { text: string; held: string[] } | null }>;
  /** Records an exchange once it has ended, and a delegated one once its turn is known. */
  exchange(exchange: VoiceExchange): void;
  /** Records the session's usage, each time it changes: from its creation to its end, as it ends. */
  usage(usage: VoiceUsage): void;
  /** Called once, when the session has ended. */
  end(session: VoiceSession): void;
};

/**
 * One Voice Session the household holds the sideband of. Every delegation becomes a turn of what
 * was heard since the last one, from where the person was when it was cut. It is answered by `answer`
 * (the shared conversation's path) after the turns cut before it, and spoken back as commentary,
 * which names the button of each change it held for a tap. Only the person's words leave here, as
 * turn text; no audio is kept. Each exchange, what GPT-Live heard and said, is recorded as it ends:
 * when the person is heard once GPT-Live has answered, at the next delegation, or with the session.
 */
export class VoiceSession {
  /** The input transcript heard since the last turn was cut. */
  private heard = "";
  /** The exchange going on, if anything has been heard or said since the last one ended. */
  private exchange: OpenExchange | null = null;
  /**
   * The turns being answered, one after another: a turn is submitted once the one before it has its
   * answer, so turns keep the order they were cut in, and a turn ahead that fails leaves it to run.
   */
  private answering: Promise<void> = Promise.resolve();
  private ending = false;
  private ended = false;
  /** Live's latest cumulative count, never below the start charge billed at creation. */
  private seconds = VOICE_START_CHARGE_SECONDS;
  private confirmed = false;
  private warned = false;
  /** The warning, the close when the allowance runs out, and the close after a silence. */
  private warning: ReturnType<typeof setTimeout> | undefined;
  private runOut: ReturnType<typeof setTimeout> | undefined;
  private silence: ReturnType<typeof setTimeout> | undefined;

  private constructor(
    private readonly id: string,
    private readonly sideband: Sideband,
    private place: ChatWhere,
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
    const charged = { id: created.id, seconds: VOICE_START_CHARGE_SECONDS, confirmed: false };
    hooks.usage({ ...charged, running: true });
    const sideband = await Sentry.startSpan({ name: "voice attach", op: "mise.voice" }, () =>
      live.attach(created.id),
    ).catch((error: unknown) => {
      hooks.usage({ ...charged, running: false });
      throw error;
    });
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

  /** Where the person is: the screen and Week, or Kitchen mode's step, the next turn cut is sent from. */
  get where(): ChatWhere {
    return this.place;
  }

  /** Where the person is now: the screen and Week, or Kitchen mode's step, the next turn cut is sent from. */
  moveTo(where: ChatWhere): void {
    this.place = where;
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
      case "session.input_transcript.delta": {
        if (this.exchange && spokeBack(this.exchange)) this.endExchange();
        this.exchangeGoingOn().heard += event.data.delta;
        this.heard += event.data.delta;
        this.hearSomething();
        return;
      }
      case "session.output_transcript.delta":
        this.exchangeGoingOn().said += event.data.delta;
        return;
      case "session.delegation.created": {
        // The delegation carries no utterance: the turn is what was heard since the last one.
        const text = this.heard.trim();
        this.heard = "";
        const { id } = event.data.delegation;
        const where = this.place;
        // What GPT-Live says from here, its acknowledgement and the answer, is this exchange's.
        if (this.exchange?.becoming) this.endExchange();
        const exchange = this.exchangeGoingOn();
        const turn = this.answering.then(() => this.delegate(id, text, where, exchange));
        // Reported, so that one turn's failure never stops the turns behind it.
        this.answering = turn.then(
          () => {},
          (error: unknown) => {
            Sentry.captureException(error);
          },
        );
        exchange.becoming = turn.catch(() => null);
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

  /** Answers a delegation made in `exchange`, and resolves with the turn it became, if any. */
  private async delegate(id: string, text: string, where: ChatWhere, exchange: OpenExchange): Promise<number | null> {
    let content = NOTHING_HEARD;
    let turn: number | null = null;
    if (text) {
      // A turn that throws is answered like one the agent failed, and reported.
      const answered = await this.hooks.answer(text, where).catch((error: unknown) => {
        Sentry.captureException(error);
        return null;
      });
      turn = answered?.turn ?? null;
      content = answered?.reply ? commentaryOf(answered.reply.text, answered.reply.held) : FAILURE_LINE;
    }
    if (!this.ended) this.sideband.send({ type: "session.commentary.append", delegation_id: id, content });
    exchange.saidBeforeAnswer = exchange.said.length;
    return turn;
  }

  /** The exchange going on, begun now if there was none. */
  private exchangeGoingOn(): OpenExchange {
    this.exchange ??= { at: new Date().toISOString(), heard: "", said: "" };
    return this.exchange;
  }

  /** Ends the exchange going on, if any, and records it: a delegated one once its turn is known. */
  private endExchange(): void {
    const ended = this.exchange;
    this.exchange = null;
    if (!ended) return;
    const { at, becoming } = ended;
    const heard = ended.heard.trim();
    const said = ended.said.trim();
    if (!becoming) {
      this.hooks.exchange({ session: this.id, at, heard, said, delegated: false, turn: null });
      return;
    }
    becoming
      .then((turn) =>
        this.hooks.exchange({ session: this.id, at, heard: turn === null ? heard : null, said, delegated: true, turn }),
      )
      .catch((error: unknown) => {
        Sentry.captureException(error);
      });
  }

  private finish(reason: string): void {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.warning);
    clearTimeout(this.runOut);
    clearTimeout(this.silence);
    this.endExchange();
    this.report(false);
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
    this.confirmed = confirmed;
    this.report(true);
  }

  private report(running: boolean): void {
    this.hooks.usage({ id: this.id, seconds: this.seconds, confirmed: this.confirmed, running });
  }
}

/**
 * Whether GPT-Live has answered what was heard in `exchange`, so that what is heard next is a new
 * exchange: it has said something, and for a delegated exchange, something since the agent's answer.
 * Until then, more heard is the person going on, or the transcript's tail arriving late.
 */
function spokeBack(exchange: OpenExchange): boolean {
  if (!exchange.becoming) return exchange.said !== "";
  return exchange.saidBeforeAnswer !== undefined && exchange.said.length > exchange.saidBeforeAnswer;
}

/**
 * The agent's answer as commentary: followed by which button to tap for each change it `held` and
 * didn't name (the person may be across the kitchen, and must not take the change as done), and cut
 * to fit, at the end of a sentence where there is one to cut at.
 */
function commentaryOf(answer: string, held: readonly string[]): string {
  const said = plain(answer);
  // The buttons come first, whole, leaving the answer room to begin.
  const room = MAX_COMMENTARY_CHARS - Math.min(answer.length, ANSWER_KEPT_CHARS) - 1;
  let taps = "";
  for (const summary of held) {
    if (said.includes(plain(summary))) continue;
    const more = [taps, `Tap ${summary} on the screen.`].filter(Boolean).join(" ");
    if (more.length > room) break;
    taps = more;
  }
  return [cutAt(answer, MAX_COMMENTARY_CHARS - (taps ? taps.length + 1 : 0)), taps].filter(Boolean).join(" ");
}

/** How much of the agent's answer commentary keeps, at least, however many buttons it names. */
const ANSWER_KEPT_CHARS = 200;

/** Text as it is heard: lower case, with no quotes. */
function plain(text: string): string {
  return text.toLowerCase().replace(/[“”‘’"']/g, "");
}

/** `answer` within `limit` characters, cut at the end of a sentence where there is one to cut at. */
function cutAt(answer: string, limit: number): string {
  if (answer.length <= limit) return answer;
  const cut = answer.slice(0, limit);
  const sentenceEnd = Math.max(
    cut.lastIndexOf(". "),
    cut.lastIndexOf("! "),
    cut.lastIndexOf("? "),
    cut.lastIndexOf("\n"),
  );
  return sentenceEnd > 0 ? cut.slice(0, sentenceEnd + 1).trimEnd() : cut;
}
