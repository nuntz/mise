import { render, screen } from "@solidjs/testing-library";
import { expect, test } from "vitest";
import { App } from "../src/App";
import { createFakeClient } from "./fakeClient";
import { primaries } from "./primaries";

/** A Mise whose Household hasn't been set up yet. */
function notSetUp() {
  return createFakeClient((name) => {
    if (name === "get_household") return { ok: true, value: null };
    throw new Error(`Unexpected tool ${name}`);
  }).client;
}

test("setup is headed like every other page, and Set up Household is its one primary", async () => {
  render(() => <App client={notSetUp()} />);

  const title = await screen.findByRole("heading", { level: 1, name: "Set up your Household" });
  expect(title.closest(".page-heading")?.querySelector(".overline")?.textContent).toBe("Mise · Setup");
  expect(primaries()).toEqual(["Set up Household"]);
});
