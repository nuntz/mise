import {
  type ChatMessage,
  type ChatReply,
  type ChatWhere,
  currentWeek,
  DEFAULT_EFFORT_BUDGETS,
  type Household,
  STORE_SECTIONS,
  type ToolResult,
  type VoiceStartReply,
} from "@mise/domain";
import { render, screen, waitFor, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { createSignal } from "solid-js";
import { afterEach, expect, test } from "vitest";
import { App } from "../src/App";
import { Chat } from "../src/Chat";
import type { MiseClient } from "../src/client";
import type { OpenVoice, VoiceCall } from "../src/voice";
import { createFakeClient } from "./fakeClient";

const household: Household = {
  name: "The Tremblays",
  timezone: "America/Vancouver",
  dinnerTime: "18:00",
  weekStartsOn: "monday",
  weekStartChanges: [],
  units: "metric",
  locale: "en-CA",
  members: [],
  effortBudgets: DEFAULT_EFFORT_BUDGETS,
  storeSections: [...STORE_SECTIONS],
};

/**
 * A client for a Household whose conversation with the agent starts as `earlier`; each message gets
 * `reply`, and joins the conversation with the agent's answer, as the household keeps it. A tap on a
 * confirmation gets `confirm`. A Voice Session is started and ended with `voice`.
 */
function fakeClient(
  earlier: ChatMessage[],
  reply: (text: string) => Promise<ChatReply>,
  confirm: (id: number) => ToolResult<unknown> = () => {
    throw new Error("Unexpected confirm");
  },
  voice: Partial<Pick<MiseClient, "startVoice" | "moveVoice" | "endVoice">> = {},
) {
  const conversation = [...earlier];
  const confirmed: number[] = [];
  const cancelled: number[] = [];
  const sent: string[] = [];
  const sentFrom: ChatWhere[] = [];
  const fake = createFakeClient(
    async (name, input) => {
      switch (name) {
        case "get_household":
          return { ok: true, value: household };
        case "get_caller":
          return { ok: true, value: null };
        case "get_week":
          return { ok: false, error: { code: "not_found", message: "" } };
        case "get_grocery_list":
          return { ok: true, value: null };
        case "list_due_staples":
          return { ok: true, value: { due: 0, staples: [] } };
        case "cancel_confirmation": {
          const id = input.id as number;
          cancelled.push(id);
          const index = conversation.findIndex((message) => message.role === "confirmation" && message.id === id);
          const turn = conversation[index];
          if (turn?.role !== "confirmation") return { ok: false, error: { code: "not_found", message: "" } };
          conversation[index] = { ...turn, status: "cancelled" };
          // The household announces the conversation once a confirmation is cancelled.
          queueMicrotask(() => fake.notify("chat"));
          return { ok: true, value: { id, summary: turn.summary } };
        }
        default:
          throw new Error(`Unexpected tool ${name}`);
      }
    },
    {
      conversation: async () => [...conversation],
      chat: async (text, where) => {
        sent.push(text);
        sentFrom.push(where);
        const answer = await reply(text);
        if (answer.ok) conversation.push({ role: "member", speaker: "Robin", text }, answer.value);
        return answer;
      },
      confirm: async (id) => {
        confirmed.push(id);
        return confirm(id);
      },
      ...voice,
    },
  );
  return { ...fake, sent, sentFrom, conversation, confirmed, cancelled };
}

function messageBox(chat: HTMLElement): HTMLTextAreaElement {
  return within(chat).getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
}

async function openChat() {
  await userEvent.click(await screen.findByRole("button", { name: "Ask Mise" }));
  return screen.findByRole("dialog", { name: "Ask Mise" });
}

test("the chat opens from the header with the conversation so far, each turn saying who said it", async () => {
  const { client } = fakeClient(
    [
      { role: "member", speaker: "Robin", text: "What's for dinner Monday?" },
      { role: "agent", text: "Dal." },
      { role: "member", speaker: null, text: "And Tuesday?" },
    ],
    async () => ({ ok: true, value: { role: "agent", text: "" } }),
  );
  render(() => <App client={client} />);

  const chat = await openChat();

  const turns = await within(chat).findAllByRole("listitem");
  expect(turns.map((turn) => turn.textContent)).toEqual([
    "Robin: What's for dinner Monday?",
    "Mise: Dal.",
    "Someone: And Tuesday?",
  ]);
});

/** What the chat last scrolled into view, by its text; jsdom has no scrolling of its own. */
function watchScrolling() {
  const scrolled: string[] = [];
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this.textContent ?? "");
  };
  return { last: () => scrolled.at(-1) };
}

afterEach(() => {
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  delete (window as { matchMedia?: unknown }).matchMedia;
});

test("the chat opens at its newest turn and follows the conversation as it grows", async () => {
  const scrolling = watchScrolling();
  let answer!: (reply: ChatReply) => void;
  const { client } = fakeClient(
    [
      { role: "member", speaker: "Robin", text: "What's for dinner Monday?" },
      { role: "agent", text: "Dal." },
    ],
    () => new Promise((resolve) => (answer = resolve)),
  );
  render(() => <App client={client} />);
  const chat = await openChat();
  await within(chat).findByText("Dal.");

  expect(scrolling.last()).toBe("Mise: Dal.");

  await userEvent.type(messageBox(chat), "And Tuesday?");
  await userEvent.click(within(chat).getByRole("button", { name: "Send" }));
  expect(scrolling.last()).toBe("Mise is thinking…");

  answer({ ok: true, value: { role: "agent", text: "Pasta." } });
  await within(chat).findByText("Pasta.");
  expect(scrolling.last()).toBe("Mise: Pasta.");
});

test("a message shows at once, then the agent's answer", async () => {
  let answer!: (reply: ChatReply) => void;
  const { client, sent } = fakeClient([], () => new Promise((resolve) => (answer = resolve)));
  render(() => <App client={client} />);
  const chat = await openChat();

  await userEvent.type(messageBox(chat), "What's for dinner Thursday?");
  await userEvent.click(within(chat).getByRole("button", { name: "Send" }));

  expect(sent).toEqual(["What's for dinner Thursday?"]);
  expect(messageBox(chat).value).toBe("");
  expect(within(chat).getByText("What's for dinner Thursday?")).toBeTruthy();
  expect(within(chat).getByRole("status").textContent).toBe("Mise is thinking…");

  answer({ ok: true, value: { role: "agent", text: "Lemon chicken." } });

  expect(await within(chat).findByText("Lemon chicken.")).toBeTruthy();
  expect(within(chat).queryByText("Mise is thinking…")).toBeNull();
});

test("in an empty conversation, the example question is a chip that sends it", async () => {
  const { client, sent } = fakeClient([], async () => ({ ok: true, value: { role: "agent", text: "Lemon chicken." } }));
  render(() => <App client={client} />);
  const chat = await openChat();

  await userEvent.click(await within(chat).findByRole("button", { name: "What's for dinner Thursday?" }));

  expect(sent).toEqual(["What's for dinner Thursday?"]);
  expect(await within(chat).findByText("Lemon chicken.")).toBeTruthy();
  expect(within(chat).queryByRole("button", { name: "What's for dinner Thursday?" })).toBeNull();
});

test("tapping the example keeps what someone had started typing", async () => {
  const { client, sent } = fakeClient([], async () => ({
    ok: false,
    error: { code: "unanswered", message: "model_error" },
  }));
  render(() => <App client={client} />);
  const chat = await openChat();
  await userEvent.type(messageBox(chat), "Is Friday");

  await userEvent.click(within(chat).getByRole("button", { name: "What's for dinner Thursday?" }));

  expect(sent).toEqual(["What's for dinner Thursday?"]);
  await within(chat).findByRole("alert");
  expect(messageBox(chat).value).toBe("Is Friday");
});

test("the send button shows once there's a message, and the AI disclosure stays", async () => {
  const { client } = fakeClient([], async () => ({ ok: true, value: { role: "agent", text: "" } }));
  render(() => <App client={client} />);
  const chat = await openChat();
  await within(chat).findByRole("button", { name: "What's for dinner Thursday?" });

  expect(within(chat).queryByRole("button", { name: "Send" })).toBeNull();
  await userEvent.type(messageBox(chat), "What's on Friday?");
  expect(within(chat).getByRole("button", { name: "Send" })).toBeTruthy();
  await userEvent.clear(messageBox(chat));
  expect(within(chat).queryByRole("button", { name: "Send" })).toBeNull();
  expect(
    within(chat).getByText("Mise's answers come from an AI model reading your plan. Check anything that matters."),
  ).toBeTruthy();
});

test("sent from the Send button by keyboard, the message leaves focus in the box for the next one", async () => {
  const { client } = fakeClient([], async () => ({ ok: true, value: { role: "agent", text: "Dal." } }));
  render(() => <App client={client} />);
  const chat = await openChat();
  await within(chat).findByRole("button", { name: "What's for dinner Thursday?" });

  await userEvent.type(messageBox(chat), "What's on Friday?");
  await userEvent.tab();
  expect(document.activeElement).toBe(within(chat).getByRole("button", { name: "Send" }));
  await userEvent.keyboard("{Enter}");

  await within(chat).findByText("Dal.");
  expect(document.activeElement).toBe(messageBox(chat));
});

test("a message the agent could not answer says so and stays to send again", async () => {
  const { client } = fakeClient([], async () => ({ ok: false, error: { code: "unanswered", message: "model_error" } }));
  render(() => <App client={client} />);
  const chat = await openChat();

  await userEvent.type(messageBox(chat), "What's for dinner?");
  await userEvent.click(within(chat).getByRole("button", { name: "Send" }));

  expect((await within(chat).findByRole("alert")).textContent).toBe("Mise couldn't answer that. Try again.");
  expect(messageBox(chat).value).toBe("What's for dinner?");
});

test("offline, the chat can't be opened: the agent needs the connection", async () => {
  const { client, goOffline } = fakeClient([], async () => ({ ok: true, value: { role: "agent", text: "" } }));
  render(() => <App client={client} />);
  const button = (await screen.findByRole("button", { name: "Ask Mise" })) as HTMLButtonElement;

  goOffline();

  expect(button.disabled).toBe(true);
  const reason = document.getElementById(String(button.getAttribute("aria-describedby")));
  expect(reason?.textContent).toBe("Needs a connection.");
  expect(button.nextElementSibling).toBe(reason);
});

/** A screen touched by a finger, where focusing a field brings up the keyboard; jsdom has no `matchMedia`. */
function touchScreen() {
  window.matchMedia = (query: string) => ({ matches: query === "(pointer: coarse)" }) as MediaQueryList;
}

test("on a touch screen, a tap on Send that focused it doesn't bring the keyboard back over the answer", async () => {
  touchScreen();
  const { client } = fakeClient([], async () => ({ ok: true, value: { role: "agent", text: "Dal." } }));
  render(() => <App client={client} />);
  const chat = await openChat();
  await within(chat).findByRole("button", { name: "What's for dinner Thursday?" });

  await userEvent.type(messageBox(chat), "What's on Friday?");
  // Android focuses a tapped button.
  const send = within(chat).getByRole("button", { name: "Send" });
  send.focus();
  await userEvent.keyboard("{Enter}");

  await within(chat).findByText("Dal.");
  expect(document.activeElement).not.toBe(messageBox(chat));
});

test("with a mouse, the chat opens ready to type", async () => {
  const { client } = fakeClient([], async () => ({ ok: true, value: { role: "agent", text: "" } }));
  render(() => <App client={client} />);

  const chat = await openChat();

  await waitFor(() => expect(document.activeElement).toBe(messageBox(chat)));
});

test("on a touch screen, the chat opens on the conversation, not the keyboard", async () => {
  touchScreen();
  const { client } = fakeClient([], async () => ({ ok: true, value: { role: "agent", text: "" } }));
  render(() => <App client={client} />);

  const chat = await openChat();

  await waitFor(() => expect(document.activeElement).toBe(chat));
});

test("the chat closes with its close button", async () => {
  const { client } = fakeClient([], async () => ({ ok: true, value: { role: "agent", text: "" } }));
  render(() => <App client={client} />);
  await openChat();

  await userEvent.click(screen.getByRole("button", { name: "Close the chat" }));

  expect(screen.queryByRole("dialog", { name: "Ask Mise" })).toBeNull();
});

test("a message says which screen, and which Week, the chat was opened from", async () => {
  const { client, sentFrom } = fakeClient([], async () => ({ ok: true, value: { role: "agent", text: "Done." } }));
  render(() => <App client={client} />);

  let chat = await openChat();
  await userEvent.type(messageBox(chat), "What's this week?");
  await userEvent.click(within(chat).getByRole("button", { name: "Send" }));
  await within(chat).findByText("Done.");
  await userEvent.click(within(chat).getByRole("button", { name: "Close the chat" }));
  await userEvent.click(screen.getByRole("button", { name: "Groceries" }));
  chat = await openChat();
  await userEvent.type(messageBox(chat), "Build the list");
  await userEvent.click(within(chat).getByRole("button", { name: "Send" }));
  await within(chat).findAllByText("Done.");

  expect(sentFrom).toEqual([
    // The Week screen shows no Week until one loads.
    { screen: "week" },
    { screen: "grocery", week: currentWeek(new Date(), household).startDate },
  ]);
});

test("someone else's turn shows once the conversation changes", async () => {
  const { client, conversation, notify } = fakeClient([], async () => ({
    ok: true,
    value: { role: "agent", text: "" },
  }));
  render(() => <App client={client} />);
  const chat = await openChat();
  await within(chat).findByRole("button", { name: "What's for dinner Thursday?" });

  conversation.push(
    { role: "member", speaker: "Alex", text: "Just the two of us Friday" },
    { role: "agent", text: "Done." },
  );
  notify("chat");

  expect(await within(chat).findByText("Just the two of us Friday")).toBeTruthy();
});

test("a confirmation the agent asked for shows as a button saying what will happen; a tap runs it", async () => {
  const { client, conversation, confirmed } = fakeClient(
    [
      { role: "member", speaker: "Robin", text: "Delete the Satay" },
      { role: "confirmation", id: 7, summary: "Delete “Satay”", status: "pending" },
      { role: "agent", text: "Tap the button to delete it." },
    ],
    async () => ({ ok: true, value: { role: "agent", text: "" } }),
    (id) => {
      const index = conversation.findIndex((message) => message.role === "confirmation" && message.id === id);
      conversation[index] = { role: "confirmation", id, summary: "Delete “Satay”", status: "done" };
      return { ok: true, value: {} };
    },
  );
  render(() => <App client={client} />);
  const chat = await openChat();

  await userEvent.click(await within(chat).findByRole("button", { name: "Delete “Satay”" }));

  expect(confirmed).toEqual([7]);
  expect(await within(chat).findByText((_, element) => element?.textContent === "Done: Delete “Satay”")).toBeTruthy();
  expect(within(chat).queryByRole("button", { name: "Delete “Satay”" })).toBeNull();
});

test("a confirmation that has expired shows no button, and a tap refused says so", async () => {
  const { client } = fakeClient(
    [
      { role: "confirmation", id: 1, summary: "Delete “Satay”", status: "expired" },
      { role: "confirmation", id: 2, summary: "Clear the Week of Monday, October 26", status: "pending" },
    ],
    async () => ({ ok: true, value: { role: "agent", text: "" } }),
    () => ({ ok: false, error: { code: "expired", message: "" } }),
  );
  render(() => <App client={client} />);
  const chat = await openChat();

  await within(chat).findByText("Delete “Satay”");
  expect(within(chat).queryByRole("button", { name: "Delete “Satay”" })).toBeNull();
  await userEvent.click(within(chat).getByRole("button", { name: "Clear the Week of Monday, October 26" }));

  expect((await within(chat).findByRole("alert")).textContent).toBe(
    "That has changed since Mise asked. Ask again if you still want it.",
  );
});

test("a confirmation can be cancelled from the chat", async () => {
  const { client, conversation, cancelled } = fakeClient(
    [{ role: "confirmation", id: 3, summary: "Delete “Satay”", status: "pending" }],
    async () => ({ ok: true, value: { role: "agent", text: "" } }),
  );
  render(() => <App client={client} />);
  const chat = await openChat();

  await userEvent.click(await within(chat).findByRole("button", { name: "Cancel: Delete “Satay”" }));

  expect(cancelled).toEqual([3]);
  expect(conversation).toEqual([{ role: "confirmation", id: 3, summary: "Delete “Satay”", status: "cancelled" }]);
  await waitFor(() => expect(within(chat).getByRole("listitem").textContent).toBe("Cancelled: Delete “Satay”"));
  expect(within(chat).queryByRole("button", { name: "Delete “Satay”" })).toBeNull();
});

/**
 * The browser's WebRTC, faked: each call made, whether it was connected and hung up, and a way for
 * GPT-Live to end it. Like the real one, a call hung up never reports ending on its own, and one
 * that ended before `onEnd` reports it at once.
 */
function fakeVoice() {
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

/** A Household where Robin's spoken turns join the conversation, and the household's voice calls. */
function talkingClient(
  start: (offer: string, where: ChatWhere) => Promise<VoiceStartReply> = async (offer) => ({
    ok: true,
    value: { sdp: `answer to ${offer}` },
  }),
) {
  const started: { offer: string; where: ChatWhere }[] = [];
  const moved: ChatWhere[] = [];
  let ended = 0;
  const fake = fakeClient([], async () => ({ ok: true, value: { role: "agent", text: "" } }), undefined, {
    startVoice: async (offer, where) => {
      started.push({ offer, where });
      return start(offer, where);
    },
    moveVoice: async (where) => {
      moved.push(where);
      return true;
    },
    endVoice: async () => {
      ended++;
    },
  });
  return { ...fake, started, moved, ended: () => ended };
}

test("the chat's mic starts a Voice Session, shows its turns as they're answered, and ends it with a tap", async () => {
  const fake = talkingClient();
  const voice = fakeVoice();
  render(() => <App client={fake.client} voice={voice.open} />);
  const chat = await openChat();

  await userEvent.click(within(chat).getByRole("button", { name: "Talk to Mise" }));

  expect(await within(chat).findByText("Listening. Talk to Mise.")).toBeTruthy();
  // The Week screen shows no Week here, as none loads.
  expect(fake.started).toEqual([{ offer: "offer 1", where: { screen: "week" } }]);
  expect(voice.calls[0]?.connected).toBe("answer to offer 1");
  // The household records each spoken turn and its answer, then announces the conversation.
  fake.conversation.push(
    { role: "member", speaker: "Robin", text: "What's for dinner Thursday?" },
    { role: "agent", text: "Dal." },
  );
  fake.notify("chat");
  const turns = await within(chat).findAllByRole("listitem");
  expect(turns.map((turn) => turn.textContent)).toEqual(["Robin: What's for dinner Thursday?", "Mise: Dal."]);

  await userEvent.click(within(chat).getByRole("button", { name: "End voice" }));

  expect(fake.ended()).toBe(1);
  await waitFor(() => expect(voice.calls[0]?.hungUp).toBe(true));
  expect(within(chat).queryByText("Listening. Talk to Mise.")).toBeNull();
  expect(within(chat).getByRole("button", { name: "Talk to Mise" })).toBeTruthy();
});

test("a Voice Session follows the screen and Week the person moves to, until it ends", async () => {
  const fake = talkingClient();
  const voice = fakeVoice();
  const [where, setWhere] = createSignal<ChatWhere>({ screen: "week" });
  render(() => <Chat client={fake.client} online={true} where={where} voice={voice.open} />);
  const chat = await openChat();
  await userEvent.click(within(chat).getByRole("button", { name: "Talk to Mise" }));
  await within(chat).findByText("Listening. Talk to Mise.");

  setWhere({ screen: "week", week: "2026-10-26" });
  setWhere({ screen: "pantry" });
  await waitFor(() => expect(fake.moved).toEqual([{ screen: "week", week: "2026-10-26" }, { screen: "pantry" }]));

  await userEvent.click(within(chat).getByRole("button", { name: "End voice" }));
  setWhere({ screen: "recipes" });
  expect(fake.moved).toHaveLength(2);
});

test("closing the chat ends its Voice Session", async () => {
  const fake = talkingClient();
  const voice = fakeVoice();
  render(() => <App client={fake.client} voice={voice.open} />);
  const chat = await openChat();
  await userEvent.click(within(chat).getByRole("button", { name: "Talk to Mise" }));
  await within(chat).findByText("Listening. Talk to Mise.");

  await userEvent.click(within(chat).getByRole("button", { name: "Close the chat" }));

  expect(fake.ended()).toBe(1);
  await waitFor(() => expect(voice.calls[0]?.hungUp).toBe(true));
});

test("a Voice Session ends when the page is hidden, since a locked phone turns the mic off", async () => {
  const fake = talkingClient();
  const voice = fakeVoice();
  render(() => <App client={fake.client} voice={voice.open} />);
  const chat = await openChat();
  await userEvent.click(within(chat).getByRole("button", { name: "Talk to Mise" }));
  await within(chat).findByText("Listening. Talk to Mise.");

  Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
  Reflect.deleteProperty(document, "visibilityState");

  expect(fake.ended()).toBe(1);
  await waitFor(() => expect(voice.calls[0]?.hungUp).toBe(true));
  expect(within(chat).getByRole("button", { name: "Talk to Mise" })).toBeTruthy();
});

test("a Voice Session GPT-Live ended goes back to the mic", async () => {
  const fake = talkingClient();
  const voice = fakeVoice();
  render(() => <App client={fake.client} voice={voice.open} />);
  const chat = await openChat();
  await userEvent.click(within(chat).getByRole("button", { name: "Talk to Mise" }));
  await within(chat).findByText("Listening. Talk to Mise.");

  voice.calls[0]?.endFromLive();

  expect(await within(chat).findByRole("button", { name: "Talk to Mise" })).toBeTruthy();
  expect(within(chat).queryByText("Listening. Talk to Mise.")).toBeNull();
});

test("a Voice Session the household refused to start says so and lets go of the mic", async () => {
  const fake = talkingClient(async () => ({ ok: false, error: { code: "in_use", message: "" } }));
  const voice = fakeVoice();
  render(() => <App client={fake.client} voice={voice.open} />);
  const chat = await openChat();

  await userEvent.click(within(chat).getByRole("button", { name: "Talk to Mise" }));

  expect((await within(chat).findByRole("alert")).textContent).toBe("Someone else is talking to Mise.");
  expect(voice.calls[0]?.hungUp).toBe(true);
  expect(within(chat).getByRole("button", { name: "Talk to Mise" })).toBeTruthy();
});

test("a start the household didn't answer ends whatever session it made, and lets go of the mic", async () => {
  const fake = talkingClient(async () => {
    throw new Error("Request timed out");
  });
  const voice = fakeVoice();
  render(() => <App client={fake.client} voice={voice.open} />);
  const chat = await openChat();

  await userEvent.click(within(chat).getByRole("button", { name: "Talk to Mise" }));

  expect((await within(chat).findByRole("alert")).textContent).toBe("Voice couldn't start. Try again.");
  expect(fake.ended()).toBe(1);
  await waitFor(() => expect(voice.calls[0]?.hungUp).toBe(true));
});

test("a mic the browser refused says voice couldn't start", async () => {
  const fake = talkingClient();
  const refused: OpenVoice = async () => {
    throw new Error("NotAllowedError");
  };
  render(() => <App client={fake.client} voice={refused} />);
  const chat = await openChat();

  await userEvent.click(within(chat).getByRole("button", { name: "Talk to Mise" }));

  expect((await within(chat).findByRole("alert")).textContent).toBe("Voice couldn't start. Try again.");
  expect(fake.started).toEqual([]);
});
