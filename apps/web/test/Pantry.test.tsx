import {
  DEFAULT_EFFORT_BUDGETS,
  type DueStaples,
  type Household,
  ITEMS,
  STORE_SECTIONS,
  type Staple,
  type ToolResult,
} from "@mise/domain";
import { render, screen, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { expect, onTestFinished, test, vi } from "vitest";
import { App } from "../src/App";
import type { MiseClient } from "../src/client";
import { createFakeClient } from "./fakeClient";
import { primaries } from "./primaries";

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

const rice: Staple = {
  item: "rice",
  name: "rice",
  location: "pantry",
  checkEvery: 14,
  alwaysBuy: false,
  qtyPerShop: null,
  status: "stocked",
  lastChecked: null,
  outInARow: 0,
  suggestAlwaysBuy: false,
};
const egg: Staple = {
  ...rice,
  item: "egg",
  name: "egg",
  location: "fridge",
  checkEvery: "every_shop",
  qtyPerShop: { amount: { min: 12, max: 12 }, unit: null },
  status: "low",
  outInARow: 2,
};
const milk: Staple = { ...rice, item: "milk", name: "milk", location: "fridge", alwaysBuy: true };

type Answer = (input: Record<string, unknown>) => ToolResult<unknown> | Promise<ToolResult<unknown>> | undefined;

/** A client with rice and eggs due, unless `answers` say otherwise; it records every call. */
function fakeClient(answers: Record<string, Answer> = {}) {
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const { client, goOffline, notify } = createFakeClient(async (name: string, input: Record<string, unknown>) => {
    calls.push({ name, input });
    const answer = answers[name]?.(input);
    if (answer) return answer;
    switch (name) {
      case "get_household":
        return { ok: true, value: household };
      case "get_week":
        return { ok: false, error: { code: "not_found", message: "" } };
      case "list_items":
        return { ok: true, value: ITEMS };
      case "list_due_staples":
        return { ok: true, value: { due: 2, staples: [rice, egg] } satisfies DueStaples };
      case "list_staples":
        return { ok: true, value: [rice, egg, milk] };
      case "record_staple_status":
      case "upsert_staple":
      case "remove_staple":
        return { ok: true, value: rice };
      default:
        throw new Error(`Unexpected tool ${name}`);
    }
  });
  return { client, calls, goOffline, notify };
}

const writes = (calls: { name: string; input: Record<string, unknown> }[]) =>
  calls.filter((call) => !/^(get|list)_/.test(call.name));

test("a banner says when a pantry check is due, and opens it", async () => {
  const { client } = fakeClient();
  const user = userEvent.setup();
  render(() => <App client={client} />);

  const banner = await screen.findByRole("status");
  expect(banner.textContent).toContain("Pantry check: 2 Staples");
  await user.click(within(banner).getByRole("button", { name: "Check now" }));

  expect(await screen.findByRole("heading", { name: "2 to check" })).toBeTruthy();
});

test("offline, the banner's Check now says it needs a connection: answering isn't kept to sync later", async () => {
  const { client, goOffline } = fakeClient();
  render(() => <App client={client} />);
  const banner = await screen.findByRole("status");
  const check = within(banner).getByRole("button", { name: "Check now" }) as HTMLButtonElement;

  goOffline();

  expect(check.disabled).toBe(true);
  const reason = document.getElementById(String(check.getAttribute("aria-describedby")));
  expect(reason?.textContent).toBe("Needs a connection.");
  expect(check.nextElementSibling).toBe(reason);
});

test("the banner shows on Week only: Pantry says how many are due in its heading", async () => {
  const { client } = fakeClient({
    search_recipes: () => ({ ok: true, value: [] }),
    get_grocery_list: () => ({ ok: true, value: null }),
    get_caller: () => ({ ok: true, value: null }),
  });
  const user = userEvent.setup();
  render(() => <App client={client} />);
  const banner = () => screen.queryByText("Pantry check: 2 Staples");

  expect(await screen.findByText("Pantry check: 2 Staples")).toBeTruthy();
  for (const page of ["Recipes", "Groceries", "Pantry", "Household"]) {
    await user.click(screen.getByRole("button", { name: page }));
    expect(banner(), page).toBeNull();
  }
  await user.click(screen.getByRole("button", { name: "Week" }));
  expect(await screen.findByText("Pantry check: 2 Staples")).toBeTruthy();
});

test("a link to the pantry check, as its notification gives, opens it", async () => {
  window.history.replaceState(null, "", "/?pantry");
  onTestFinished(() => window.history.replaceState(null, "", "/"));
  render(() => <App client={fakeClient().client} />);

  expect(await screen.findByRole("heading", { name: "2 to check" })).toBeTruthy();
  expect(window.location.search).toBe("");
});

test("no banner when nothing is due", async () => {
  const { client } = fakeClient({ list_due_staples: () => ({ ok: true, value: { due: 0, staples: [] } }) });
  render(() => <App client={client} />);

  await screen.findByRole("button", { name: "Pantry" });
  expect(screen.queryByRole("status")).toBeNull();
});

async function openPantry(client: MiseClient) {
  const user = userEvent.setup();
  render(() => <App client={client} />);
  await user.click(await screen.findByRole("button", { name: "Pantry" }));
  return user;
}

test("the check-in asks about each due Staple in turn, as tap-through cards", async () => {
  const { client, calls } = fakeClient();
  const user = await openPantry(client);
  await user.click(await screen.findByRole("button", { name: "Start the pantry check" }));

  const first = screen.getByRole("group", { name: "Rice" });
  expect(within(first).getByText("1 of 2 · Pantry")).toBeTruthy();
  const before = Date.now();
  await user.click(within(first).getByRole("button", { name: "Stocked" }));

  const second = await screen.findByRole("group", { name: "Egg" });
  expect(within(second).getByText("2 of 2 · Fridge")).toBeTruthy();
  await user.click(within(second).getByRole("button", { name: "Out" }));

  expect(await screen.findByText("All checked.")).toBeTruthy();
  const recorded = writes(calls);
  expect(recorded.map((call) => [call.input.item, call.input.status])).toEqual([
    ["rice", "stocked"],
    ["egg", "out"],
  ]);
  expect(Date.parse(String(recorded[0]?.input.at))).toBeGreaterThanOrEqual(before);
});

test("a Staple out three times in a row is suggested for always buying", async () => {
  const { client, calls } = fakeClient({
    record_staple_status: (input) =>
      input.item === "egg"
        ? { ok: true, value: { ...egg, status: "out", outInARow: 3, suggestAlwaysBuy: true } }
        : undefined,
  });
  const user = await openPantry(client);
  await user.click(await screen.findByRole("button", { name: "Start the pantry check" }));
  await user.click(within(screen.getByRole("group", { name: "Rice" })).getByRole("button", { name: "Low" }));
  await user.click(within(await screen.findByRole("group", { name: "Egg" })).getByRole("button", { name: "Out" }));

  expect(await screen.findByText("egg has run out three checks in a row. Always buy it?")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Always buy egg" }));

  expect(writes(calls).at(-1)).toEqual({ name: "upsert_staple", input: { item: "egg", alwaysBuy: true } });
});

test("lists the Staples as rows, each with its status as a chip and Edit as its one action", async () => {
  const { client } = fakeClient();
  await openPantry(client);

  const staples = await screen.findByRole("region", { name: "Staples" });
  await within(staples).findByText("Rice");
  const rice = stapleRow(staples, "Rice");
  expect(within(rice).getByText("Pantry · every 14 days")).toBeTruthy();
  expect(within(rice).getByText("Stocked").className).toBe("chip chip-leaf");
  const egg = stapleRow(staples, "Egg");
  expect(within(egg).getByText("Fridge · every shop · 12 per shop")).toBeTruthy();
  expect(within(egg).getByText("Low").className).toBe("chip chip-amber");
  expect(within(stapleRow(staples, "Milk")).getByText("Fridge · always bought")).toBeTruthy();

  expect(
    within(rice)
      .getAllByRole("button")
      .map((button) => button.textContent),
  ).toEqual(["Edit"]);
  expect(within(staples).queryByRole("button", { name: /^Remove/ })).toBeNull();
});

test("a Staple is changed and removed from its edit view", async () => {
  const { client, calls } = fakeClient();
  const user = await openPantry(client);
  const staples = await screen.findByRole("region", { name: "Staples" });
  await screen.findByText("Egg");

  await user.click(within(staples).getByRole("button", { name: "Edit egg" }));
  const editEgg = within(staples).getByRole("form", { name: "Edit egg" });
  await user.click(within(editEgg).getByRole("checkbox", { name: "Every shop" }));
  await user.clear(within(editEgg).getByRole("spinbutton", { name: "Check every (days)" }));
  await user.type(within(editEgg).getByRole("spinbutton", { name: "Check every (days)" }), "7");
  await user.click(within(editEgg).getByRole("button", { name: "Save" }));

  await user.click(within(staples).getByRole("button", { name: "Edit rice" }));
  const editRice = within(staples).getByRole("form", { name: "Edit rice" });
  await user.click(within(editRice).getByRole("button", { name: "Remove rice" }));

  await vi.waitFor(() =>
    expect(writes(calls)).toEqual([
      {
        name: "upsert_staple",
        input: {
          item: "egg",
          location: "fridge",
          checkEvery: 7,
          alwaysBuy: false,
          qtyPerShop: { amount: { min: 12, max: 12 }, unit: null },
        },
      },
      { name: "remove_staple", input: { item: "rice" } },
    ]),
  );
});

test("a change elsewhere doesn't reset a Staple being edited", async () => {
  let eggStatus: Staple["status"] = "low";
  const fake = fakeClient({ list_staples: () => ({ ok: true, value: [rice, { ...egg, status: eggStatus }, milk] }) });
  const user = await openPantry(fake.client);
  const staples = await screen.findByRole("region", { name: "Staples" });
  await within(staples).findByText("Egg");
  await user.click(within(staples).getByRole("button", { name: "Edit egg" }));
  const form = () => within(within(staples).getByRole("form", { name: "Edit egg" }));
  const days = () => form().getByRole("spinbutton", { name: "Check every (days)" }) as HTMLInputElement;
  await user.click(form().getByRole("checkbox", { name: "Every shop" }));
  await user.clear(days());
  await user.type(days(), "7");

  // Another device records egg out; the refetch shows it while the edit is open.
  eggStatus = "out";
  fake.notify("grocery");

  expect(await form().findByText("Out")).toBeTruthy();
  expect(days().value).toBe("7");
});

test.each(["upsert_staple", "remove_staple"])(
  "a late %s closes only its own Staple's form, leaving another's open with its draft",
  async (tool) => {
    let finish = (_: ToolResult<unknown>) => {};
    const fake = fakeClient({ [tool]: () => new Promise((resolve) => (finish = resolve)) });
    const user = await openPantry(fake.client);
    const staples = await screen.findByRole("region", { name: "Staples" });
    await user.click(await within(staples).findByRole("button", { name: "Edit rice" }));
    const riceForm = within(within(staples).getByRole("form", { name: "Edit rice" }));
    await user.click(riceForm.getByRole("button", { name: tool === "upsert_staple" ? "Save" : "Remove rice" }));
    await user.click(riceForm.getByRole("button", { name: "Cancel" }));
    await user.click(within(staples).getByRole("button", { name: "Edit egg" }));
    const egg = within(within(staples).getByRole("form", { name: "Edit egg" }));
    const days = egg.getByRole("spinbutton", { name: "Check every (days)" }) as HTMLInputElement;
    await user.click(egg.getByRole("checkbox", { name: "Every shop" }));
    await user.clear(days);
    await user.type(days, "7");
    expect(writes(fake.calls).map((call) => call.name)).toEqual([tool]);

    finish({ ok: true, value: rice });
    await new Promise((resolve) => setTimeout(resolve));

    expect(within(staples).getByRole("form", { name: "Edit egg" })).toBeTruthy();
    expect(days.value).toBe("7");
  },
);

test("a save that finishes while its own Staple is still open closes it", async () => {
  let finish = (_: ToolResult<unknown>) => {};
  const fake = fakeClient({ upsert_staple: () => new Promise((resolve) => (finish = resolve)) });
  const user = await openPantry(fake.client);
  const staples = await screen.findByRole("region", { name: "Staples" });
  await user.click(await within(staples).findByRole("button", { name: "Edit rice" }));
  await user.click(
    within(within(staples).getByRole("form", { name: "Edit rice" })).getByRole("button", { name: "Save" }),
  );

  finish({ ok: true, value: rice });

  await vi.waitFor(() => expect(within(staples).queryByRole("form", { name: "Edit rice" })).toBeNull());
});

test("a Staple is added from a form headed Add a Staple, whose Unit starts at Count", async () => {
  const { client, calls } = fakeClient();
  const user = await openPantry(client);

  const form = await screen.findByRole("form", { name: "Add a Staple" });
  expect(within(form).getByRole("heading", { name: "Add a Staple" })).toBeTruthy();
  const unit = within(form).getByRole("combobox", { name: "Unit" }) as HTMLSelectElement;
  expect(unit.selectedOptions[0]?.textContent).toBe("Count");

  await user.type(within(form).getByRole("combobox", { name: "Item" }), "Butter");
  await user.selectOptions(within(form).getByRole("combobox", { name: "Kept in" }), "fridge");
  await user.click(within(form).getByRole("checkbox", { name: "Always buy" }));
  await user.type(within(form).getByRole("spinbutton", { name: "Usual quantity" }), "454");
  await user.selectOptions(unit, "g");
  await user.click(within(form).getByRole("button", { name: "Add Staple" }));

  await vi.waitFor(() =>
    expect(writes(calls)).toEqual([
      {
        name: "upsert_staple",
        input: {
          item: "butter",
          location: "fridge",
          checkEvery: 14,
          alwaysBuy: true,
          qtyPerShop: { amount: { min: 454, max: 454 }, unit: "g" },
        },
      },
    ]),
  );
});

test("how many Staples are due is said once, in the heading", async () => {
  const { client } = fakeClient();
  await openPantry(client);

  expect(await screen.findByRole("heading", { name: "2 to check" })).toBeTruthy();
  expect(screen.queryByText("2 Staples are due for a check.")).toBeNull();
  expect(screen.queryByText("Pantry check: 2 Staples")).toBeNull();
  expect(primaries()).toEqual(["Start the pantry check"]);
});

/** The row of the Staple shown as `name` in the list. */
function stapleRow(staples: HTMLElement, name: string): HTMLElement {
  const found = within(staples)
    .getAllByRole("listitem")
    .find((item) => within(item).queryByText(name));
  if (!found) throw new Error(`No Staple row for ${name}`);
  return found;
}

test("an Item that isn't in the catalogue can't be made a Staple", async () => {
  const { client, calls } = fakeClient();
  const user = await openPantry(client);
  const form = await screen.findByRole("form", { name: "Add a Staple" });

  await user.type(within(form).getByRole("combobox", { name: "Item" }), "unobtainium");
  await user.click(within(form).getByRole("button", { name: "Add Staple" }));

  expect(within(form).getByRole("alert").textContent).toContain("No Item is called “unobtainium”");
  expect(writes(calls)).toEqual([]);
});
