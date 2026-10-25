import type { PushDevice, PushKind, PushSubscriptionJson, ToolResult } from "@mise/domain";
import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { NotificationSettings } from "../src/Notifications";
import type { DevicePush } from "../src/push";
import { createFakeClient } from "./fakeClient";

const PUBLIC_KEY = "BExamplePublicKey";

/**
 * This device's push, as the browser's behaves: notifications need asking for once, from a tap, and
 * the answer stays; subscribing again hands back the subscription the device already has.
 */
function fakeDevicePush(answer: NotificationPermission = "granted", supported = true) {
  let permission: NotificationPermission = "default";
  let subscription: PushSubscriptionJson | null = null;
  const subscribedWith: string[] = [];
  const push: DevicePush = {
    state: () => (supported ? permission : "unsupported"),
    subscription: async () => subscription,
    async subscribe(publicKey) {
      if (permission === "default") permission = answer;
      if (permission !== "granted") return null;
      subscribedWith.push(publicKey);
      subscription ??= {
        endpoint: "https://push.example.com/send/this-device",
        keys: { p256dh: "device-key", auth: "device-auth" },
      };
      return subscription;
    },
    async unsubscribe() {
      subscription = null;
    },
  };
  return { push, subscribedWith };
}

/** The household's side: the deployment's key (none when null) and the devices it knows. */
function fakeClient(publicKey: string | null = PUBLIC_KEY) {
  const devices = new Map<string, PushKind[]>();
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const { client } = createFakeClient(async (name, input): Promise<ToolResult<unknown>> => {
    calls.push({ name, input });
    const endpoint = input.endpoint as string;
    if (name === "get_push_key") {
      return publicKey
        ? { ok: true, value: { publicKey } }
        : { ok: false, error: { code: "not_configured", message: "No push key is set up for Mise" } };
    }
    if (name === "get_push_device") {
      const kinds = devices.get(endpoint);
      return { ok: true, value: kinds ? ({ endpoint, kinds } satisfies PushDevice) : null };
    }
    if (name === "subscribe_push") {
      devices.set(endpoint, input.kinds as PushKind[]);
      return { ok: true, value: { endpoint, kinds: input.kinds } };
    }
    if (name === "unsubscribe_push") {
      const kinds = devices.get(endpoint);
      devices.delete(endpoint);
      return { ok: true, value: { endpoint, kinds } };
    }
    throw new Error(`Unexpected tool ${name}`);
  });
  return { client, calls, devices };
}

test("turning notifications on subscribes this device to every kind, each of which it can turn off", async () => {
  const user = userEvent.setup();
  const { client, devices } = fakeClient();
  const { push, subscribedWith } = fakeDevicePush();
  render(() => <NotificationSettings client={client} push={push} />);

  await user.click(await screen.findByRole("button", { name: "Turn on notifications on this device" }));

  expect(subscribedWith).toEqual([PUBLIC_KEY]);
  const prepAhead = (await screen.findByRole("checkbox", { name: /Prep ahead/ })) as HTMLInputElement;
  expect(prepAhead.checked).toBe(true);
  expect(devices.get("https://push.example.com/send/this-device")).toEqual([
    "weekly_proposal",
    "checkin_due",
    "prep_ahead",
    "review_waiting",
    "drive_flagged",
  ]);

  await user.click(prepAhead);

  expect(devices.get("https://push.example.com/send/this-device")).not.toContain("prep_ahead");
  expect(prepAhead.checked).toBe(false);
});

test("a device already subscribed shows the kinds it gets", async () => {
  const { client, devices } = fakeClient();
  const { push } = fakeDevicePush();
  await push.subscribe(PUBLIC_KEY);
  devices.set("https://push.example.com/send/this-device", ["weekly_proposal"]);
  render(() => <NotificationSettings client={client} push={push} />);

  const proposal = (await screen.findByRole("checkbox", { name: /Next week proposed/ })) as HTMLInputElement;
  expect(proposal.checked).toBe(true);
  expect((screen.getByRole("checkbox", { name: /Pantry check due/ }) as HTMLInputElement).checked).toBe(false);
});

test("turning them off unsubscribes the device, in the browser and in Mise", async () => {
  const user = userEvent.setup();
  const { client, devices } = fakeClient();
  const { push } = fakeDevicePush();
  render(() => <NotificationSettings client={client} push={push} />);
  await user.click(await screen.findByRole("button", { name: "Turn on notifications on this device" }));

  await user.click(await screen.findByRole("button", { name: "Turn off on this device" }));

  expect(await screen.findByRole("button", { name: "Turn on notifications on this device" })).toBeTruthy();
  expect(devices.size).toBe(0);
  expect(await push.subscription()).toBeNull();
});

test("a device that refuses notifications is told how to allow them", async () => {
  const user = userEvent.setup();
  const { client, calls } = fakeClient();
  const { push } = fakeDevicePush("denied");
  render(() => <NotificationSettings client={client} push={push} />);

  await user.click(await screen.findByRole("button", { name: "Turn on notifications on this device" }));

  expect(await screen.findByText(/Notifications are blocked for Mise/)).toBeTruthy();
  expect(calls.map((call) => call.name)).not.toContain("subscribe_push");
});

test("a browser that can't get notifications here says to add Mise to the Home Screen", async () => {
  const { client } = fakeClient();
  const { push } = fakeDevicePush("granted", false);
  render(() => <NotificationSettings client={client} push={push} />);

  expect(await screen.findByText(/add Mise to the Home Screen/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Turn on notifications on this device" })).toBeNull();
});

test("a deployment without a push key says so", async () => {
  const { client } = fakeClient(null);
  const { push } = fakeDevicePush();
  render(() => <NotificationSettings client={client} push={push} />);

  expect(await screen.findByText(/hasn't been set up to send notifications/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Turn on notifications on this device" })).toBeNull();
});
