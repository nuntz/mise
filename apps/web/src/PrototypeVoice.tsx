// PROTOTYPE (Drop 3 voice spike, docs/research/gpt-live-1-backend-agent.md). Throwaway, on the
// prototype/voice-backend branch only. Open /prototype-voice in `bun run dev`, press Start and talk.
import { HOUSEHOLD_AGENT } from "@mise/domain";
import { AgentClient } from "agents/client";
import { createSignal, For, onCleanup, Show } from "solid-js";

type Logged = { at: number; kind: string; [field: string]: unknown };
type Turn = {
  id: string;
  text?: string;
  msAfterLastWordHeard?: number;
  transcriptGrewDuringGrace?: boolean;
  agentMs?: number;
  sinceDelegationMs?: number;
  spokenAfterAnswerMs?: number;
  spokenAfterLastWordMs?: number;
  reply?: string;
};

export function PrototypeVoice() {
  const agent = new AgentClient({ ...HOUSEHOLD_AGENT, host: window.location.host });
  const [log, setLog] = createSignal<Logged[]>([]);
  const [turns, setTurns] = createSignal<Turn[]>([]);
  const [state, setState] = createSignal<"idle" | "starting" | "live" | "stopped">("idle");
  const [own, setOwn] = createSignal(0);
  const [usage, setUsage] = createSignal<unknown>(null);
  const [audio, setAudio] = createSignal<string>("–");
  let peer: RTCPeerConnection | null = null;
  let mic: MediaStream | null = null;
  const started = { at: 0 };

  const add = (entry: Logged) => {
    setLog((all) => [entry, ...all].slice(0, 400));
    const id = entry.id as string | undefined;
    const update = (patch: Partial<Turn>) =>
      setTurns((all) => all.map((turn) => (turn.id === id ? { ...turn, ...patch } : turn)));
    switch (entry.kind) {
      case "delegation":
        setTurns((all) => [{ id: id as string, msAfterLastWordHeard: entry.msAfterLastWordHeard as number }, ...all]);
        break;
      case "turn":
        update({ text: entry.text as string, transcriptGrewDuringGrace: entry.transcriptGrewDuringGrace as boolean });
        break;
      case "agent-answered":
        update({
          agentMs: entry.agentMs as number,
          sinceDelegationMs: entry.sinceDelegationMs as number,
          reply: entry.text as string,
        });
        break;
      case "answer-spoken":
        // The latest answered turn.
        setTurns((all) => {
          const index = all.findIndex((turn) => turn.agentMs !== undefined && turn.spokenAfterAnswerMs === undefined);
          if (index < 0) return all;
          const copy = [...all];
          copy[index] = {
            ...copy[index],
            spokenAfterAnswerMs: entry.msAfterAnswer as number,
            spokenAfterLastWordMs: entry.msAfterLastWordHeard as number,
          } as Turn;
          return copy;
        });
        break;
      case "speaking":
        if (entry.own) setOwn((n) => n + 1);
        break;
      case "usage":
      case "closed":
        setUsage(entry.usage ?? null);
        break;
      case "audio-meter":
        setAudio(`${entry.kbPerSecond} KB/s (${entry.kb} KB in ${entry.events} events)`);
        break;
      case "finished":
        setState("stopped");
        break;
    }
  };

  const onMessage = (event: MessageEvent) => {
    if (typeof event.data !== "string") return;
    try {
      const message = JSON.parse(event.data);
      if (message?.type === "prototype-voice") add(message);
    } catch {}
  };
  agent.addEventListener("message", onMessage);

  async function start() {
    setState("starting");
    started.at = Date.now();
    peer = new RTCPeerConnection();
    const speaker = document.createElement("audio");
    speaker.autoplay = true;
    peer.ontrack = (event) => {
      speaker.srcObject = event.streams[0] ?? null;
    };
    mic = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of mic.getTracks()) peer.addTrack(track, mic);
    const channel = peer.createDataChannel("oai-events");
    channel.onmessage = (event) => {
      // The browser sees the same events; only the first session.started is worth noting here.
      try {
        const message = JSON.parse(event.data);
        if (message.type === "session.started") add({ at: Date.now(), kind: "browser-session-started" });
      } catch {}
    };
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    const answer = await agent.call<{ ok: true; sdp: string } | { ok: false; error: string }>(
      "prototypeVoiceStart",
      [offer.sdp],
      { timeout: 30_000 },
    );
    add({ at: Date.now(), kind: "start-returned", ms: Date.now() - started.at, ok: answer.ok });
    if (!answer.ok) {
      add({ at: Date.now(), kind: "error", error: answer.error });
      stop();
      return;
    }
    await peer.setRemoteDescription({ type: "answer", sdp: answer.sdp });
    setState("live");
  }

  function stop() {
    void agent.call("prototypeVoiceStop", []).catch(() => {});
    for (const track of mic?.getTracks() ?? []) track.stop();
    peer?.close();
    peer = null;
    setState("stopped");
  }

  onCleanup(() => {
    stop();
    agent.removeEventListener("message", onMessage);
    agent.close();
  });

  const ms = (value: number | undefined) => (value === undefined ? "…" : `${(value / 1000).toFixed(1)} s`);

  return (
    <main style={{ padding: "16px", "max-width": "960px", margin: "0 auto", "font-family": "system-ui" }}>
      <h1>PROTOTYPE: voice over Mise's agent</h1>
      <p>
        GPT-Live-1 speaks; every delegation goes to Mise's own agent through the household's sideband. Talk to it as you
        would to the chat. It stops itself after 5 minutes.
      </p>
      <p>
        <button type="button" onClick={start} disabled={state() === "starting" || state() === "live"}>
          Start
        </button>{" "}
        <button type="button" onClick={stop} disabled={state() !== "live"}>
          Stop
        </button>{" "}
        <strong>{state()}</strong>
      </p>
      <dl>
        <dt>Times GPT-Live spoke without delegating since the person last spoke</dt>
        <dd>{own()} (includes greetings, which is allowed)</dd>
        <dt>Reflected audio reaching the household</dt>
        <dd>{audio()}</dd>
        <dt>Usage reported by OpenAI</dt>
        <dd>{JSON.stringify(usage())}</dd>
      </dl>
      <h2>Turns</h2>
      <table style={{ "border-collapse": "collapse", width: "100%" }}>
        <thead>
          <tr>
            <th align="left">Heard</th>
            <th>Delegated after last word</th>
            <th>Transcript still coming</th>
            <th>Agent took</th>
            <th>Answer spoken after last word</th>
          </tr>
        </thead>
        <tbody>
          <For each={turns()}>
            {(turn) => (
              <tr style={{ "border-top": "1px solid #ccc" }}>
                <td>
                  {turn.text ?? "…"}
                  <Show when={turn.reply}>
                    <div style={{ color: "#555" }}>→ {turn.reply}</div>
                  </Show>
                </td>
                <td align="center">{ms(turn.msAfterLastWordHeard)}</td>
                <td align="center">
                  {turn.transcriptGrewDuringGrace === undefined ? "…" : turn.transcriptGrewDuringGrace ? "yes" : "no"}
                </td>
                <td align="center">{ms(turn.agentMs)}</td>
                <td align="center">{ms(turn.spokenAfterLastWordMs)}</td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
      <h2>Log</h2>
      <pre style={{ "font-size": "12px", "white-space": "pre-wrap" }}>
        <For each={log()}>
          {(entry) => {
            const { at, kind, type: _, ...rest } = entry;
            return `${new Date(at).toISOString().slice(11, 23)} ${kind} ${JSON.stringify(rest)}\n`;
          }}
        </For>
      </pre>
    </main>
  );
}
