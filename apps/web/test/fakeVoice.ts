import type { OpenVoice, VoiceCall } from "../src/voice";

/**
 * The browser's WebRTC, faked: each call made, whether it was connected, closed and hung up, and a
 * way for GPT-Live to end it. Like the real one, a call hung up never reports ending on its own, and one
 * that ended before `onEnd` reports it at once.
 */
export function fakeVoice() {
  const calls: { connected: string | null; closed: boolean; hungUp: boolean; endFromLive(): void }[] = [];
  const open: OpenVoice = async () => {
    const listeners: (() => void)[] = [];
    let endedOnItsOwn = false;
    const made = {
      connected: null as string | null,
      closed: false,
      hungUp: false,
      endFromLive() {
        if (made.hungUp) return;
        made.hungUp = true;
        endedOnItsOwn = true;
        for (const listener of listeners.splice(0)) listener();
      },
    };
    calls.push(made);
    const call: VoiceCall = {
      offer: `offer ${calls.length}`,
      connect: async (answer) => {
        made.connected = answer;
      },
      onEnd: (listener) => {
        if (endedOnItsOwn) listener();
        else listeners.push(listener);
      },
      hangUp: () => {
        made.hungUp = true;
      },
      // GPT-Live answers `session.close` by closing the session, as it would end it on its own.
      close: () => {
        if (made.hungUp) return;
        made.closed = true;
        made.endFromLive();
      },
    };
    return call;
  };
  return { open, calls };
}
