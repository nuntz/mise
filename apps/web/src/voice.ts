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
  /**
   * Calls `listener` once, when the session ends on its own: closed by GPT-Live, or the connection
   * lost. One that ended before this was called is called at once.
   */
  onEnd(listener: () => void): void;
  /** Stops the mic and the connection. */
  hangUp(): void;
  /**
   * Asks GPT-Live to close the session, on the data channel, and hangs up once it has, or soon after
   * (at once without the channel); the mic and GPT-Live's voice stop at once. For a session the
   * household no longer answers, which GPT-Live would otherwise go on with. Ends as `onEnd` reports.
   */
  close(): void;
};

/** Asks for the mic and makes an offer. Rejects if the mic is refused or WebRTC is missing. */
export type OpenVoice = () => Promise<VoiceCall>;

/** How long a call asked to close waits for GPT-Live's `session.closed` before it hangs up anyway. */
const CLOSE_FALLBACK_MS = 2000;

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
  let endedOnItsOwn = false;
  /** Stops the mic and silences GPT-Live, leaving the connection to close. */
  const silence = () => {
    for (const track of mic.getTracks()) track.stop();
    speaker.srcObject = null;
  };
  const hangUp = () => {
    if (over) return;
    over = true;
    clearTimeout(closing);
    silence();
    peer.close();
  };
  // Closed by GPT-Live once it has `session.close`, or by the browser soon after anyway.
  let closing: ReturnType<typeof setTimeout> | undefined;
  const close = () => {
    if (over) return;
    silence();
    if (channel.readyState !== "open") return hangUp();
    channel.send(JSON.stringify({ type: "session.close" }));
    closing ??= setTimeout(hangUp, CLOSE_FALLBACK_MS);
  };
  const ended = () => {
    if (over) return;
    endedOnItsOwn = true;
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
      onEnd: (listener) => {
        if (endedOnItsOwn) listener();
        else listeners.push(listener);
      },
      hangUp,
      close,
    };
  } catch (error) {
    hangUp();
    throw error;
  }
};
