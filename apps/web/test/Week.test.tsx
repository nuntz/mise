import { addDays, type Household, MEALS, type Member, type RecipeSummary, type Slot, type Week } from "@mise/domain";
import { render, screen, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { App } from "../src/App";
import type { MiseClient } from "../src/client";

const robin: Member = { id: 1, name: "Robin", email: null, constraints: [] };
const alex: Member = { id: 2, name: "Alex", email: null, constraints: [] };
const sam: Member = { id: 3, name: "Sam", email: null, constraints: [] };

const household: Household = {
  name: "The Tremblays",
  timezone: "America/Vancouver",
  dinnerTime: "18:00",
  weekStartsOn: "monday",
  units: "metric",
  locale: "en-CA",
  members: [robin, alex, sam],
};

const pasta: RecipeSummary = {
  id: 1,
  title: "Pasta",
  tags: [],
  effortMinutes: 20,
  cuisine: null,
  mainProtein: null,
  allergens: { kind: "known", allergens: ["wheat"] },
  photoKey: "photos/pasta",
};
const curry: RecipeSummary = { ...pasta, id: 2, title: "Curry", photoKey: null };

function emptyWeek(startDate: string): Week {
  return {
    startDate,
    slots: Array.from({ length: 7 }, (_, day) => addDays(startDate, day)).flatMap((date) =>
      MEALS.map(
        (meal): Slot => ({
          date,
          meal,
          kind: "unplanned",
          recipe: null,
          note: null,
          diners: [1, 2, 3],
          dinersAreDefault: true,
          guests: 0,
          guestConstraints: [],
          servings: 3,
          locked: false,
        }),
      ),
    ),
  };
}

/** A client whose current Week starts on Monday, October 26; it records every tool call made. */
function fakeClient() {
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const thisWeek = emptyWeek("2026-10-26");
  const tuesdayDinner = thisWeek.slots[5] as Slot;
  Object.assign(tuesdayDinner, {
    kind: "recipe",
    recipe: { id: 1, title: "Pasta", baseServings: 4, photoKey: "photos/pasta" },
    note: "Use the fresh basil",
    guests: 1,
    servings: 4,
    locked: true,
  });
  const client: MiseClient = {
    call: (async (name: string, input: Record<string, unknown>) => {
      calls.push({ name, input });
      switch (name) {
        case "get_household":
          return { ok: true, value: household };
        case "get_week":
          return { ok: true, value: input.date === "2026-11-02" ? emptyWeek("2026-11-02") : thisWeek };
        case "search_recipes":
          return { ok: true, value: [curry, pasta] };
        case "set_slot":
        case "set_guests":
        case "lock_slot":
          return { ok: true, value: tuesdayDinner };
        case "set_diners":
          return { ok: true, value: [tuesdayDinner] };
        case "clear_week":
          return { ok: true, value: emptyWeek("2026-10-26") };
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

const writes = (calls: { name: string; input: unknown }[]) =>
  calls.filter((call) => !["get_household", "get_week", "search_recipes"].includes(call.name));

test("the Week opens first: each day's dinner with its photo, breakfast and lunch tucked away", async () => {
  const { client } = fakeClient();
  render(() => <App client={client} />);

  const tuesday = await screen.findByRole("region", { name: "Tuesday, October 27" });
  const dinner = within(tuesday).getByRole("region", { name: "Dinner" });
  expect(within(dinner).getByRole("heading", { name: "Pasta" })).toBeTruthy();
  expect(within(dinner).getByRole("img", { name: "Photo of Pasta" }).getAttribute("src")).toBe(
    "/photos/1?v=photos/pasta",
  );
  expect(within(dinner).getByText("Serves 4 (Robin, Alex, Sam and 1 Guest); the Recipe makes 4.")).toBeTruthy();
  expect(within(dinner).getByText("Use the fresh basil")).toBeTruthy();
  expect(within(dinner).getByText("Locked")).toBeTruthy();

  const otherMeals = within(tuesday).getByText("Breakfast and lunch").closest("details");
  expect(otherMeals?.open).toBe(false);
  expect(within(screen.getByRole("region", { name: "Monday, October 26" })).getByText("Nothing planned")).toBeTruthy();
});

test("next Week is a tap away", async () => {
  const { client, calls } = fakeClient();
  const user = userEvent.setup();
  render(() => <App client={client} />);
  await screen.findByRole("region", { name: "Monday, October 26" });

  await user.click(screen.getByRole("button", { name: "Next Week" }));

  await screen.findByRole("region", { name: "Monday, November 2" });
  expect(calls.filter((call) => call.name === "get_week").at(-1)?.input).toEqual({ date: "2026-11-02" });
});

test("editing a dinner sends only what changed: the Recipe, who's eating and the Lock", async () => {
  const { client, calls } = fakeClient();
  const user = userEvent.setup();
  render(() => <App client={client} />);
  const tuesday = await screen.findByRole("region", { name: "Tuesday, October 27" });

  await user.click(within(tuesday).getByRole("button", { name: "Edit Dinner" }));
  const form = within(tuesday).getByRole("form", { name: "Dinner" });
  await within(form).findByRole("option", { name: "Curry" });
  await user.selectOptions(within(form).getByRole("combobox", { name: "Recipe" }), "Curry");
  await user.click(within(form).getByRole("checkbox", { name: "Everyone" }));
  await user.click(within(form).getByRole("checkbox", { name: "Alex" }));
  await user.click(within(form).getByRole("checkbox", { name: "Locked" }));
  await user.click(within(form).getByRole("button", { name: "Save" }));

  await vi.waitFor(() => expect(within(tuesday).queryByRole("form")).toBeNull());
  expect(writes(calls)).toEqual([
    {
      name: "set_slot",
      input: { date: "2026-10-27", meal: "dinner", kind: "recipe", recipeId: 2, note: "Use the fresh basil" },
    },
    { name: "set_diners", input: { date: "2026-10-27", meal: "dinner", diners: [1, 3] } },
    { name: "lock_slot", input: { date: "2026-10-27", meal: "dinner", locked: false } },
  ]);
});

test("Guests and their Constraints are set on the Slot", async () => {
  const { client, calls } = fakeClient();
  const user = userEvent.setup();
  render(() => <App client={client} />);
  const monday = await screen.findByRole("region", { name: "Monday, October 26" });

  await user.click(within(monday).getByRole("button", { name: "Edit Dinner" }));
  const form = within(monday).getByRole("form", { name: "Dinner" });
  await user.selectOptions(within(form).getByRole("combobox", { name: "What" }), "Eating out");
  await user.clear(within(form).getByRole("spinbutton", { name: "Guests" }));
  await user.type(within(form).getByRole("spinbutton", { name: "Guests" }), "2");
  await user.click(within(form).getByRole("button", { name: "Add a Constraint" }));
  await user.selectOptions(within(form).getByRole("combobox", { name: "Allergen" }), "Sesame");
  await user.click(within(form).getByRole("button", { name: "Save" }));

  await vi.waitFor(() => expect(within(monday).queryByRole("form")).toBeNull());
  expect(writes(calls)).toEqual([
    { name: "set_slot", input: { date: "2026-10-26", meal: "dinner", kind: "eat_out", note: null } },
    {
      name: "set_guests",
      input: {
        date: "2026-10-26",
        meal: "dinner",
        guests: 2,
        guestConstraints: [{ kind: "allergy", allergen: "sesame" }],
      },
    },
  ]);
});

test("who's eating can be set for a whole day", async () => {
  const { client, calls } = fakeClient();
  const user = userEvent.setup();
  render(() => <App client={client} />);
  const wednesday = await screen.findByRole("region", { name: "Wednesday, October 28" });

  await user.click(within(wednesday).getByRole("button", { name: "Who's eating today" }));
  const form = within(wednesday).getByRole("form", { name: "Who's eating today" });
  await user.click(within(form).getByRole("checkbox", { name: "Everyone" }));
  await user.click(within(form).getByRole("checkbox", { name: "Robin" }));
  await user.click(within(form).getByRole("button", { name: "Save" }));

  await vi.waitFor(() =>
    expect(writes(calls)).toEqual([{ name: "set_diners", input: { date: "2026-10-28", diners: [2, 3] } }]),
  );
});

test("clearing the Week asks first", async () => {
  const { client, calls } = fakeClient();
  const user = userEvent.setup();
  const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
  render(() => <App client={client} />);
  await screen.findByRole("region", { name: "Monday, October 26" });

  await user.click(screen.getByRole("button", { name: "Clear this Week" }));
  await user.click(screen.getByRole("button", { name: "Clear this Week" }));

  expect(confirm).toHaveBeenCalledTimes(2);
  await vi.waitFor(() =>
    expect(writes(calls)).toEqual([{ name: "clear_week", input: { date: "2026-10-26", confirm: true } }]),
  );
  confirm.mockRestore();
});
