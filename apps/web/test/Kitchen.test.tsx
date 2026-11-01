import {
  addDays,
  type ChatMessage,
  type ChatWhere,
  DEFAULT_EFFORT_BUDGETS,
  type Household,
  MEALS,
  parseIngredient,
  type Recipe,
  type Slot,
  STORE_SECTIONS,
  type Week,
} from "@mise/domain";
import { render, screen, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { App } from "../src/App";
import type { MiseClient } from "../src/client";
import { KitchenMode } from "../src/Kitchen";
import { saveRecipe } from "../src/offline";
import { createFakeClient } from "./fakeClient";
import { fakeVoice } from "./fakeVoice";
import { fakeWakeLock } from "./fakeWakeLock";

const household: Household = {
  name: "The Tremblays",
  timezone: "America/Vancouver",
  dinnerTime: "18:00",
  weekStartsOn: "monday",
  weekStartChanges: [],
  units: "metric",
  locale: "en-CA",
  voiceMinutesPerDay: 30,
  members: [{ id: 1, name: "Robin", email: null, constraints: [] }],
  effortBudgets: DEFAULT_EFFORT_BUDGETS,
  storeSections: [...STORE_SECTIONS],
};

const curry: Recipe = {
  id: 2,
  title: "Curry",
  baseServings: 4,
  ingredients: ["2 cloves garlic, minced", "1 cup rice", "400 ml coconut milk", "salt to taste"].map((raw) =>
    parseIngredient(raw),
  ),
  steps: ["Fry the garlic.", "Add the coconut milk and simmer.", "Serve over the rice."],
  tags: [],
  effortMinutes: 40,
  cuisine: null,
  mainProtein: null,
  course: null,
  readyMade: false,
  recurring: null,
  yieldsLeftovers: true,
  prepAhead: null,
  notes: null,
  photoKey: null,
  allergens: { kind: "known", allergens: [] },
  source: { kind: "manual" },
  importedPreference: null,
  createdAt: "2026-10-21T12:00:00.000Z",
  updatedAt: "2026-10-21T12:00:00.000Z",
  editedInAppAt: null,
  draft: false,
  lastCookedAt: null,
  cookCount: 0,
};

/** This Week, with Monday's dinner the Curry cooked for 6: 4 eating and Tuesday's Leftovers. */
function week(): Week {
  const startDate = "2026-10-26";
  const slots = Array.from({ length: 7 }, (_, day) => addDays(startDate, day)).flatMap((date) =>
    MEALS.map(
      (meal): Slot => ({
        date,
        meal,
        kind: "unplanned",
        recipe: null,
        note: null,
        diners: [1],
        dinersAreDefault: true,
        guests: 0,
        guestConstraints: [],
        servings: 1,
        cookFor: 0,
        leftoversOf: null,
        leftovers: [],
        locked: false,
        conflicts: [],
        reason: null,
        cookedAt: null,
        ratings: [],
      }),
    ),
  );
  Object.assign(slots[2] as Slot, {
    kind: "recipe",
    recipe: { id: 2, title: "Curry", baseServings: 4, photoKey: null },
    servings: 4,
    cookFor: 6,
    leftovers: [{ date: "2026-10-27", meal: "dinner" }],
  });
  return {
    startDate,
    endDate: addDays(startDate, 6),
    slots,
    effortBudgets: DEFAULT_EFFORT_BUDGETS,
    effortBudgetOverrides: {},
    proposalSeed: null,
    reviewed: false,
  };
}

function fakeClient(): MiseClient {
  return householdClient().client;
}

/**
 * The Household's tools, its shared conversation, and its Voice Sessions: each start and move, how
 * many were ended, and each confirmation tapped or cancelled.
 */
function householdClient() {
  const voice = { started: [] as ChatWhere[], moved: [] as ChatWhere[], ended: 0 };
  const conversation: ChatMessage[] = [];
  const confirmed: number[] = [];
  const cancelled: number[] = [];
  /** Answers the pending confirmation `id`, as the household does once it's tapped or cancelled. */
  const settle = (id: number, status: "done" | "cancelled") => {
    const at = conversation.findIndex((turn) => turn.role === "confirmation" && turn.id === id);
    const turn = conversation[at];
    if (turn?.role === "confirmation") conversation[at] = { ...turn, status };
  };
  const fake = createFakeClient(
    async (name: string, input: Record<string, unknown>) => {
      switch (name) {
        case "cancel_confirmation":
          cancelled.push(input.id as number);
          settle(input.id as number, "cancelled");
          fake.notify("chat");
          return { ok: true, value: null };
        case "get_household":
          return { ok: true, value: household };
        case "get_week":
          return { ok: true, value: week() };
        case "get_recipe":
          return { ok: true, value: curry };
        case "search_recipes":
          return { ok: true, value: [] };
        default:
          throw new Error(`Unexpected tool ${name}`);
      }
    },
    {
      conversation: async () => structuredClone(conversation),
      confirm: async (id) => {
        confirmed.push(id);
        settle(id, "done");
        return { ok: true, value: null };
      },
      voiceAvailability: async () => ({ status: "available" }),
      startVoice: async (offer, where) => {
        voice.started.push(where);
        return { ok: true, value: { sdp: `answer to ${offer}` } };
      },
      moveVoice: async (where) => {
        voice.moved.push(where);
        return true;
      },
      endVoice: async () => {
        voice.ended++;
      },
    },
  );
  return { ...fake, voice, conversation, confirmed, cancelled, settle };
}

async function cookMonday() {
  const user = userEvent.setup();
  render(() => <App client={fakeClient()} />);
  const monday = await screen.findByRole("region", { name: "Monday, October 26" });
  await user.click(within(monday).getByRole("button", { name: "Cook" }));
  const kitchen = await screen.findByRole("region", { name: "Kitchen mode" });
  await within(kitchen).findByRole("heading", { name: "Curry" });
  return { user, kitchen };
}

test("kitchen mode loads its Recipe when another was the last one viewed", async () => {
  saveRecipe({ ...curry, id: 7, title: "Toast", steps: ["Butter it."] });
  const { kitchen } = await cookMonday();

  expect(within(kitchen).getByText("Fry the garlic.")).toBeTruthy();
});

test("kitchen mode walks the Recipe one step at a time", async () => {
  const { user, kitchen } = await cookMonday();

  expect(within(kitchen).getByText("Step 1 of 3")).toBeTruthy();
  expect(within(kitchen).getByText("Fry the garlic.")).toBeTruthy();
  expect(within(kitchen).queryByText("Add the coconut milk and simmer.")).toBeNull();
  // The first step has nowhere to go back to.
  expect(within(kitchen).queryByRole("button", { name: "Previous step" })).toBeNull();

  await user.click(within(kitchen).getByRole("button", { name: "Next step" }));
  expect(within(kitchen).getByText("Step 2 of 3")).toBeTruthy();
  expect(within(kitchen).getByText("Add the coconut milk and simmer.")).toBeTruthy();

  await user.click(within(kitchen).getByRole("button", { name: "Previous step" }));
  expect(within(kitchen).getByText("Fry the garlic.")).toBeTruthy();

  await user.click(within(kitchen).getByRole("button", { name: "Next step" }));
  await user.click(within(kitchen).getByRole("button", { name: "Next step" }));
  expect(within(kitchen).getByText("Serve over the rice.")).toBeTruthy();
  await user.click(within(kitchen).getByRole("button", { name: "Finish" }));

  expect(screen.queryByRole("region", { name: "Kitchen mode" })).toBeNull();
  expect(screen.getByRole("region", { name: "Monday, October 26" })).toBeTruthy();
});

test("Previous back to the first step by keyboard leaves focus on Next, not the page", async () => {
  const { user, kitchen } = await cookMonday();
  await user.click(within(kitchen).getByRole("button", { name: "Next step" }));

  within(kitchen).getByRole("button", { name: "Previous step" }).focus();
  await user.keyboard("{Enter}");

  expect(within(kitchen).getByText("Step 1 of 3")).toBeTruthy();
  expect(document.activeElement).toBe(within(kitchen).getByRole("button", { name: "Next step" }));
});

test("step progress shows as dots as well as in words, the current one filled", async () => {
  const { user, kitchen } = await cookMonday();
  // The dots repeat "Step 1 of 3" for the eye; a screen reader hears it once.
  const dots = kitchen.querySelector(".step-dots");
  const filled = () => Array.from(dots?.children ?? []).map((dot) => dot.classList.contains("step-dot-current"));

  expect(dots?.getAttribute("aria-hidden")).toBe("true");
  expect(filled()).toEqual([true, false, false]);
  await user.click(within(kitchen).getByRole("button", { name: "Next step" }));
  expect(filled()).toEqual([false, true, false]);
});

test("the Ingredients are one tap away, scaled to what the dinner is cooked for, Leftovers included", async () => {
  const { user, kitchen } = await cookMonday();

  await user.click(within(kitchen).getByRole("button", { name: "Ingredients" }));
  const list = within(kitchen).getByRole("list", { name: "Ingredients" });
  expect(within(kitchen).getByText("For 6. The Recipe makes 4.")).toBeTruthy();
  expect(
    within(list)
      .getAllByRole("listitem")
      .map((item) => item.textContent),
  ).toEqual(["3 cloves garlic, minced", "1½ cups rice", "600 ml coconut milk", "salt to taste"]);

  // Back to the step being cooked.
  await user.click(within(kitchen).getByRole("button", { name: "Back to the steps" }));
  expect(within(kitchen).getByText("Fry the garlic.")).toBeTruthy();
});

test("kitchen mode keeps the screen awake until it is left", async () => {
  const { request, release } = fakeWakeLock();
  const { user, kitchen } = await cookMonday();

  await vi.waitFor(() => expect(request).toHaveBeenCalledWith("screen"));
  expect(release).not.toHaveBeenCalled();

  await user.click(within(kitchen).getByRole("button", { name: "Leave kitchen mode" }));
  await vi.waitFor(() => expect(release).toHaveBeenCalled());
});

test("kitchen mode is high contrast", async () => {
  const { kitchen } = await cookMonday();
  expect(kitchen.closest("[data-theme]")?.getAttribute("data-theme")).toBe("kitchen");
});

/** Monday's Curry in Kitchen mode, with a mic for Voice Sessions. */
async function cookMondayTalking() {
  const user = userEvent.setup();
  const fake = householdClient();
  const calls = fakeVoice();
  render(() => <App client={fake.client} voice={calls.open} />);
  const monday = await screen.findByRole("region", { name: "Monday, October 26" });
  await user.click(within(monday).getByRole("button", { name: "Cook" }));
  const kitchen = await screen.findByRole("region", { name: "Kitchen mode" });
  await within(kitchen).findByRole("heading", { name: "Curry" });
  return { user, kitchen, fake, calls };
}

const MONDAY_DINNER = { date: "2026-10-26", meal: "dinner" } as const;

test("kitchen mode's mic starts a Voice Session over the step on screen, open until ended", async () => {
  const { user, kitchen, fake, calls } = await cookMondayTalking();
  await user.click(within(kitchen).getByRole("button", { name: "Next step" }));

  await user.click(await within(kitchen).findByRole("button", { name: "Talk to Mise" }));

  expect(await within(kitchen).findByText("Listening. Talk to Mise.")).toBeTruthy();
  expect(fake.voice.started).toEqual([{ screen: "kitchen", recipe: 2, slot: MONDAY_DINNER, step: 2 }]);
  expect(calls.calls[0]?.connected).toBe("answer to offer 1");
  // Open mic: nothing to hold while talking, only a way to end it.
  await user.click(within(kitchen).getByRole("button", { name: "End voice" }));

  expect(fake.voice.ended).toBe(1);
  await vi.waitFor(() => expect(calls.calls[0]?.hungUp).toBe(true));
  expect(within(kitchen).queryByText("Listening. Talk to Mise.")).toBeNull();
  expect(within(kitchen).getByRole("button", { name: "Talk to Mise" })).toBeTruthy();
});

test("kitchen mode moves to the step the agent read aloud, and the Voice Session moves with it", async () => {
  const { user, kitchen, fake } = await cookMondayTalking();
  await user.click(await within(kitchen).findByRole("button", { name: "Talk to Mise" }));
  await within(kitchen).findByText("Listening. Talk to Mise.");
  await user.click(within(kitchen).getByRole("button", { name: "Ingredients" }));

  fake.showStep(3);

  expect(await within(kitchen).findByText("Step 3 of 3")).toBeTruthy();
  expect(within(kitchen).getByText("Serve over the rice.")).toBeTruthy();
  await vi.waitFor(() =>
    expect(fake.voice.moved).toEqual([{ screen: "kitchen", recipe: 2, slot: MONDAY_DINNER, step: 3 }]),
  );
});

test("kitchen mode's Voice Session ends when the page is hidden, and when kitchen mode is left", async () => {
  const { user, kitchen, fake, calls } = await cookMondayTalking();
  await user.click(await within(kitchen).findByRole("button", { name: "Talk to Mise" }));
  await within(kitchen).findByText("Listening. Talk to Mise.");

  Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
  Reflect.deleteProperty(document, "visibilityState");

  expect(fake.voice.ended).toBe(1);
  await vi.waitFor(() => expect(calls.calls[0]?.hungUp).toBe(true));

  await user.click(within(kitchen).getByRole("button", { name: "Talk to Mise" }));
  await within(kitchen).findByText("Listening. Talk to Mise.");
  await user.click(within(kitchen).getByRole("button", { name: "Leave kitchen mode" }));

  expect(fake.voice.ended).toBe(2);
  await vi.waitFor(() => expect(calls.calls[1]?.hungUp).toBe(true));
});

test("kitchen mode cooked from a Recipe's page talks from the Recipe alone, with no Slot", async () => {
  const user = userEvent.setup();
  const fake = householdClient();
  const calls = fakeVoice();
  // As the Recipe's page opens it: no Slot, so no servings.
  render(() => <KitchenMode client={fake.client} id={2} locale="en-CA" voice={calls.open} onClose={() => {}} />);
  const kitchen = await screen.findByRole("region", { name: "Kitchen mode" });

  await user.click(await within(kitchen).findByRole("button", { name: "Talk to Mise" }));

  await vi.waitFor(() => expect(fake.voice.started).toEqual([{ screen: "kitchen", recipe: 2, step: 1 }]));
});

test("a change held during kitchen mode's Voice Session shows over the step, and a tap runs it", async () => {
  const { user, kitchen, fake } = await cookMondayTalking();
  await user.click(await within(kitchen).findByRole("button", { name: "Talk to Mise" }));
  await within(kitchen).findByText("Listening. Talk to Mise.");

  fake.conversation.push(
    { role: "member", speaker: "Robin", text: "Swap Thursday for the Dal." },
    { role: "confirmation", id: 7, summary: "Plan “Dal” for Thursday dinner", status: "pending" },
    { role: "agent", text: "Tap Plan Dal on the screen." },
  );
  fake.notify("chat");

  const held = await within(kitchen).findByRole("group", { name: "Tap to confirm" });
  // Over the step, which stays as it was.
  expect(within(kitchen).getByText("Step 1 of 3")).toBeTruthy();
  // The step's Next stays kitchen mode's one primary.
  expect([...kitchen.querySelectorAll(".button-primary")].map((primary) => primary.textContent)).toEqual(["Next step"]);
  await user.click(within(held).getByRole("button", { name: "Plan “Dal” for Thursday dinner" }));

  expect(fake.confirmed).toEqual([7]);
  await vi.waitFor(() => expect(within(kitchen).queryByRole("group", { name: "Tap to confirm" })).toBeNull());
});

test("a held change over the step goes when it's cancelled, by its own button or by voice", async () => {
  const { user, kitchen, fake } = await cookMondayTalking();
  await user.click(await within(kitchen).findByRole("button", { name: "Talk to Mise" }));
  await within(kitchen).findByText("Listening. Talk to Mise.");

  fake.conversation.push({ role: "confirmation", id: 7, summary: "Delete “Satay”", status: "pending" });
  fake.notify("chat");
  const held = await within(kitchen).findByRole("group", { name: "Tap to confirm" });
  await user.click(within(held).getByRole("button", { name: "Cancel: Delete “Satay”" }));

  expect(fake.cancelled).toEqual([7]);
  await vi.waitFor(() => expect(within(kitchen).queryByRole("group", { name: "Tap to confirm" })).toBeNull());

  // "Never mind": the agent cancels it, and the household announces the conversation.
  fake.conversation.push({ role: "confirmation", id: 8, summary: "Delete “Dal”", status: "pending" });
  fake.notify("chat");
  await within(kitchen).findByRole("button", { name: "Delete “Dal”" });
  fake.settle(8, "cancelled");
  fake.notify("chat");

  await vi.waitFor(() => expect(within(kitchen).queryByRole("group", { name: "Tap to confirm" })).toBeNull());
  expect(fake.confirmed).toEqual([]);
});

test("only a change held during the Voice Session shows over the step, and it stays until answered", async () => {
  const user = userEvent.setup();
  const fake = householdClient();
  const calls = fakeVoice();
  // Held from a chat before kitchen mode was opened.
  fake.conversation.push({ role: "confirmation", id: 3, summary: "Delete “Toast”", status: "pending" });
  render(() => <KitchenMode client={fake.client} id={2} locale="en-CA" voice={calls.open} onClose={() => {}} />);
  const kitchen = await screen.findByRole("region", { name: "Kitchen mode" });
  await user.click(await within(kitchen).findByRole("button", { name: "Talk to Mise" }));
  await within(kitchen).findByText("Listening. Talk to Mise.");

  fake.conversation.push({ role: "confirmation", id: 7, summary: "Delete “Satay”", status: "pending" });
  fake.notify("chat");
  const held = await within(kitchen).findByRole("group", { name: "Tap to confirm" });
  expect(within(held).queryByRole("button", { name: "Delete “Toast”" })).toBeNull();

  // Ended before the tap, the change still waits over the step: the cook asked for it.
  await user.click(within(kitchen).getByRole("button", { name: "End voice" }));
  await within(kitchen).findByRole("button", { name: "Talk to Mise" });
  await user.click(within(held).getByRole("button", { name: "Delete “Satay”" }));

  expect(fake.confirmed).toEqual([7]);
});

test("a tap over the step that's refused says why", async () => {
  const { user, kitchen, fake } = await cookMondayTalking();
  await user.click(await within(kitchen).findByRole("button", { name: "Talk to Mise" }));
  await within(kitchen).findByText("Listening. Talk to Mise.");
  fake.conversation.push({ role: "confirmation", id: 7, summary: "Delete “Satay”", status: "pending" });
  fake.notify("chat");
  const held = await within(kitchen).findByRole("group", { name: "Tap to confirm" });
  // Tapped on another device first.
  fake.client.confirm = async () => ({ ok: false, error: { code: "not_found", message: "Gone" } });

  await user.click(within(held).getByRole("button", { name: "Delete “Satay”" }));

  expect(await within(kitchen).findByText("That has already been done.")).toBeTruthy();
});

test("a change held just as the Voice Session ends still shows over the step, read after it ended", async () => {
  const { user, kitchen, fake } = await cookMondayTalking();
  await user.click(await within(kitchen).findByRole("button", { name: "Talk to Mise" }));
  await within(kitchen).findByText("Listening. Talk to Mise.");
  await user.click(within(kitchen).getByRole("button", { name: "End voice" }));
  await within(kitchen).findByRole("button", { name: "Talk to Mise" });

  // The agent's answer to the last spoken turn lands after the session ended.
  fake.conversation.push({ role: "confirmation", id: 7, summary: "Delete “Satay”", status: "pending" });
  fake.notify("chat");

  expect(await within(kitchen).findByRole("button", { name: "Delete “Satay”" })).toBeTruthy();
});
