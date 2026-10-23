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
import { expect, test, vi } from "vitest";
import { App } from "../src/App";
import type { MiseClient } from "../src/client";

const household: Household = {
  name: "The Tremblays",
  timezone: "America/Vancouver",
  dinnerTime: "18:00",
  weekStartsOn: "monday",
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

type Answer = (input: Record<string, unknown>) => ToolResult<unknown> | undefined;

/** A client with rice and eggs due, unless `answers` say otherwise; it records every call. */
function fakeClient(answers: Record<string, Answer> = {}) {
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const client: MiseClient = {
    call: (async (name: string, input: Record<string, unknown>) => {
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
    }) as MiseClient["call"],
    subscribe(_topic, refetch) {
      queueMicrotask(refetch);
      return () => {};
    },
    photoUrl: (id, key) => `/photos/${id}?v=${key}`,
    uploadPhoto: async () => true,
    removePhoto: async () => true,
    uploadExport: async () => null,
    onConnection(listener) {
      listener(true);
      return () => {};
    },
    close() {},
  };
  return { client, calls };
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

  expect(await screen.findByRole("heading", { name: "Pantry check" })).toBeTruthy();
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

  const first = screen.getByRole("group", { name: "rice" });
  expect(within(first).getByText("1 of 2 · Pantry")).toBeTruthy();
  const before = Date.now();
  await user.click(within(first).getByRole("button", { name: "Stocked" }));

  const second = await screen.findByRole("group", { name: "egg" });
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
  await user.click(within(screen.getByRole("group", { name: "rice" })).getByRole("button", { name: "Low" }));
  await user.click(within(await screen.findByRole("group", { name: "egg" })).getByRole("button", { name: "Out" }));

  expect(await screen.findByText("egg has run out three checks in a row. Always buy it?")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Always buy egg" }));

  expect(writes(calls).at(-1)).toEqual({ name: "upsert_staple", input: { item: "egg", alwaysBuy: true } });
});

test("lists the Staples, and adds, changes and removes them", async () => {
  const { client, calls } = fakeClient();
  const user = await openPantry(client);

  const staples = await screen.findByRole("region", { name: "Staples" });
  expect(within(staples).getByText("rice · Pantry · every 14 days · Stocked")).toBeTruthy();
  expect(within(staples).getByText("egg · Fridge · every shop · Low · 12 per shop")).toBeTruthy();
  expect(within(staples).getByText("milk · Fridge · always bought · Stocked")).toBeTruthy();

  const form = within(staples).getByRole("form", { name: "Add or change a Staple" });
  await user.type(within(form).getByRole("combobox", { name: "Item" }), "Butter");
  await user.selectOptions(within(form).getByRole("combobox", { name: "Kept in" }), "fridge");
  await user.click(within(form).getByRole("checkbox", { name: "Always buy" }));
  await user.type(within(form).getByRole("spinbutton", { name: "Usual quantity" }), "454");
  await user.selectOptions(within(form).getByRole("combobox", { name: "Unit" }), "g");
  await user.click(within(form).getByRole("button", { name: "Save" }));

  await user.click(within(staples).getByRole("button", { name: "Edit egg" }));
  await user.click(within(form).getByRole("checkbox", { name: "Every shop" }));
  await user.clear(within(form).getByRole("spinbutton", { name: "Check every (days)" }));
  await user.type(within(form).getByRole("spinbutton", { name: "Check every (days)" }), "7");
  await user.click(within(form).getByRole("button", { name: "Save" }));

  await user.click(within(staples).getByRole("button", { name: "Remove rice" }));

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

test("an Item that isn't in the catalogue can't be made a Staple", async () => {
  const { client, calls } = fakeClient();
  const user = await openPantry(client);
  const form = await screen.findByRole("form", { name: "Add or change a Staple" });

  await user.type(within(form).getByRole("combobox", { name: "Item" }), "unobtainium");
  await user.click(within(form).getByRole("button", { name: "Save" }));

  expect(within(form).getByRole("alert").textContent).toContain("No Item is called “unobtainium”");
  expect(writes(calls)).toEqual([]);
});
