// PROTOTYPE (Drop 3 voice spike, docs/research/gpt-live-1-backend-agent.md). Throwaway: no tests, no
// error handling beyond what keeps it running. It lives on the prototype/voice-backend branch only.
//
// One GPT-Live-1 session, created by the household with the browser's SDP offer, with the household
// holding the sideband. Every client delegation is answered by Mise's own agent: the input transcript
// heard since the last delegation is sent as a turn, and the answer goes back as commentary to speak.

const LIVE = "https://api.openai.com/v1/live/sessions";

/** The spike's hard stop, standing in for the daily minute cap. */
const MAX_SESSION_SECONDS = 300;
/** How long to wait for more transcript when a delegation arrives before the words have. */
const TRANSCRIPT_GRACE_MS = 0;
/** commentary.append takes at most 500 tokens; this keeps well under. */
const MAX_COMMENTARY_CHARS = 1600;

const INSTRUCTIONS = `You are the voice of Mise, a family's meal planner. You only speak; a separate assistant, Mise's agent, knows the household's plan, recipes, groceries and pantry, and makes every change.

# Delegation policy
Generate <|SpawnThinking|> when:
- the person asks anything about their meals, recipes, the week, groceries, the pantry, the household or cooking;
- the person asks for any change, however small;
- you are unsure whether you know the answer.
Do not generate <|SpawnThinking|> when:
- the person only greets you, thanks you or says goodbye;
- you can answer from a result Mise's agent already gave in this conversation and nothing has changed since.

Never invent a recipe, an amount, a plan or a result. Never say a change is done until Mise's agent says so.

# Personality during tool calls
Concise: a brief receipt, then quiet until the answer arrives.

# Speaking results
Say Mise's agent's answer naturally and briefly. If it asks the person to tap a button to confirm, tell them to tap it on the screen.`;

export type VoiceLog = (event: Record<string, unknown>) => void;

type Delegation = { id: string; at: number; heardUntil: number };

export class VoiceSession {
  readonly id: string;
  private socket: WebSocket | null = null;
  /** Input transcript not yet sent as a turn, and when its last piece arrived. */
  private heard = "";
  private lastHeardAt = 0;
  private spokenSinceDelegation = false;
  /** Words GPT-Live said on its own since the person last spoke: a reply, not a backchannel, from 3. */
  private ownWords = 0;
  private delegationsSinceSpeech = 0;
  /** Reflected audio, which the household does not need: counted to see what it costs. */
  private audioBytes = 0;
  private audioEvents = 0;
  private readonly startedAt = Date.now();
  private stopTimer: ReturnType<typeof setTimeout> | null = null;
  private meter: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  /** When the agent's last answer was appended, and when the words it answered were last heard. */
  private answered: { at: number; heardUntil: number } | null = null;

  private constructor(
    id: string,
    private readonly key: string,
    private readonly answer: (text: string) => Promise<string>,
    private readonly log: VoiceLog,
  ) {
    this.id = id;
  }

  /** Creates the session with the browser's offer; resolves with the session and its SDP answer. */
  static async start(
    offer: string,
    key: string,
    answer: (text: string) => Promise<string>,
    log: VoiceLog,
  ): Promise<{ session: VoiceSession; sdp: string }> {
    const t0 = Date.now();
    const response = await fetch(LIVE, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        session: {
          model: "gpt-live-1",
          instructions: INSTRUCTIONS,
          // Client delegation: Mise's agent answers, no OpenAI backend model in between.
          delegation: { type: "client" },
        },
        transport: { type: "webrtc", sdp: offer },
      }),
    });
    const body = (await response.json()) as {
      session?: { id?: string };
      transport?: { sdp?: string };
      error?: unknown;
    };
    log({ kind: "create", status: response.status, ms: Date.now() - t0, error: body.error ?? null });
    if (!response.ok || !body.session?.id || !body.transport?.sdp) {
      throw new Error(`Session not created: ${response.status} ${JSON.stringify(body.error ?? body)}`);
    }
    const session = new VoiceSession(body.session.id, key, answer, log);
    // Attached before the browser even has its answer, so no transcript is missed (attach replays nothing).
    await session.attach();
    return { session, sdp: body.transport.sdp };
  }

  private async attach(): Promise<void> {
    const t0 = Date.now();
    // Workers open an outgoing WebSocket with a fetch Upgrade; wss is spelled https here.
    const response = await fetch(`${LIVE}/${this.id}/attach`, {
      headers: { Upgrade: "websocket", Authorization: `Bearer ${this.key}` },
    });
    const socket = response.webSocket;
    this.log({ kind: "attach", status: response.status, ms: Date.now() - t0, ok: Boolean(socket) });
    if (!socket) throw new Error(`Sideband not attached: ${response.status} ${await response.text()}`);
    socket.accept();
    this.socket = socket;
    socket.addEventListener("message", (event) => this.onMessage(event.data));
    socket.addEventListener("close", (event) => {
      this.log({ kind: "sideband-closed", code: event.code, reason: event.reason });
      this.finish();
    });
    socket.addEventListener("error", () => this.log({ kind: "sideband-error" }));
    this.stopTimer = setTimeout(() => {
      this.log({ kind: "cap-reached", seconds: MAX_SESSION_SECONDS });
      this.stop();
    }, MAX_SESSION_SECONDS * 1000);
    this.meter = setInterval(() => {
      const seconds = (Date.now() - this.startedAt) / 1000;
      this.log({
        kind: "audio-meter",
        events: this.audioEvents,
        kb: Math.round(this.audioBytes / 1024),
        kbPerSecond: Math.round(this.audioBytes / 1024 / seconds),
      });
    }, 10_000);
  }

  stop(): void {
    if (this.closed) return;
    this.send({ type: "session.close" });
    // The bounded fallback if session.closed never comes.
    setTimeout(() => this.finish(), 5000);
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.stopTimer) clearTimeout(this.stopTimer);
    if (this.meter) clearInterval(this.meter);
    try {
      this.socket?.close();
    } catch {}
    this.log({ kind: "finished", wallSeconds: Math.round((Date.now() - this.startedAt) / 1000) });
  }

  private send(event: Record<string, unknown>): void {
    try {
      this.socket?.send(JSON.stringify(event));
    } catch (error) {
      this.log({ kind: "send-failed", type: event.type, error: String(error) });
    }
  }

  private onMessage(data: unknown): void {
    if (typeof data !== "string") return;
    const size = data.length;
    const event = JSON.parse(data) as { type?: string; [field: string]: unknown };
    const type = event.type ?? "";
    // Reflected audio: counted, never forwarded.
    if (type === "session.input_audio.append" || type === "session.output_audio.delta") {
      this.audioEvents++;
      this.audioBytes += size;
      return;
    }
    const now = Date.now();
    switch (type) {
      case "session.input_transcript.delta": {
        // GPT-Live answered what came before (a greeting) itself; a "Mm-hmm" keeps it.
        if (this.ownWords >= 3) this.heard = "";
        this.ownWords = 0;
        this.heard += textOf(event);
        this.lastHeardAt = now;
        this.spokenSinceDelegation = false;
        this.delegationsSinceSpeech = 0;
        this.log({ kind: "heard", text: textOf(event) });
        return;
      }
      case "session.output_transcript.delta": {
        // Speech with no delegation since the person last spoke: GPT-Live answering on its own.
        const own = this.delegationsSinceSpeech === 0;
        if (!this.spokenSinceDelegation) this.log({ kind: "speaking", own, at: now });
        if (own) this.ownWords += textOf(event).trim().split(/\s+/).filter(Boolean).length;
        if (this.answered) {
          // Roughly when the answer started being said (the acknowledgement may still be running).
          this.log({
            kind: "answer-spoken",
            msAfterAnswer: now - this.answered.at,
            msAfterLastWordHeard: now - this.answered.heardUntil,
          });
          this.answered = null;
        }
        this.spokenSinceDelegation = true;
        this.log({ kind: "said", text: textOf(event), own });
        return;
      }
      case "session.delegation.created": {
        const delegation = event.delegation as { id: string } | undefined;
        if (!delegation) return;
        this.delegationsSinceSpeech++;
        void this.delegate({ id: delegation.id, at: now, heardUntil: this.lastHeardAt });
        return;
      }
      case "session.usage.updated":
        this.log({ kind: "usage", usage: event.usage });
        return;
      case "session.closed":
        this.log({ kind: "closed", reason: event.reason, usage: event.usage });
        this.finish();
        return;
      default:
        this.log({ kind: "event", type, event });
    }
  }

  /** Waits briefly for the sentence to finish transcribing, then asks Mise's agent and speaks its answer. */
  private async delegate(delegation: Delegation): Promise<void> {
    const sinceHeard = delegation.at - delegation.heardUntil;
    this.log({ kind: "delegation", id: delegation.id, msAfterLastWordHeard: sinceHeard });
    await new Promise((resolve) => setTimeout(resolve, TRANSCRIPT_GRACE_MS));
    const text = this.heard.trim();
    this.heard = "";
    const grew = this.lastHeardAt > delegation.heardUntil;
    this.log({ kind: "turn", id: delegation.id, text, transcriptGrewDuringGrace: grew });
    if (!text) {
      this.send({ type: "session.commentary.append", delegation_id: delegation.id, content: "I didn't catch that." });
      return;
    }
    const asked = Date.now();
    let reply: string;
    try {
      reply = await this.answer(`(Spoken aloud and transcribed, so it may contain mistakes.) ${text}`);
    } catch (error) {
      reply = "Mise's agent could not answer just now.";
      this.log({ kind: "agent-failed", error: String(error) });
    }
    const answered = Date.now();
    this.log({
      kind: "agent-answered",
      id: delegation.id,
      agentMs: answered - asked,
      sinceDelegationMs: answered - delegation.at,
      text: reply,
    });
    this.answered = { at: Date.now(), heardUntil: delegation.heardUntil };
    this.send({
      type: "session.commentary.append",
      delegation_id: delegation.id,
      content: reply.slice(0, MAX_COMMENTARY_CHARS),
    });
  }
}

/** A transcript delta's text, whatever the field is called. */
function textOf(event: Record<string, unknown>): string {
  for (const field of ["delta", "text", "transcript"]) {
    if (typeof event[field] === "string") return event[field] as string;
  }
  return "";
}
