import { render, screen, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { App } from "../src/App";
import { createFakeClient } from "./fakeClient";
import { primaries } from "./primaries";

/** A Mise whose Household hasn't been set up yet; it records what setup sends. */
function notSetUp() {
  const setups: Record<string, unknown>[] = [];
  const { client } = createFakeClient((name, input) => {
    if (name === "get_household") return { ok: true, value: null };
    if (name === "setup_household") {
      setups.push(input);
      return { ok: false, error: { code: "already_set_up", message: "" } };
    }
    throw new Error(`Unexpected tool ${name}`);
  });
  return { client, setups };
}

test("setup is headed like every other page, and Set up Household is its one primary", async () => {
  render(() => <App client={notSetUp().client} />);

  const title = await screen.findByRole("heading", { level: 1, name: "Set up your Household" });
  expect(title.closest(".page-heading")?.querySelector(".overline")?.textContent).toBe("Mise · Setup");
  expect(primaries()).toEqual(["Set up Household"]);
});

test("setup sends the Household's settings and its Members, with their Constraints", async () => {
  const user = userEvent.setup();
  const { client, setups } = notSetUp();
  render(() => <App client={client} />);

  await user.type(await screen.findByRole("textbox", { name: "Household name" }), "The Tremblays");
  await user.click(screen.getByRole("button", { name: "Add a Member" }));
  await user.type(screen.getByRole("textbox", { name: "Name" }), "Robin");
  await user.click(screen.getByRole("button", { name: "Add a Constraint" }));
  const constraint = screen.getByRole("combobox", { name: "Kind" }).closest("li") as HTMLElement;
  await user.selectOptions(within(constraint).getByRole("combobox", { name: "Kind" }), "allergy");
  await user.selectOptions(within(constraint).getByRole("combobox", { name: "Allergen" }), "Peanut");
  await user.click(screen.getByRole("button", { name: "Set up Household" }));

  expect(setups).toEqual([
    {
      name: "The Tremblays",
      timezone: "America/Vancouver",
      dinnerTime: "18:00",
      weekStartsOn: "monday",
      units: "metric",
      locale: "en-CA",
      members: [{ name: "Robin", email: null, constraints: [{ kind: "allergy", allergen: "peanut" }] }],
    },
  ]);
});
