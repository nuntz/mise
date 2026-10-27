import type { KitchenDisplay, ToolResult } from "@mise/domain";
import { render, screen, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { KitchenDisplaySettings } from "../src/KitchenDisplays";
import { createFakeClient } from "./fakeClient";
import { primaries } from "./primaries";

const counter: KitchenDisplay = {
  id: 1,
  label: "Kitchen counter",
  addedAt: "2026-10-20T17:00:00.000Z",
  lastUsedAt: "2026-10-26T15:02:00.000Z",
};

/** A client holding `displays`; pairing hands out `the-new-token`. It records every call. */
function fakeClient(displays: KitchenDisplay[]) {
  let current = [...displays];
  const calls: { name: string; input: unknown }[] = [];
  const { client } = createFakeClient(async (name: string, input: unknown): Promise<ToolResult<unknown>> => {
    calls.push({ name, input });
    if (name === "list_kitchen_displays") return { ok: true, value: current };
    if (name === "add_kitchen_display") {
      const added = { id: 9, label: (input as { label: string }).label, addedAt: counter.addedAt, lastUsedAt: null };
      current = [...current, added];
      return { ok: true, value: { ...added, token: "the-new-token" } };
    }
    if (name === "revoke_kitchen_display") {
      const revoked = current.find((display) => display.id === (input as { id: number }).id);
      if (!revoked) return { ok: false, error: { code: "not_found", message: "No such Kitchen Display" } };
      current = current.filter((display) => display !== revoked);
      return { ok: true, value: revoked };
    }
    throw new Error(`Unexpected tool ${name}`);
  });
  return { client, calls };
}

test("lists each Kitchen Display with when it last read the Day Sheet", async () => {
  const { client } = fakeClient([counter, { ...counter, id: 2, label: "Pantry door", lastUsedAt: null }]);
  render(() => <KitchenDisplaySettings client={client} />);

  const rows = await screen.findAllByRole("listitem");

  expect(rows.map((row) => row.querySelector(".row-title")?.textContent)).toEqual(["Kitchen counter", "Pantry door"]);
  expect(within(rows[0] as HTMLElement).getByText(/^Last updated /)).toBeTruthy();
  expect(within(rows[1] as HTMLElement).getByText("Not used yet")).toBeTruthy();
});

test("pairing shows the new token once, to copy into the Kitchen Display", async () => {
  const user = userEvent.setup();
  const { client, calls } = fakeClient([]);
  render(() => <KitchenDisplaySettings client={client} />);

  await user.type(await screen.findByRole("textbox", { name: "Name" }), "Kitchen counter");
  await user.click(screen.getByRole("button", { name: "Pair a Kitchen Display" }));

  const token = (await screen.findByRole("textbox", { name: "Token" })) as HTMLInputElement;
  expect(token.value).toBe("the-new-token");
  expect(token.readOnly).toBe(true);
  expect(screen.getByText(/won't be shown again/)).toBeTruthy();
  expect(calls.find((call) => call.name === "add_kitchen_display")?.input).toEqual({ label: "Kitchen counter" });
  expect(await screen.findByText("Kitchen counter")).toBeTruthy();

  await user.click(screen.getByRole("button", { name: "Done" }));
  expect(screen.queryByRole("textbox", { name: "Token" })).toBeNull();
});

test("revoking asks first, in Mise's own sheet, then removes the Kitchen Display", async () => {
  const user = userEvent.setup();
  const { client, calls } = fakeClient([counter]);
  render(() => <KitchenDisplaySettings client={client} />);

  await user.click(await screen.findByRole("button", { name: "Revoke Kitchen counter" }));
  const sheet = screen.getByRole("dialog", { name: "Revoke Kitchen counter?" });
  await user.click(within(sheet).getByRole("button", { name: "Cancel" }));
  expect(calls.map((call) => call.name)).not.toContain("revoke_kitchen_display");

  await user.click(screen.getByRole("button", { name: "Revoke Kitchen counter" }));
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Revoke" }));

  expect(await screen.findByText("No Kitchen Display is paired.")).toBeTruthy();
  expect(calls.find((call) => call.name === "revoke_kitchen_display")?.input).toEqual({ id: 1 });
});

test("the screen's one primary pairs a Kitchen Display", async () => {
  const { client } = fakeClient([counter]);
  render(() => <KitchenDisplaySettings client={client} />);

  await screen.findByText("Kitchen counter");

  expect(primaries()).toEqual(["Pair a Kitchen Display"]);
});
