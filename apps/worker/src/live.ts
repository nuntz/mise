type Fetch = typeof fetch;

/**
 * GPT-Live-1 (ADR 0028), the voice of a Voice Session: the session is made from the browser's WebRTC
 * offer, and the household holds its sideband. The event shapes are pinned here because the Live API
 * changed in October 2026: what's relied on is in `LiveClientEvent` and `voice.ts`.
 */
export type Live = {
  /** Creates a session from the browser's SDP offer: its id and the SDP answer. Throws `LiveError`. */
  create(offer: string, session: LiveSessionConfig): Promise<{ id: string; sdp: string }>;
  /** Attaches a sideband to session `id`, which replays nothing said before it. Throws `LiveError`. */
  attach(id: string): Promise<Sideband>;
};

/** A session's sideband: the client events the household sends, and the server's events, unparsed. */
export type Sideband = {
  send(event: LiveClientEvent): void;
  /** Calls `message` with each server event's JSON text, from now on, and `close` once the socket closes. */
  listen(listener: { message(data: string): void; close(): void }): void;
  close(): void;
};

/** The session fields Mise sets (`POST /v1/live/sessions`, `session`). */
export type LiveSessionConfig = {
  model: "gpt-live-1";
  instructions: string;
  delegation: { type: "client" };
  store: false;
  client: { data_channel: { allowed_client_events: LiveClientEvent["type"][] } };
};

/** The client events the household sends. Commentary is at most 500 tokens. */
export type LiveClientEvent =
  | { type: "session.commentary.append"; delegation_id: string | null; content: string }
  | { type: "session.close" };

/** Live refused or could not be reached: the message says which. */
export class LiveError extends Error {}

/** What opening Live needs from the Worker's environment (Worker secrets, ADR 0005). */
type LiveEnv = { OPENAI_API_KEY?: string };

let replacement: ((env: LiveEnv) => Live | null) | undefined;

/**
 * Makes households start Voice Sessions on another Live from their next one, or OpenAI's again with
 * `undefined`. Tests script a pretend session this way, so no test reaches OpenAI.
 */
export function useLive(open: ((env: LiveEnv) => Live | null) | undefined): void {
  replacement = open;
}

/** The deployment's Live; null when it has no OpenAI key, and then there is no voice. */
export function openLive(env: LiveEnv): Live | null {
  if (replacement) return replacement(env);
  const key = env.OPENAI_API_KEY?.trim();
  return key ? openAiLive(key, fetch) : null;
}

const SESSIONS_URL = "https://api.openai.com/v1/live/sessions";

/** OpenAI's Live, with the project key `key`. */
export function openAiLive(key: string, fetcher: Fetch): Live {
  const authorization = `Bearer ${key}`;
  return {
    async create(offer, session) {
      let response: Response;
      try {
        response = await fetcher(SESSIONS_URL, {
          method: "POST",
          headers: { Authorization: authorization, "Content-Type": "application/json" },
          body: JSON.stringify({ session, transport: { type: "webrtc", sdp: offer } }),
        });
      } catch {
        throw new LiveError("OpenAI couldn't be reached");
      }
      const body = (await response.json().catch(() => null)) as {
        session?: { id?: unknown };
        transport?: { sdp?: unknown };
      } | null;
      const id = body?.session?.id;
      const sdp = body?.transport?.sdp;
      if (!response.ok || typeof id !== "string" || typeof sdp !== "string") {
        throw new LiveError(`OpenAI refused the session (${response.status})`);
      }
      return { id, sdp };
    },

    async attach(id) {
      let response: Response;
      try {
        // A Worker opens a WebSocket with a fetch Upgrade, where wss:// is spelled https://.
        response = await fetcher(`${SESSIONS_URL}/${encodeURIComponent(id)}/attach`, {
          headers: { Upgrade: "websocket", Authorization: authorization },
        });
      } catch {
        throw new LiveError("OpenAI couldn't be reached");
      }
      const socket = response.webSocket;
      if (!socket) throw new LiveError(`OpenAI refused the sideband (${response.status})`);
      return {
        send(event) {
          try {
            socket.send(JSON.stringify(event));
          } catch {
            // Closed already: the close listener has heard.
          }
        },
        listen(listener) {
          socket.addEventListener("message", (event) => {
            if (typeof event.data === "string") listener.message(event.data);
          });
          socket.addEventListener("close", () => listener.close());
          socket.addEventListener("error", () => listener.close());
          // Messages wait until the socket is accepted, so none arrives before there is a listener.
          socket.accept();
        },
        close() {
          try {
            socket.close();
          } catch {
            // Never accepted, or closed already.
          }
        },
      };
    },
  };
}
