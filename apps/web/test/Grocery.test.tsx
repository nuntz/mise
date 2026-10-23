import {
  addDays,
  currentWeekStart,
  DEFAULT_EFFORT_BUDGETS,
  type GroceryLine,
  type GroceryList,
  type Household,
  STORE_SECTIONS,
  type ToolResult,
} from "@mise/domain";
import { cleanup, render, screen, waitFor, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { App } from "../src/App";
import type { MiseClient } from "../src/client";
import { createFakeClient } from "./fakeClient";

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

const garlic: GroceryLine = {
  id: 1,
  origin: "recipe",
  item: "garlic",
  name: "garlic",
  amounts: [{ amount: { min: 3, max: 3 }, unit: "clove" }],
  unmeasured: false,
  recipes: [
    { id: 1, title: "Dal" },
    { id: 2, title: "Tacos" },
  ],
  have: false,
  haveAt: null,
};

const list: GroceryList = {
  startDate: "2026-10-26",
  builtAt: "2026-10-24T10:00:00.000Z",
  planChanged: true,
  staplesChanged: false,
  sections: [
    {
      section: "produce",
      lines: [
        garlic,
        { ...garlic, id: 3, origin: "manual", item: "lemon", name: "2 lemons", amounts: [], recipes: [] },
      ],
    },
    {
      section: "spices",
      lines: [
        {
          ...garlic,
          id: 2,
          item: "salt",
          name: "salt",
          amounts: [{ amount: { min: 2, max: 3 }, unit: "ml" }],
          unmeasured: true,
          recipes: [{ id: 1, title: "Dal" }],
          have: true,
        },
      ],
    },
    { section: "other", lines: [{ ...garlic, id: 4, item: null, name: "8 corn tortillas", amounts: [] }] },
  ],
};

type Answer = (input: Record<string, unknown>) => ToolResult<unknown> | undefined;

/**
 * A client with `list` as this Week's Grocery List, unless `answers` say otherwise; it records every
 * call that reaches the household. `goOnline` and `goOffline` stand in for the connection; offline,
 * every call fails.
 */
function fakeClient(answers: Record<string, Answer> = {}, { online = true } = {}) {
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const fake = createFakeClient(
    async (name: string, input: Record<string, unknown>) => {
      calls.push({ name, input });
      const answer = answers[name]?.(input);
      if (answer) return answer;
      switch (name) {
        case "get_household":
          return { ok: true, value: household };
        case "get_week":
          return { ok: false, error: { code: "not_found", message: "" } };
        case "list_items":
          return { ok: true, value: [] };
        case "get_grocery_list":
        case "build_grocery_list":
          return { ok: true, value: list };
        case "set_have_tick":
        case "add_grocery_line":
          return { ok: true, value: garlic };
        case "set_store_section_order":
          return { ok: true, value: input.sections };
        default:
          throw new Error(`Unexpected tool ${name}`);
      }
    },
    { online },
  );
  return { client: fake.client, calls, goOnline: fake.goOnline, goOffline: fake.goOffline };
}

async function openGroceryList(client: MiseClient) {
  const user = userEvent.setup();
  render(() => <App client={client} />);
  await user.click(await screen.findByRole("button", { name: "Groceries" }));
  return user;
}

test("a Week without a Grocery List offers to build one", async () => {
  const { client, calls } = fakeClient({ get_grocery_list: () => ({ ok: true, value: null }) });
  const user = await openGroceryList(client);

  expect(await screen.findByText("No Grocery List for this Week yet.")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Build the Grocery List" }));

  expect(calls.find((call) => call.name === "build_grocery_list")?.input).toHaveProperty("date");
});

test("lines are grouped by Store Section, with what they're for, and say when the plan changed", async () => {
  const { client, calls } = fakeClient();
  const user = await openGroceryList(client);

  const produce = await screen.findByRole("region", { name: "Produce" });
  expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual([
    "Produce",
    "Spices",
    "Other",
  ]);
  expect(within(produce).getByRole("checkbox", { name: "3 clove garlic" })).toBeTruthy();
  expect(within(produce).getAllByText("For Dal, Tacos")).toHaveLength(1);
  expect(within(screen.getByRole("region", { name: "Other" })).getByText(/not scaled to who's eating/)).toBeTruthy();
  const salt = within(screen.getByRole("region", { name: "Spices" })).getByRole("checkbox", {
    name: "2–3 ml salt and some to taste",
  }) as HTMLInputElement;
  expect(salt.checked).toBe(true);

  expect(screen.getByRole("alert").textContent).toContain("The plan changed since this list was built.");
  await user.click(screen.getByRole("button", { name: "Rebuild" }));
  expect(calls.filter((call) => call.name === "build_grocery_list")).toHaveLength(1);
});

test("ticking a line sets its Have Tick, as of now", async () => {
  const { client, calls } = fakeClient();
  const user = await openGroceryList(client);

  const before = Date.now();
  await user.click(await screen.findByRole("checkbox", { name: "3 clove garlic" }));

  await waitFor(() => expect(calls.some((call) => call.name === "set_have_tick")).toBe(true));
  const tick = calls.find((call) => call.name === "set_have_tick")?.input;
  expect(tick).toMatchObject({ line: 1, have: true });
  expect(Date.parse(String(tick?.at))).toBeGreaterThanOrEqual(before);
});

test("lines can be added by hand", async () => {
  const { client, calls } = fakeClient();
  const user = await openGroceryList(client);

  await user.click(await screen.findByRole("button", { name: "Add a line" }));
  await user.type(screen.getByLabelText("Add a line"), "2 lemons");
  await user.click(screen.getByRole("button", { name: "Add" }));

  await waitFor(() =>
    expect(calls.find((call) => call.name === "add_grocery_line")?.input).toEqual({
      date: "2026-10-26",
      text: "2 lemons",
      key: expect.any(String),
    }),
  );
});

test("offline, ticks and added lines show at once, wait as changes to sync, and are sent on reconnect", async () => {
  const { client, calls, goOnline, goOffline } = fakeClient();
  const user = await openGroceryList(client);
  const garlicBox = (await screen.findByRole("checkbox", { name: "3 clove garlic" })) as HTMLInputElement;

  goOffline();
  expect(await screen.findByText(/Offline/)).toBeTruthy();
  await user.click(garlicBox);
  await user.click(screen.getByRole("button", { name: "Add a line" }));
  await user.type(screen.getByLabelText("Add a line"), "2 lemons");
  await user.click(screen.getByRole("button", { name: "Add" }));

  expect(garlicBox.checked).toBe(true);
  const waiting = screen.getByRole("region", { name: "Waiting to sync" });
  await user.click(within(waiting).getByRole("checkbox", { name: "2 lemons" }));
  expect(screen.getByText("3 changes waiting to sync")).toBeTruthy();
  // Rebuilding needs the household, so it waits for the connection.
  expect((screen.getByRole("button", { name: "Rebuild" }) as HTMLButtonElement).disabled).toBe(true);
  const writes = () => calls.filter((call) => call.name === "set_have_tick" || call.name === "add_grocery_line");
  expect(writes()).toEqual([]);

  goOnline();
  await waitFor(() => expect(screen.queryByText(/waiting to sync/)).toBeNull());
  expect(calls.find((call) => call.name === "add_grocery_line")?.input).toMatchObject({ text: "2 lemons" });
  // The garlic tick, then the lemons' tick on the line the household added (`garlic` stands in for it).
  expect(calls.filter((call) => call.name === "set_have_tick").map((call) => call.input)).toMatchObject([
    { line: 1, have: true },
    { line: 1, have: true },
  ]);
});

test("the Household and both Weeks' Grocery Lists open offline from what was last loaded", async () => {
  const thisWeek = currentWeekStart(new Date(), household.timezone, household.weekStartsOn);
  const nextWeek: GroceryList = { ...list, sections: list.sections.slice(2) };
  const answers = {
    get_grocery_list: (input: Record<string, unknown>) =>
      ({ ok: true, value: input.date === thisWeek ? list : nextWeek }) as const,
  };
  const online = fakeClient(answers);
  render(() => <App client={online.client} />);
  await screen.findByRole("button", { name: "Groceries" });
  await waitFor(() =>
    expect(online.calls.filter((call) => call.name === "get_grocery_list").map((call) => call.input.date)).toEqual(
      expect.arrayContaining([thisWeek, addDays(thisWeek, 7)]),
    ),
  );

  // Let the answers arrive before the app closes.
  await new Promise((resolve) => setTimeout(resolve));
  cleanup();

  const user = await openGroceryList(fakeClient(answers, { online: false }).client);
  expect(await screen.findByRole("checkbox", { name: "3 clove garlic" })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Next Week" }));
  expect(await screen.findByRole("checkbox", { name: "8 corn tortillas" })).toBeTruthy();
  expect(screen.queryByRole("checkbox", { name: "3 clove garlic" })).toBeNull();

  await user.click(screen.getByRole("button", { name: "Week" }));
  await user.click(screen.getByRole("button", { name: "Household" }));
  expect(screen.getByRole("heading", { name: "The Tremblays" })).toBeTruthy();
});

test("the Store Sections can be put in walking order", async () => {
  const { client, calls } = fakeClient();
  const user = await openGroceryList(client);

  await user.click(await screen.findByRole("button", { name: "Walking order" }));
  await user.click(screen.getByRole("button", { name: "Move Bakery up" }));

  expect(calls.find((call) => call.name === "set_store_section_order")?.input).toEqual({
    sections: ["bakery", "produce", ...STORE_SECTIONS.slice(2)],
  });
});

test("a Staple's line says so, and the list says when Staples have run low since it was built", async () => {
  const withStaple: GroceryList = {
    ...list,
    planChanged: false,
    staplesChanged: true,
    sections: [
      {
        section: "pantry",
        lines: [{ ...garlic, id: 5, origin: "staple", item: "rice", name: "rice", amounts: [], recipes: [] }],
      },
    ],
  };
  const { client } = fakeClient({ get_grocery_list: () => ({ ok: true, value: withStaple }) });
  await openGroceryList(client);

  const pantry = await screen.findByRole("region", { name: "Pantry" });
  expect(within(pantry).getByText("Staple")).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toContain("Some Staples have run low or out");
});
