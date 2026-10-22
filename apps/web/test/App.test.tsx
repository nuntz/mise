import type { Household, Member } from "@mise/domain";
import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { App } from "../src/App";
import type { MiseClient } from "../src/client";

const alex: Member = { id: 1, name: "Alex", email: "alex@example.com", constraints: [] };
const sam: Member = { id: 2, name: "Sam", email: null, constraints: [] };

const household = (overrides: Partial<Household> = {}): Household => ({
  name: "The Tremblays",
  timezone: "America/Vancouver",
  dinnerTime: "18:00",
  weekStartsOn: "monday",
  units: "metric",
  locale: "en-CA",
  members: [alex, sam],
  ...overrides,
});

/**
 * A client whose Household the test controls; `notify` stands in for a `household` change notice
 * whose refetch returns `next`, or fails when `next` is an Error.
 */
function fakeClient(initial: Household) {
  let current: Household | Error = initial;
  const listeners = new Set<() => void>();
  const client: MiseClient = {
    call: (async (name: string) => {
      if (name === "get_household") {
        if (current instanceof Error) throw current;
        return { ok: true, value: current };
      }
      if (name === "get_caller") return { ok: true, value: null };
      if (name === "search_recipes") return { ok: true, value: [] };
      throw new Error(`Unexpected tool ${name}`);
    }) as MiseClient["call"],
    subscribe(_topic, refetch) {
      listeners.add(refetch);
      // The real client refetches on connect.
      queueMicrotask(refetch);
      return () => listeners.delete(refetch);
    },
    photoUrl: () => "",
    uploadPhoto: async () => true,
    removePhoto: async () => true,
    uploadExport: async () => null,
    close() {},
  };
  const notify = (next: Household | Error) => {
    current = next;
    for (const listener of listeners) listener();
  };
  return { client, notify };
}

test("a household change notice keeps unsaved Member input and shows the new data", async () => {
  const user = userEvent.setup();
  const { client, notify } = fakeClient(household());
  render(() => <App client={client} />);

  await screen.findByRole("heading", { name: "The Tremblays" });
  await user.click(screen.getByRole("button", { name: "Members" }));
  // Half-edit Sam, and half-add a new Member.
  await user.click(screen.getAllByRole("button", { name: "Edit" })[1] as HTMLElement);
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

  await screen.findByRole("heading", { name: "The Tremblay-Nguyens" });
  expect(screen.getByText("Alexandra")).toBeTruthy();
  expect(screen.getByText("Jo")).toBeTruthy();
  expect(screen.getByDisplayValue("Samuel")).toBeTruthy();
  expect(screen.getByDisplayValue("Robin")).toBeTruthy();
});

test("a refresh that fails keeps the settings and their unsaved input, and says so", async () => {
  const user = userEvent.setup();
  const { client, notify } = fakeClient(household());
  render(() => <App client={client} />);

  await screen.findByRole("heading", { name: "The Tremblays" });
  await user.click(screen.getByRole("button", { name: "Members" }));
  await user.click(screen.getByRole("button", { name: "Add a Member" }));
  await user.type(screen.getAllByRole("textbox", { name: "Name" }).at(-1) as HTMLInputElement, "Robin");

  // The connection drops and the refetch on reconnect fails.
  notify(new Error("offline"));

  await screen.findByRole("alert");
  expect(screen.getByRole("heading", { name: "The Tremblays" })).toBeTruthy();
  expect(screen.getByDisplayValue("Robin")).toBeTruthy();
});
