/**
 * The browser's side of a Voice Session (ADR 0028): the mic, a WebRTC peer connection to GPT-Live-1
 * and its `oai-events` data channel. Only audio goes this way; the household answers over its own
 * sideband. Screens open one with `OpenVoice`, which tests fake.
 */
export type VoiceCall = {
  /** The SDP offer the household creates the session from. */
  offer: string;
  /** Connects with the SDP answer the household got back. */
  connect(answer: string): Promise<void>;
  /** Calls `listener` once, when the session ends on its own: closed by GPT-Live, or the connection lost. */
  onEnd(listener: () => void): void;
  /** Stops the mic and the connection. */
  hangUp(): void;
};

/** Asks for the mic and makes an offer. Rejects if the mic is refused or WebRTC is missing. */
export type OpenVoice = () => Promise<VoiceCall>;

export const openVoice: OpenVoice = async () => {
  const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
  const peer = new RTCPeerConnection();
  const speaker = new Audio();
  speaker.autoplay = true;
  peer.ontrack = (event) => {
    speaker.srcObject = event.streams[0] ?? null;
  };
  for (const track of mic.getTracks()) peer.addTrack(track, mic);
  // GPT-Live needs the channel to be offered; the household reads the session's events, not the browser.
  const channel = peer.createDataChannel("oai-events");

  const listeners: (() => void)[] = [];
  let over = false;
  const hangUp = () => {
    if (over) return;
    over = true;
    for (const track of mic.getTracks()) track.stop();
    peer.close();
    speaker.srcObject = null;
  };
  const ended = () => {
    if (over) return;
    hangUp();
    for (const listener of listeners.splice(0)) listener();
  };
  channel.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    try {
      if ((JSON.parse(event.data) as { type?: unknown }).type === "session.closed") ended();
    } catch {
      // Not an event: nothing to act on.
    }
  });
  peer.addEventListener("connectionstatechange", () => {
    if (peer.connectionState === "failed" || peer.connectionState === "closed") ended();
  });

  try {
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    return {
      offer: offer.sdp ?? "",
      connect: (answer) => peer.setRemoteDescription({ type: "answer", sdp: answer }),
      onEnd: (listener) => listeners.push(listener),
      hangUp,
    };
  } catch (error) {
    hangUp();
    throw error;
  }
};
