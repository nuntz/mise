import type { ChatWhere, Household, VoiceAvailability } from "@mise/domain";
import { createEffect, createSignal, on, onCleanup, onMount } from "solid-js";
import type { MiseClient } from "./client";
import { householdTime } from "./dates";
import { keepFresh } from "./fresh";
import { t } from "./messages";
import type { OpenVoice, VoiceCall } from "./voice";
import { keepScreenAwake } from "./wakeLock";

/**
 * Why voice stopped short: a start went no further, as the mic, WebRTC or the household failed or
 * the household refused it, or (`voiceEnded`) a session ended without this device ending it.
 */
export type VoiceRefusal = "voice" | "voiceInUse" | "voiceSpent" | "voiceOff" | "voiceEnded";

/** How soon the mic asks again whether the day's voice minutes are back, at the soonest. */
const MINUTES_BACK_RETRY_MS = 5000;

/**
 * A screen's mic for a Voice Session (ADR 0028), shared by the chat sheet and Kitchen mode: whether
 * voice could start, as the household last said, and why not; the session this device runs, started
 * from `where` and moved with it; ended with `end`, when the screen goes, or when the page is hidden
 * (a locked phone turns the mic off but goes on billing). `onStarting` and `onRefused` let the screen
 * clear and say what went wrong. Times are on the `household`'s clock.
 */
export function createVoiceSession(props: {
  client: MiseClient;
  online: boolean;
  where: () => ChatWhere;
  voice?: OpenVoice;
  household?: Household | null;
  onStarting?: () => void;
  onRefused?: (refusal: VoiceRefusal) => void;
}) {
  const [state, setState] = createSignal<"off" | "starting" | "on">("off");
  /** Whether a Voice Session runs, or is starting. */
  const talking = () => state() !== "off";
  /** When the day's voice minutes come back, or who is talking to Mise, after a start refused for it. */
  const [minutesBackAt, setMinutesBackAt] = createSignal("");
  const [speaker, setSpeaker] = createSignal<string | null>(null);
  const timeOf = (iso: string) =>
    props.household
      ? householdTime(iso, props.household)
      : new Date(iso).toLocaleTimeString(undefined, { timeStyle: "short" });

  // Whether voice could start, as the household last said: the last answer stays while offline.
  const [availability, setAvailability] = createSignal<VoiceAvailability>();
  let minutesBack: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(minutesBack));
  if (props.voice) {
    const reload = keepFresh(
      props.client,
      ["voice", "household"],
      () => props.client.voiceAvailability(),
      (now) => {
        setAvailability(now);
        closeIfHouseholdLetGo(now);
        // No notice comes at midnight: the mic asks again once the day's minutes are back, and again
        // a little later while this device's clock runs ahead of the household's.
        clearTimeout(minutesBack);
        if (now.status === "spent") {
          minutesBack = setTimeout(
            () => void reload(),
            Math.max(MINUTES_BACK_RETRY_MS, Date.parse(now.until) - Date.now()),
          );
        }
      },
    );
  }
  /** Whether the mic shows: voice is there to be had, and this device's own session isn't still closing. */
  const micShown = () => {
    const now = availability();
    return (
      props.voice !== undefined &&
      now !== undefined &&
      now.status !== "unavailable" &&
      !(now.status === "in_use" && now.yours)
    );
  };
  /** Why the mic can't start a session now, if it can't. */
  const micReason = () => {
    const now = availability();
    if (!props.online) return t("chat.voice.needsConnection");
    if (now?.status === "in_use") return now.by ? t("chat.voice.talking", { name: now.by }) : t("chat.voice.inUse");
    if (now?.status === "spent") return t("chat.voice.spent", { time: timeOf(now.until) });
    if (now?.status === "off") return t("chat.voice.off");
    return undefined;
  };

  // The call running, and which start is current: one ended, or the screen gone, while a start
  // waits makes that start hang up when it resumes.
  let call: VoiceCall | undefined;
  let attempt = 0;
  /** Lets go of a Voice Session that ended without this device ending it, and says so. */
  const endedFor = (ended: VoiceCall) => {
    if (call !== ended) return;
    call = undefined;
    setState("off");
    props.onRefused?.("voiceEnded");
  };

  /**
   * Closes the Voice Session running once the household, which held it from the start, says none
   * runs: a restart or deploy lost it, and GPT-Live would go on answering with nobody behind it.
   * While the household holds one, even as another connection's after this one came back, it goes on.
   */
  const closeIfHouseholdLetGo = (now: VoiceAvailability) => {
    const running = call;
    if (!running || now.status === "in_use") return;
    running.close();
    endedFor(running);
  };
  // The household closes the session first, so it ends as asked rather than as a dropped call.
  const hangUp = (ending: VoiceCall) =>
    void props.client
      .endVoice()
      .catch(() => {})
      .finally(() => ending.hangUp());

  const start = async () => {
    const dial = props.voice;
    if (!dial || talking()) return;
    const mine = ++attempt;
    const current = () => mine === attempt;
    props.onStarting?.();
    setState("starting");
    // The call to end if the start goes no further: the household may hold its session by then.
    let opened: VoiceCall | undefined;
    let refusal: VoiceRefusal = "voice";
    try {
      opened = await dial();
      const reply = current() ? await props.client.startVoice(opened.offer, props.where()) : undefined;
      if (reply && !reply.ok) {
        // Refused, so there is no session to end: only the mic to let go of.
        opened.hangUp();
        opened = undefined;
        if (reply.error.code === "in_use") {
          refusal = "voiceInUse";
          setSpeaker(reply.error.by);
        }
        if (reply.error.code === "off") refusal = "voiceOff";
        if (reply.error.code === "spent") {
          refusal = "voiceSpent";
          setMinutesBackAt(timeOf(reply.error.until));
        }
        throw new Error(reply.error.message);
      }
      if (reply && current()) await opened.connect(reply.value.sdp);
    } catch {
      // The mic was refused, the browser has no WebRTC, or the household refused or didn't answer.
      if (opened) hangUp(opened);
      if (current()) {
        setState("off");
        props.onRefused?.(refusal);
      }
      return;
    }
    if (!current()) return hangUp(opened);
    call = opened;
    opened.onEnd(() => endedFor(opened));
    setState("on");
  };

  const end = () => {
    attempt++;
    const ending = call;
    call = undefined;
    setState("off");
    if (ending) hangUp(ending);
  };

  // Each turn is heard from where the person is when they say it, so a session follows them.
  createEffect(
    on(
      props.where,
      (where) => {
        if (talking()) void props.client.moveVoice(where).catch(() => {});
      },
      { defer: true },
    ),
  );

  // Auto-Lock would turn the mic off mid-session, so the screen stays on while one runs.
  keepScreenAwake(() => state() === "on");

  const onHidden = () => {
    if (document.visibilityState === "hidden") end();
  };
  onMount(() => document.addEventListener("visibilitychange", onHidden));
  onCleanup(() => {
    document.removeEventListener("visibilitychange", onHidden);
    end();
  });

  return { state, talking, micShown, micReason, start, end, speaker, minutesBackAt };
}
