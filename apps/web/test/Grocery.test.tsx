import {
  DEFAULT_EFFORT_BUDGETS,
  type GroceryLine,
  type GroceryList,
  type Household,
  STORE_SECTIONS,
  type ToolResult,
} from "@mise/domain";
import { render, screen, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
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

/** A client with `list` as this Week's Grocery List, unless `answers` say otherwise; it records every call. */
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
    }) as MiseClient["call"],
    subscribe(_topic, refetch) {
      queueMicrotask(refetch);
      return () => {};
    },
    photoUrl: (id, key) => `/photos/${id}?v=${key}`,
    uploadPhoto: async () => true,
    removePhoto: async () => true,
    uploadExport: async () => null,
    close() {},
  };
  return { client, calls };
}

async function openGroceryList(client: MiseClient) {
  const user = userEvent.setup();
  render(() => <App client={client} />);
  await user.click(await screen.findByRole("button", { name: "Grocery List" }));
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
  expect(screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual([
    "Produce",
    "Spices",
    "Other",
  ]);
  expect(within(produce).getByRole("checkbox", { name: "garlic: 3 clove" })).toBeTruthy();
  expect(within(produce).getAllByText("For Dal, Tacos")).toHaveLength(1);
  expect(within(screen.getByRole("region", { name: "Other" })).getByText(/not scaled to who's eating/)).toBeTruthy();
  const salt = within(screen.getByRole("region", { name: "Spices" })).getByRole("checkbox", {
    name: "salt: 2–3 ml, and some to taste",
  }) as HTMLInputElement;
  expect(salt.checked).toBe(true);

  expect(screen.getByRole("alert").textContent).toContain("The plan changed since this list was built.");
  await user.click(screen.getByRole("button", { name: "Rebuild the Grocery List" }));
  expect(calls.filter((call) => call.name === "build_grocery_list")).toHaveLength(1);
});

test("ticking a line sets its Have Tick, as of now", async () => {
  const { client, calls } = fakeClient();
  const user = await openGroceryList(client);

  const before = Date.now();
  await user.click(await screen.findByRole("checkbox", { name: "garlic: 3 clove" }));

  const tick = calls.find((call) => call.name === "set_have_tick")?.input;
  expect(tick).toMatchObject({ line: 1, have: true });
  expect(Date.parse(String(tick?.at))).toBeGreaterThanOrEqual(before);
});

test("lines can be added by hand", async () => {
  const { client, calls } = fakeClient();
  const user = await openGroceryList(client);

  await user.type(await screen.findByLabelText("Add a line"), "2 lemons");
  await user.click(screen.getByRole("button", { name: "Add" }));

  expect(calls.find((call) => call.name === "add_grocery_line")?.input).toEqual({
    date: "2026-10-26",
    text: "2 lemons",
  });
});

test("the Store Sections can be put in walking order", async () => {
  const { client, calls } = fakeClient();
  const user = await openGroceryList(client);

  await user.click(await screen.findByText("Walking order"));
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
