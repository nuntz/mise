import {
  type ChatMessage,
  type ChatReply,
  type ChatWhere,
  currentWeek,
  DEFAULT_EFFORT_BUDGETS,
  type Household,
  STORE_SECTIONS,
  type ToolResult,
} from "@mise/domain";
import { render, screen, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { App } from "../src/App";
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
 * confirmation gets `confirm`.
 */
function fakeClient(
  earlier: ChatMessage[],
  reply: (text: string) => Promise<ChatReply>,
  confirm: (id: number) => ToolResult<unknown> = () => {
    throw new Error("Unexpected confirm");
  },
) {
  const conversation = [...earlier];
  const confirmed: number[] = [];
  const sent: string[] = [];
  const sentFrom: ChatWhere[] = [];
  const fake = createFakeClient(
    async (name) => {
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
    },
  );
  return { ...fake, sent, sentFrom, conversation, confirmed };
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
  await within(chat).findByText("Ask about the Week, for example “What's for dinner Thursday?”");

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
