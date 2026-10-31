import type { OpenVoice, VoiceCall } from "../src/voice";

/**
 * The browser's WebRTC, faked: each call made, whether it was connected and hung up, and a way for
 * GPT-Live to end it. Like the real one, a call hung up never reports ending on its own, and one
 * that ended before `onEnd` reports it at once.
 */
export function fakeVoice() {
  const calls: { connected: string | null; hungUp: boolean; endFromLive(): void }[] = [];
  const open: OpenVoice = async () => {
    const listeners: (() => void)[] = [];
    let endedOnItsOwn = false;
    const made = {
      connected: null as string | null,
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
    };
    return call;
  };
  return { open, calls };
}
