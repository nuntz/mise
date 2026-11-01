import { type Live, type LiveClientEvent, LiveError, type LiveSessionConfig } from "../src/live";

/** A session the pretend Live made: what it was made with, and what the household sent on its sideband. */
export type PretendSession = {
  id: string;
  offer: string;
  config: LiveSessionConfig;
  attached: boolean;
  /** Whether the sideband is closed, by either end. */
  closed: boolean;
  sent: LiveClientEvent[];
  /** Sends a server event on the sideband, as JSON text, as the real one arrives. */
  serverSends(event: Record<string, unknown>): void;
  /**
   * Drops the sideband with no `session.closed`, as a deploy or a lost connection does, once what was
   * sent before has arrived.
   */
  drop(): void;
  /**
   * Loses the sideband with no word to the household, as when a restart or deploy tears down the
   * household that held it: the household is gone, and never hears the socket close.
   */
  lose(): void;
};

type Listener = { message(data: string): void; close(): void };

/** A session as the pretend Live keeps it: what the test sees, and its socket's end. */
type HeldSession = PretendSession & { listen(listener: Listener): void; close(): void };

/** What the pretend GPT-Live says as soon as it delegates, as the real one does by default. */
export const ACKNOWLEDGEMENT = "Let me check.";

/** How often the sideband delivers what the test sent. */
const TICK_MS = 1;

/** What GPT-Live says, as its output transcript gives it: in pieces, a word at a time. */
function speech(text: string): Record<string, unknown>[] {
  return text.split(/(?= )/).map((delta) => ({ type: "session.output_transcript.delta", delta }));
}

/**
 * A pretend GPT-Live, kept to the real one's contract: a session answers the offer, its sideband
 * delivers events once it is listened to, and `session.close` is answered with `session.closed` and
 * then the socket closing. As the real one does, it says `ACKNOWLEDGEMENT` once it has delegated,
 * and says each commentary the household sends once it has it; what it says by itself, the test sends. Events arrive later, in the household's own context, as a real socket's
 * do: a timer the household started delivers them, never the test's call. Refusals are `LiveError`s.
 *
 * With `refuse`, every create is refused. With `hold`, creates wait until `release()`.
 */
export function pretendLive({ refuse = false, hold = false }: { refuse?: boolean; hold?: boolean } = {}) {
  const sessions: PretendSession[] = [];
  // Polled from the household's timers: a promise it made can't be resolved from the test.
  let released = !hold;
  const live: Live = {
    async create(offer, config) {
      if (refuse) throw new LiveError("OpenAI refused the session (401)");
      // What the test sent, waiting for the household's timer to deliver it.
      const queue: string[] = [];
      let listener: Listener | undefined;
      let pump: ReturnType<typeof setInterval> | undefined;
      let dropping = false;
      const closeSocket = () => {
        if (session.closed) return;
        session.closed = true;
        clearInterval(pump);
        listener?.close();
      };
      const session: HeldSession = {
        id: `live_${sessions.length + 1}`,
        offer,
        config,
        attached: false,
        closed: false,
        sent: [],
        serverSends(event) {
          if (!session.closed) queue.push(JSON.stringify(event));
        },
        listen(added) {
          listener = added;
          // Started by the household, so it runs in the household's context.
          pump = setInterval(() => {
            for (const data of queue.splice(0)) {
              if (session.closed) return;
              const { type } = JSON.parse(data) as { type: string };
              listener?.message(data);
              if (type === "session.closed") closeSocket();
              // Spoken a moment after delegating: on the next delivery, after what was sent with it.
              if (type === "session.delegation.created")
                for (const said of speech(ACKNOWLEDGEMENT)) session.serverSends(said);
            }
            if (dropping) closeSocket();
          }, TICK_MS);
        },
        close: closeSocket,
        drop() {
          dropping = true;
        },
        lose() {
          session.closed = true;
          clearInterval(pump);
        },
      };
      sessions.push(session);
      while (!released) await new Promise((resolve) => setTimeout(resolve, TICK_MS));
      return { id: session.id, sdp: `answer to ${offer}` };
    },
    async attach(id) {
      const session = sessions.find((made) => made.id === id) as HeldSession | undefined;
      if (!session) throw new LiveError("OpenAI refused the sideband (404)");
      session.attached = true;
      return {
        send(event) {
          if (session.closed) return;
          session.sent.push(event);
          if (event.type === "session.commentary.append")
            for (const said of speech(event.content)) session.serverSends(said);
          if (event.type === "session.close") {
            session.serverSends({ type: "session.closed", reason: "close_requested", usage: { seconds: 20 } });
          }
        },
        listen: (listener) => session.listen(listener),
        close: () => session.close(),
      };
    },
  };
  /** Lets held creates answer: those waiting, and every one after. */
  const release = () => {
    released = true;
  };
  return { live, sessions, release };
}
