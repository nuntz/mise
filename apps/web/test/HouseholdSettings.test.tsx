import { DEFAULT_EFFORT_BUDGETS, type Household, STORE_SECTIONS } from "@mise/domain";
import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { App } from "../src/App";
import { createFakeClient } from "./fakeClient";

const tremblays: Household = {
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
 * A household whose settings change as `update_household_settings` is called, or as the test says
 * another device changed them; each change sends a change notice, as the real one does.
 */
function fakeHousehold(refuse?: { path: string }) {
  let current = tremblays;
  const updates: Record<string, unknown>[] = [];
  const fake = createFakeClient((name, input) => {
    if (name === "get_household") return { ok: true, value: current };
    if (name === "update_household_settings") {
      updates.push(input);
      if (refuse) {
        return {
          ok: false,
          error: { code: "invalid_input", message: "Invalid", issues: [{ path: refuse.path, message: "Invalid" }] },
        };
      }
      current = { ...current, ...input };
      queueMicrotask(() => fake.notify("household"));
      return { ok: true, value: current };
    }
    if (name === "get_caller") return { ok: true, value: null };
    if (name === "get_week") return { ok: false, error: { code: "not_found", message: "" } };
    if (name === "get_grocery_list") return { ok: true, value: null };
    if (name === "list_due_staples") return { ok: true, value: { due: 0, staples: [] } };
    throw new Error(`Unexpected tool ${name}`);
  });
  const changeElsewhere = (change: Partial<Household>) => {
    current = { ...current, ...change };
    fake.notify("household");
  };
  return { client: fake.client, updates, changeElsewhere };
}

async function openSettings(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Household" }));
  await user.click(screen.getByRole("button", { name: "Settings" }));
}

test("every setting chosen at setup can be changed from the Household page", async () => {
  const user = userEvent.setup();
  const { client, updates } = fakeHousehold();
  render(() => <App client={client} />);
  await openSettings(user);

  const name = screen.getByRole("textbox", { name: "Household name" });
  await user.clear(name);
  await user.type(name, "The Tremblay-Nguyens");
  await user.selectOptions(screen.getByRole("combobox", { name: "Timezone" }), "America/Toronto");
  const dinnerTime = screen.getByLabelText("Dinner time");
  await user.clear(dinnerTime);
  await user.type(dinnerTime, "19:30");
  await user.selectOptions(screen.getByRole("combobox", { name: "Week starts on" }), "sunday");
  await user.selectOptions(screen.getByRole("combobox", { name: "Units" }), "imperial");
  expect(screen.getByRole("combobox", { name: "Language" })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Save settings" }));

  expect(updates).toEqual([
    {
      name: "The Tremblay-Nguyens",
      timezone: "America/Toronto",
      dinnerTime: "19:30",
      weekStartsOn: "sunday",
      units: "imperial",
      locale: "en-CA",
    },
  ]);
  await screen.findByRole("heading", { name: "The Tremblay-Nguyens" });
  expect(screen.getByText("Week starts on Sunday. Dinner at 19:30, America/Toronto.")).toBeTruthy();
  expect(screen.getByText("Units: Imperial. Language: English (Canada).")).toBeTruthy();
});

test("a new week start says it applies from the next Week", async () => {
  const user = userEvent.setup();
  const { client } = fakeHousehold();
  render(() => <App client={client} />);
  await openSettings(user);

  expect(screen.queryByText(/applies from the next Week/)).toBeNull();
  await user.selectOptions(screen.getByRole("combobox", { name: "Week starts on" }), "thursday");

  expect(screen.getByText(/applies from the next Week/)).toBeTruthy();
});

test("a refused change says which setting, and keeps what was typed", async () => {
  const user = userEvent.setup();
  const { client } = fakeHousehold({ path: "dinnerTime" });
  render(() => <App client={client} />);
  await openSettings(user);

  const name = screen.getByRole("textbox", { name: "Household name" });
  await user.clear(name);
  await user.type(name, "The Tremblay-Nguyens");
  await user.click(screen.getByRole("button", { name: "Save settings" }));

  expect((await screen.findByRole("alert")).textContent).toContain("Dinner time");
  expect(screen.getByDisplayValue("The Tremblay-Nguyens")).toBeTruthy();
});

test("a change made on another device shows in the form without a reload", async () => {
  const user = userEvent.setup();
  const { client, changeElsewhere } = fakeHousehold();
  render(() => <App client={client} />);
  await openSettings(user);

  changeElsewhere({ units: "imperial", weekStartsOn: "sunday" });

  await screen.findByText("Units: Imperial. Language: English (Canada).");
  expect((screen.getByRole("combobox", { name: "Units" }) as HTMLSelectElement).value).toBe("imperial");
  expect((screen.getByRole("combobox", { name: "Week starts on" }) as HTMLSelectElement).value).toBe("sunday");
});
