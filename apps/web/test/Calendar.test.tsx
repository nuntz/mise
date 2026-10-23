import type { CalendarToken, ToolResult } from "@mise/domain";
import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { CalendarSettings } from "../src/Calendar";
import { createFakeClient } from "./fakeClient";

/** A client holding `token` (none when null); rotating hands out `next`. It records every call. */
function fakeClient(token: string | null, next = "rotated-token") {
  let current: CalendarToken | null = token === null ? null : { token };
  const calls: string[] = [];
  const { client } = createFakeClient(async (name: string): Promise<ToolResult<unknown>> => {
    calls.push(name);
    if (name === "get_calendar_token") return { ok: true, value: current };
    if (name === "rotate_calendar_token") {
      current = { token: next };
      return { ok: true, value: current };
    }
    throw new Error(`Unexpected tool ${name}`);
  });
  return { client, calls };
}

const feedUrl = (token: string) => `${window.location.origin}/cal/${token}.ics`;

test("shows the subscribe URL, with a link that opens it in a calendar app", async () => {
  const { client } = fakeClient("the-token");
  render(() => <CalendarSettings client={client} />);

  const url = (await screen.findByRole("textbox", { name: "Subscribe URL" })) as HTMLInputElement;

  expect(url.value).toBe(feedUrl("the-token"));
  expect(url.readOnly).toBe(true);
  expect(screen.getByRole("link", { name: "Subscribe in your calendar app" }).getAttribute("href")).toBe(
    `webcal://${window.location.host}/cal/the-token.ics`,
  );
});

test("without a link yet, creating one shows it", async () => {
  const user = userEvent.setup();
  const { client } = fakeClient(null, "first-token");
  render(() => <CalendarSettings client={client} />);

  await user.click(await screen.findByRole("button", { name: "Create a subscribe link" }));

  const url = (await screen.findByRole("textbox", { name: "Subscribe URL" })) as HTMLInputElement;
  expect(url.value).toBe(feedUrl("first-token"));
});

test("rotating asks first, then replaces the link", async () => {
  const user = userEvent.setup();
  const { client, calls } = fakeClient("old-token", "new-token");
  render(() => <CalendarSettings client={client} />);

  await user.click(await screen.findByRole("button", { name: "Rotate link" }));
  expect(calls).not.toContain("rotate_calendar_token");
  expect(screen.getByText(/Calendars subscribed with the current link will stop updating/)).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(calls).not.toContain("rotate_calendar_token");

  await user.click(screen.getByRole("button", { name: "Rotate link" }));
  await user.click(screen.getByRole("button", { name: "Rotate now" }));

  const url = (await screen.findByDisplayValue(feedUrl("new-token"))) as HTMLInputElement;
  expect(url).toBeTruthy();
  expect(calls.filter((name) => name === "rotate_calendar_token")).toHaveLength(1);
});
