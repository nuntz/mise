import { DEFAULT_EFFORT_BUDGETS, type Household, type Member, STORE_SECTIONS } from "@mise/domain";
import { render, screen, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { App } from "../src/App";
import { createFakeClient } from "./fakeClient";

const alex: Member = { id: 1, name: "Alex", email: "alex@example.com", constraints: [] };
const sam: Member = { id: 2, name: "Sam", email: null, constraints: [] };

const household = (overrides: Partial<Household> = {}): Household => ({
  name: "The Tremblays",
  timezone: "America/Vancouver",
  dinnerTime: "18:00",
  weekStartsOn: "monday",
  weekStartChanges: [],
  units: "metric",
  locale: "en-CA",
  voiceMinutesPerDay: 30,
  members: [alex, sam],
  effortBudgets: DEFAULT_EFFORT_BUDGETS,
  storeSections: [...STORE_SECTIONS],
  ...overrides,
});

/**
 * What waits on the Household, by how many of each the listing tools return, and how many Recipes it
 * has besides the untagged ones.
 */
type Waiting = { drafts?: number; flags?: number; unresolved?: number; untagged?: number; tagged?: number };

/** `count` stand-ins for a listing's entries, each on its own Recipe, numbered from `first`. */
const entries = (first: number, count = 0) =>
  Array.from({ length: count }, (_, index) => ({ recipe: { id: first + index } }));

/**
 * A client whose Household the test controls; `notify` stands in for a `household` change notice
 * whose refetch returns `next`, or fails when `next` is an Error. `wait` changes what waits on the
 * Household and sends a `recipes` change notice. `calls` names each tool called, in order. `hold` keeps
 * the Household status listings from answering until `release`.
 */
function fakeClient(initial: Household, initialWaiting: Waiting = {}) {
  let current: Household | Error = initial;
  let waiting = initialWaiting;
  const calls: string[] = [];
  let holding = false;
  let held = Promise.resolve();
  let release = () => {};
  const fake = createFakeClient(async (name) => {
    calls.push(name);
    if (holding && STATUS_LISTINGS.includes(name)) await held;
    if (name === "list_drafts") return { ok: true, value: entries(100, waiting.drafts) };
    if (name === "list_import_flags") return { ok: true, value: entries(200, waiting.flags) };
    if (name === "list_unresolved_ingredients") return { ok: true, value: entries(300, waiting.unresolved) };
    if (name === "list_untagged_recipes") return { ok: true, value: entries(400, waiting.untagged) };
    if (name === "get_household") {
      if (current instanceof Error) throw current;
      return { ok: true, value: current };
    }
    if (name === "get_caller") return { ok: true, value: null };
    if (name === "get_week") return { ok: false, error: { code: "not_found", message: "" } };
    if (name === "get_grocery_list") return { ok: true, value: null };
    if (name === "list_items") return { ok: true, value: [] };
    if (name === "list_due_staples") return { ok: true, value: { due: 0, staples: [] } };
    if (name === "search_recipes") {
      const recipes = (waiting.untagged ?? 0) + (waiting.tagged ?? 0);
      return { ok: true, value: Array.from({ length: recipes }, (_, index) => ({ id: 500 + index })) };
    }
    throw new Error(`Unexpected tool ${name}`);
  });
  const notify = (next: Household | Error) => {
    current = next;
    fake.notify("household");
  };
  const wait = (next: Waiting) => {
    waiting = next;
    fake.notify("recipes");
  };
  const hold = () => {
    holding = true;
    held = new Promise((resolve) => {
      release = () => {
        holding = false;
        resolve();
      };
    });
  };
  return { client: fake.client, notify, wait, calls, hold, release: () => release() };
}

/** The listings the Household's status chips come from. */
const STATUS_LISTINGS = [
  "list_drafts",
  "list_import_flags",
  "list_unresolved_ingredients",
  "list_untagged_recipes",
  "search_recipes",
];

test("a household change notice keeps unsaved Member input and shows the new data", async () => {
  const user = userEvent.setup();
  const { client, notify } = fakeClient(household());
  render(() => <App client={client} />);

  await user.click(await screen.findByRole("button", { name: "Household" }));
  await screen.findByRole("heading", { name: "The Tremblays" });
  await user.click(screen.getByRole("button", { name: "Members" }));
  // Half-edit Sam, and half-add a new Member.
  await user.click(screen.getByRole("button", { name: "Edit Sam" }));
  const editName = screen.getByDisplayValue("Sam");
  await user.clear(editName);
  await user.type(editName, "Samuel");
  await user.click(screen.getByRole("button", { name: "Add a Member" }));
  const addName = screen.getAllByRole("textbox", { name: "Name" }).at(-1) as HTMLInputElement;
  await user.type(addName, "Robin");

  // Another client renames the Household and Alex, and adds Jo.
  notify(
    household({
      name: "The Tremblay-Nguyens",
      members: [{ ...alex, name: "Alexandra" }, sam, { id: 3, name: "Jo", email: null, constraints: [] }],
    }),
  );

  await screen.findByText("Alexandra");
  expect(screen.getByText("Jo")).toBeTruthy();
  expect(screen.getByDisplayValue("Samuel")).toBeTruthy();
  expect(screen.getByDisplayValue("Robin")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Household", current: false }));
  await screen.findByRole("heading", { name: "The Tremblay-Nguyens" });
});

test("a refresh that fails keeps the settings and their unsaved input, and says so", async () => {
  const user = userEvent.setup();
  const { client, notify } = fakeClient(household());
  render(() => <App client={client} />);

  await user.click(await screen.findByRole("button", { name: "Household" }));
  await screen.findByRole("heading", { name: "The Tremblays" });
  await user.click(screen.getByRole("button", { name: "Members" }));
  await user.click(screen.getByRole("button", { name: "Add a Member" }));
  await user.type(screen.getAllByRole("textbox", { name: "Name" }).at(-1) as HTMLInputElement, "Robin");

  // The connection drops and the refetch on reconnect fails.
  notify(new Error("offline"));

  await screen.findByRole("alert");
  expect(screen.getByText("Household · Members")).toBeTruthy();
  expect(screen.getByDisplayValue("Robin")).toBeTruthy();
});

test("kitchen mode is a switch, described by its hint, that applies at once", async () => {
  const user = userEvent.setup();
  const { client } = fakeClient(household());
  render(() => <App client={client} />);

  await user.click(await screen.findByRole("button", { name: "Household" }));
  const kitchen = await screen.findByRole("switch", {
    name: "Kitchen mode on this device",
    description: "Near-black with bigger type, for reading at arm's length with busy hands.",
  });
  expect(kitchen.getAttribute("aria-checked")).toBe("false");

  await user.click(kitchen);

  expect(kitchen.getAttribute("aria-checked")).toBe("true");
  expect(document.documentElement.dataset.theme).toBe("kitchen");
  await user.click(kitchen);
  expect(document.documentElement.dataset.theme).toBeUndefined();
});

test("Household is the fifth tab, and opens as an index of its sections", async () => {
  const user = userEvent.setup();
  const { client } = fakeClient(household());
  render(() => <App client={client} />);

  const tab = await screen.findByRole("button", { name: "Household" });
  await user.click(tab);

  expect(tab.getAttribute("aria-current")).toBe("page");
  expect(screen.getByRole("heading", { name: "The Tremblays" })).toBeTruthy();
  expect(
    screen.getByText(
      "Week starts on Monday. Dinner at 18:00, America/Vancouver. Units: Metric. Language: English (Canada).",
    ),
  ).toBeTruthy();
  const groups = ["People", "Planning", "Recipes and Items"].map((name) => screen.getByRole("list", { name }));
  expect(
    groups.map((group) =>
      within(group)
        .getAllByRole("button")
        .map((row) => row.querySelector(".row-title")?.textContent),
    ),
  ).toEqual([
    ["Members"],
    ["Settings", "Calendar", "Kitchen Displays", "Notifications"],
    ["Review", "Import", "Resolve Ingredients", "Items", "Tag Recipes"],
  ]);
});

test("a Household section opens as its own page, and the back link or the back gesture returns to the index", async () => {
  const user = userEvent.setup();
  const { client } = fakeClient(household());
  render(() => <App client={client} />);
  await user.click(await screen.findByRole("button", { name: "Household" }));

  await user.click(screen.getByRole("button", { name: "Members" }));
  expect(screen.getByText("Household · Members")).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "The Tremblays" })).toBeNull();
  expect(screen.queryByRole("switch")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Household", current: false }));
  await screen.findByRole("heading", { name: "The Tremblays" });

  await user.click(screen.getByRole("button", { name: "Calendar" }));
  expect(screen.getByText("Household · Calendar")).toBeTruthy();
  history.back();
  await screen.findByRole("heading", { name: "The Tremblays" });
  expect(screen.queryByText("Household · Calendar")).toBeNull();
});

test("the Household tab, tapped from a section, returns to the index", async () => {
  const user = userEvent.setup();
  const { client } = fakeClient(household());
  render(() => <App client={client} />);
  await user.click(await screen.findByRole("button", { name: "Household" }));
  await user.click(screen.getByRole("button", { name: "Settings" }));

  await user.click(screen.getByRole("button", { name: "Household", current: "page" }));

  expect(await screen.findByRole("heading", { name: "The Tremblays" })).toBeTruthy();
  expect(screen.queryByText("Household · Settings")).toBeNull();
});

test("a Household row shows a chip where something waits, and none where nothing does", async () => {
  const user = userEvent.setup();
  const { client, wait } = fakeClient(household(), { drafts: 1, unresolved: 3, untagged: 2 });
  render(() => <App client={client} />);
  await user.click(await screen.findByRole("button", { name: "Household" }));

  const review = screen.getByRole("button", { name: /^Review/ });
  expect(await within(review).findByText("1 Draft")).toBeTruthy();
  const resolve = screen.getByRole("button", { name: /^Resolve Ingredients/ });
  expect(within(resolve).getByText("3 Unresolved").classList.contains("chip-amber")).toBe(true);
  const tag = screen.getByRole("button", { name: /^Tag Recipes/ });
  expect(within(tag).getByText("2 untagged")).toBeTruthy();
  expect(within(screen.getByRole("button", { name: /^Import/ })).queryByText(/./, { selector: ".chip" })).toBeNull();

  // The Household reviews the Draft, resolves the Ingredients and tags the Recipes.
  wait({ flags: 2, tagged: 2 });

  expect(await within(review).findByText("2 Import Flags")).toBeTruthy();
  expect(within(review).queryByText("1 Draft")).toBeNull();
  expect(within(resolve).queryByText(/Unresolved/)).toBeNull();
  expect(within(tag).getByText("All tagged").classList.contains("chip-leaf")).toBe(true);
});

test("the Household's chips wait for its index to show before they refetch", async () => {
  const user = userEvent.setup();
  const { client, wait, calls, hold, release } = fakeClient(household(), { drafts: 1 });
  render(() => <App client={client} />);
  await user.click(await screen.findByRole("button", { name: "Household" }));
  await within(screen.getByRole("button", { name: /^Review/ })).findByText("1 Draft");
  await user.click(screen.getByRole("button", { name: "Members" }));

  const before = calls.length;
  wait({ drafts: 2 });

  expect(calls.slice(before).filter((name) => STATUS_LISTINGS.includes(name))).toEqual([]);
  // Back on the index, the chips that showed stay until the listings answer.
  hold();
  await user.click(screen.getByRole("button", { name: "Household", current: false }));
  // The index may take a moment to show on a slow machine.
  const review = await screen.findByRole("button", { name: /^Review/ });
  expect(within(review).getByText("1 Draft")).toBeTruthy();
  release();
  expect(await within(review).findByText("2 Drafts")).toBeTruthy();
});

test("Tag Recipes shows no chip for a Household with no Recipes yet", async () => {
  const user = userEvent.setup();
  const { client } = fakeClient(household(), { drafts: 1 });
  render(() => <App client={client} />);
  await user.click(await screen.findByRole("button", { name: "Household" }));

  // The Review chip shows once the listings have answered.
  await within(screen.getByRole("button", { name: /^Review/ })).findByText("1 Draft");
  expect(
    within(screen.getByRole("button", { name: /^Tag Recipes/ })).queryByText(/./, { selector: ".chip" }),
  ).toBeNull();
});
