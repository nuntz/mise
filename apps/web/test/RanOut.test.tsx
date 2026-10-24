import {
  DEFAULT_EFFORT_BUDGETS,
  type Household,
  ITEMS,
  STORE_SECTIONS,
  type Staple,
  type StapleStatus,
} from "@mise/domain";
import { render, screen, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
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
const egg: Staple = { ...rice, item: "egg", name: "egg", location: "fridge" };
const milk: Staple = { ...rice, item: "milk", name: "milk", location: "fridge" };

/**
 * A client whose Staples are rice, egg and milk, each due while stocked. Recording a status changes
 * the Staple and sends a `grocery` change notice, as the household does.
 */
function fakeClient() {
  const staples = new Map<string, Staple>([rice, egg, milk].map((staple) => [staple.item, staple]));
  const recorded: { item: unknown; status: unknown; at: unknown }[] = [];
  const fake = createFakeClient(async (name, input) => {
    switch (name) {
      case "get_household":
        return { ok: true, value: household };
      case "get_caller":
        return { ok: true, value: null };
      case "get_week":
        return { ok: false, error: { code: "not_found", message: "" } };
      case "get_grocery_list":
        return { ok: true, value: null };
      case "search_recipes":
        return { ok: true, value: [] };
      case "list_items":
        return { ok: true, value: ITEMS };
      case "list_staples":
        return { ok: true, value: [...staples.values()] };
      case "list_due_staples": {
        const due = [...staples.values()].filter((staple) => staple.status === "stocked");
        return { ok: true, value: { due: due.length, staples: due } };
      }
      case "record_staple_status": {
        recorded.push({ item: input.item, status: input.status, at: input.at });
        const staple = staples.get(String(input.item)) as Staple;
        const changed = { ...staple, status: input.status as StapleStatus };
        staples.set(staple.item, changed);
        queueMicrotask(() => fake.notify("grocery"));
        return { ok: true, value: changed };
      }
      default:
        throw new Error(`Unexpected tool ${name}`);
    }
  });
  return { ...fake, recorded };
}

test("every screen's header has a Ran out action", async () => {
  const { client } = fakeClient();
  const user = userEvent.setup();
  render(() => <App client={client} />);

  const nav = await screen.findByRole("navigation", { name: "Main" });
  for (const page of ["Week", "Recipes", "Groceries", "Pantry"]) {
    await user.click(within(nav).getByRole("button", { name: page }));
    const headers = screen.getAllByRole("banner");
    expect(headers.filter((header) => within(header).queryByRole("button", { name: "Ran out" }))).toHaveLength(1);
  }
});

test("Ran out finds a Staple by search and records it out", async () => {
  const { client, recorded } = fakeClient();
  const user = userEvent.setup();
  render(() => <App client={client} />);

  await user.click(await screen.findByRole("button", { name: "Ran out" }));
  const picker = await screen.findByRole("dialog", { name: "What ran out?" });
  expect(await within(picker).findByRole("group", { name: "rice" })).toBeTruthy();
  expect(within(picker).getByRole("group", { name: "milk" })).toBeTruthy();
  await user.type(within(picker).getByRole("searchbox", { name: "Find a Staple" }), "EG");

  expect(within(picker).queryByRole("group", { name: "rice" })).toBeNull();
  expect(within(picker).queryByRole("group", { name: "milk" })).toBeNull();
  const before = Date.now();
  await user.click(within(within(picker).getByRole("group", { name: "egg" })).getByRole("button", { name: "Out" }));

  expect(recorded).toEqual([{ item: "egg", status: "out", at: expect.any(String) }]);
  expect(Date.parse(String(recorded[0]?.at))).toBeGreaterThanOrEqual(before);
  expect(await screen.findByText("egg is out. It goes on the next Grocery List.")).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("Ran out can record a Staple low", async () => {
  const { client, recorded } = fakeClient();
  const user = userEvent.setup();
  render(() => <App client={client} />);

  await user.click(await screen.findByRole("button", { name: "Ran out" }));
  const picker = await screen.findByRole("dialog", { name: "What ran out?" });
  await user.click(
    within(await within(picker).findByRole("group", { name: "rice" })).getByRole("button", { name: "Low" }),
  );

  expect(recorded.map(({ item, status }) => ({ item, status }))).toEqual([{ item: "rice", status: "low" }]);
  expect(await screen.findByText("rice is low. It goes on the next Grocery List.")).toBeTruthy();
});

test("the Pantry page and its check-in show a Staple recorded from Ran out straight away", async () => {
  const { client } = fakeClient();
  const user = userEvent.setup();
  render(() => <App client={client} />);
  await user.click(await screen.findByRole("button", { name: "Pantry" }));
  expect(await screen.findByRole("heading", { name: "3 to check" })).toBeTruthy();

  await user.click(screen.getByRole("button", { name: "Ran out" }));
  const picker = await screen.findByRole("dialog", { name: "What ran out?" });
  await user.click(
    within(await within(picker).findByRole("group", { name: "milk" })).getByRole("button", { name: "Out" }),
  );

  expect(await screen.findByRole("heading", { name: "2 to check" })).toBeTruthy();
  const staples = screen.getByRole("region", { name: "Staples" });
  expect(await within(staples).findByText("milk · Fridge · every 14 days · Out")).toBeTruthy();
});

test("offline, Ran out says it needs a connection and can't be opened", async () => {
  const { client, goOffline } = fakeClient();
  render(() => <App client={client} />);
  const action = await screen.findByRole("button", { name: "Ran out" });
  goOffline();

  expect((action as HTMLButtonElement).disabled).toBe(true);
  const hint = document.getElementById(String(action.getAttribute("aria-describedby")));
  expect(hint?.textContent).toBe("Recording a Staple needs a connection.");
});

test("losing the connection with the picker open stops Staples being recorded", async () => {
  const { client, goOffline } = fakeClient();
  const user = userEvent.setup();
  render(() => <App client={client} />);

  await user.click(await screen.findByRole("button", { name: "Ran out" }));
  const picker = await screen.findByRole("dialog", { name: "What ran out?" });
  const rice = await within(picker).findByRole("group", { name: "rice" });
  goOffline();

  expect(await within(picker).findByText("Recording a Staple needs a connection.")).toBeTruthy();
  expect((within(rice).getByRole("button", { name: "Out" }) as HTMLButtonElement).disabled).toBe(true);
});
