import { type ChatMessage, type ChatReply, DEFAULT_EFFORT_BUDGETS, type Household, STORE_SECTIONS } from "@mise/domain";
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
 * `reply`, and joins the conversation with the agent's answer, as the household keeps it.
 */
function fakeClient(earlier: ChatMessage[], reply: (text: string) => Promise<ChatReply>) {
  const conversation = [...earlier];
  const sent: string[] = [];
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
      chat: async (text) => {
        sent.push(text);
        const answer = await reply(text);
        if (answer.ok) conversation.push({ role: "member", text }, answer.value);
        return answer;
      },
    },
  );
  return { ...fake, sent };
}

function messageBox(chat: HTMLElement): HTMLTextAreaElement {
  return within(chat).getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
}

async function openChat() {
  await userEvent.click(await screen.findByRole("button", { name: "Ask Mise" }));
  return screen.findByRole("dialog", { name: "Ask Mise" });
}

test("the chat opens from the header with the conversation so far", async () => {
  const { client } = fakeClient(
    [
      { role: "member", text: "What's for dinner Monday?" },
      { role: "agent", text: "Dal." },
    ],
    async () => ({ ok: true, value: { role: "agent", text: "" } }),
  );
  render(() => <App client={client} />);

  const chat = await openChat();

  const turns = await within(chat).findAllByRole("listitem");
  expect(turns.map((turn) => turn.textContent)).toEqual(["Member: What's for dinner Monday?", "Mise: Dal."]);
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
      { role: "member", text: "What's for dinner Monday?" },
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
