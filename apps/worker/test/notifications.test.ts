import { env } from "cloudflare:workers";
import type { PushDevice, PushKey, PushKind, Slot, ToolResult, Week } from "@mise/domain";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { usePush, webPush } from "../src/push";
import { type Device, newDevice, pretendPushService, subscriptionOf, vapidKey } from "./pushService";

type HouseholdStub = ReturnType<typeof env.Household.getByName>;

const SUBJECT = "https://mise.example.com";
const EVERY_KIND: PushKind[] = ["weekly_proposal", "checkin_due", "prep_ahead", "review_waiting", "drive_flagged"];

let service: ReturnType<typeof pretendPushService>;
let publicKey: string;

beforeEach(async () => {
  const key = await vapidKey();
  publicKey = key.publicKey;
  service = pretendPushService(key.publicKey, SUBJECT);
  usePush(() => webPush({ privateKey: key.secret, subject: SUBJECT }, service.fetch));
});

afterEach(() => vi.useRealTimers());

/** A Household in Vancouver whose Weeks start on Monday, with a Recipe for each dinner of a Week. */
async function setUpHousehold(): Promise<HouseholdStub> {
  const household = env.Household.getByName(crypto.randomUUID());
  await household.callTool("setup_household", {
    name: "The Example Family",
    timezone: "America/Vancouver",
    members: [{ name: "Robin" }, { name: "Alex" }],
  });
  for (const title of ["Dal", "Tacos", "Risotto", "Pho", "Paella", "Ramen", "Chili"]) {
    await household.callTool("create_recipe", { title, baseServings: 4, ingredients: ["400 g rice"] });
  }
  return household;
}

/** A device that has turned notifications on for `kinds`. */
async function subscribed(household: HouseholdStub, kinds = EVERY_KIND): Promise<Device> {
  const device = await newDevice(`https://push.example.com/send/${crypto.randomUUID()}`);
  service.add(device);
  expect(await household.callTool("subscribe_push", { ...subscriptionOf(device), kinds })).toMatchObject({ ok: true });
  return device;
}

function value<T>(result: ToolResult<unknown>): T {
  if (!result.ok) throw new Error(`Expected the tool call to succeed: ${result.error.message}`);
  return result.value as T;
}

/** What the household has scheduled. */
async function schedules(household: HouseholdStub): Promise<{ callback: string; time: number }[]> {
  return (await household.listSchedules()) as { callback: string; time: number }[];
}

/** Runs the household's morning as its scheduler does, at 08:00 Vancouver time on `date`. */
async function morningOf(household: HouseholdStub, date: string): Promise<void> {
  vi.useFakeTimers({ toFake: ["Date"] });
  // Vancouver is on PDT (UTC-7) until 1 November 2026, then PST (UTC-8).
  vi.setSystemTime(new Date(`${date}T08:00:00${date < "2026-11-01" ? "-07:00" : "-08:00"}`));
  await household.morningPushes();
  vi.useRealTimers();
}

const dinners = (week: Week): Slot[] => week.slots.filter((slot) => slot.meal === "dinner");

// Saturday 31 October 2026 is two days before Monday 2 November.
const SATURDAY = "2026-10-31";
const NEXT_MONDAY = "2026-11-02";

describe("a device's notifications", () => {
  test("a device subscribes with the deployment's key, for the kinds it chooses", async () => {
    const household = await setUpHousehold();
    expect(value<PushKey>(await household.callTool("get_push_key", {}))).toEqual({ publicKey });

    const device = await subscribed(household, ["prep_ahead", "weekly_proposal"]);

    expect(await household.callTool("get_push_device", { endpoint: device.endpoint })).toEqual({
      ok: true,
      value: { endpoint: device.endpoint, kinds: ["weekly_proposal", "prep_ahead"] },
    });
  });

  test("subscribing again changes the kinds, and unsubscribing turns them all off", async () => {
    const household = await setUpHousehold();
    const device = await subscribed(household);

    await household.callTool("subscribe_push", { ...subscriptionOf(device), kinds: ["checkin_due"] });
    expect(value<PushDevice>(await household.callTool("get_push_device", { endpoint: device.endpoint })).kinds).toEqual(
      ["checkin_due"],
    );

    expect(await household.callTool("unsubscribe_push", { endpoint: device.endpoint })).toMatchObject({ ok: true });
    expect(await household.callTool("get_push_device", { endpoint: device.endpoint })).toEqual({
      ok: true,
      value: null,
    });
    expect(await household.callTool("unsubscribe_push", { endpoint: device.endpoint })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });

  test("a deployment without a VAPID key says so", async () => {
    usePush(() => null);
    const household = await setUpHousehold();

    expect(await household.callTool("get_push_key", {})).toMatchObject({
      ok: false,
      error: { code: "not_configured" },
    });
  });

  test("a subscription that is not a push service's is refused", async () => {
    const household = await setUpHousehold();
    const device = await newDevice("http://push.example.com/insecure");

    expect(await household.callTool("subscribe_push", { ...subscriptionOf(device), kinds: EVERY_KIND })).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
  });
});

describe("the week Mise proposes itself", () => {
  test("two days before a Week nobody has started, it is proposed and every device that chose it is told", async () => {
    const household = await setUpHousehold();
    const told = await subscribed(household, ["weekly_proposal"]);
    const notTold = await subscribed(household, ["prep_ahead"]);

    await morningOf(household, SATURDAY);

    const week = value<Week>(await household.callTool("get_week", { date: NEXT_MONDAY }));
    expect(week.proposalSeed).not.toBeNull();
    expect(dinners(week).every((slot) => slot.kind === "recipe")).toBe(true);
    expect(service.received(told.endpoint)).toEqual([
      {
        kind: "weekly_proposal",
        title: "Next week is proposed",
        body: "7 dinners from Monday, November 2. Review it before you shop.",
        url: "/?week=next",
      },
    ]);
    expect(service.received(notTold.endpoint)).toEqual([]);
  });

  test("a Week someone has started is never proposed again", async () => {
    const household = await setUpHousehold();
    const device = await subscribed(household);
    // One dinner decided by hand, even as eating out, starts the Week.
    await household.callTool("set_slot", { date: "2026-11-04", meal: "dinner", kind: "eat_out" });
    const before = value<Week>(await household.callTool("get_week", { date: NEXT_MONDAY }));

    await morningOf(household, SATURDAY);

    expect(value<Week>(await household.callTool("get_week", { date: NEXT_MONDAY }))).toEqual(before);
    expect(service.received(device.endpoint).map((message) => message.kind)).not.toContain("weekly_proposal");
  });

  test("a Week already proposed is not rolled again", async () => {
    const household = await setUpHousehold();
    const proposed = value<Week>(await household.callTool("propose_week", { date: NEXT_MONDAY, reroll: true }));

    await morningOf(household, SATURDAY);

    expect(value<Week>(await household.callTool("get_week", { date: NEXT_MONDAY }))).toEqual(proposed);
  });

  test("a breakfast or lunch planned does not start the Week", async () => {
    const household = await setUpHousehold();
    await household.callTool("set_slot", { date: NEXT_MONDAY, meal: "lunch", kind: "eat_out" });

    await morningOf(household, SATURDAY);

    const week = value<Week>(await household.callTool("get_week", { date: NEXT_MONDAY }));
    expect(dinners(week).every((slot) => slot.kind === "recipe")).toBe(true);
  });

  test("no other morning proposes a Week", async () => {
    const household = await setUpHousehold();
    const device = await subscribed(household);

    await morningOf(household, "2026-10-30");
    await morningOf(household, "2026-11-01");

    expect(value<Week>(await household.callTool("get_week", { date: NEXT_MONDAY })).proposalSeed).toBeNull();
    expect(service.received(device.endpoint)).toEqual([]);
  });

  test("after a change of week start, it is proposed two days before the new start day", async () => {
    const household = await setUpHousehold();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-28T12:00:00-07:00"));
    // From Wednesday 28 October, Weeks start on Thursday: this Week runs on to Wednesday 4 November.
    await household.callTool("update_household_settings", { weekStartsOn: "thursday" });
    vi.useRealTimers();

    await morningOf(household, SATURDAY);
    expect(value<Week>(await household.callTool("get_week", { date: NEXT_MONDAY })).proposalSeed).toBeNull();

    await morningOf(household, "2026-11-03");
    const week = value<Week>(await household.callTool("get_week", { date: "2026-11-05" }));
    expect(week.startDate).toBe("2026-11-05");
    expect(week.proposalSeed).not.toBeNull();
  });

  test("a Household with nothing to propose is not told its Week is proposed", async () => {
    const household = env.Household.getByName(crypto.randomUUID());
    await household.callTool("setup_household", { name: "The Example Family", timezone: "America/Vancouver" });
    const device = await subscribed(household);

    await morningOf(household, SATURDAY);

    expect(service.received(device.endpoint)).toEqual([]);
  });
});

describe("the morning's other notifications", () => {
  test("with the proposal, a Check-in is due when Staples are", async () => {
    const household = await setUpHousehold();
    for (const item of ["egg", "garlic"]) await household.callTool("upsert_staple", { item });
    const device = await subscribed(household, ["checkin_due"]);

    await morningOf(household, "2026-10-30");
    expect(service.received(device.endpoint)).toEqual([]);

    await morningOf(household, SATURDAY);
    expect(service.received(device.endpoint)).toEqual([
      {
        kind: "checkin_due",
        title: "Pantry check: 2 Staples",
        body: "See what's running low before the Grocery List is built.",
        url: "/?pantry",
      },
    ]);
  });

  test("no Check-in is asked for when no Staple is due", async () => {
    const household = await setUpHousehold();
    const device = await subscribed(household, ["checkin_due"]);

    await morningOf(household, SATURDAY);

    expect(service.received(device.endpoint)).toEqual([]);
  });

  test("the day before a dinner whose Recipe has a Prep-ahead note, the note is pushed", async () => {
    const household = await setUpHousehold();
    const chana = value<{ id: number }>(
      await household.callTool("create_recipe", {
        title: "Chana masala",
        baseServings: 4,
        ingredients: ["2 cups dried chickpeas"],
        prepAhead: "Soak the chickpeas overnight.",
      }),
    );
    await household.callTool("set_slot", { date: "2026-10-28", meal: "dinner", kind: "recipe", recipeId: chana.id });
    const device = await subscribed(household, ["prep_ahead"]);

    await morningOf(household, "2026-10-26");
    expect(service.received(device.endpoint)).toEqual([]);

    await morningOf(household, "2026-10-27");
    expect(service.received(device.endpoint)).toEqual([
      {
        kind: "prep_ahead",
        title: "For tomorrow: Chana masala",
        body: "Soak the chickpeas overnight.",
        url: `/?recipe=${chana.id}`,
      },
    ]);
  });

  test("a device its push service no longer knows is forgotten; the others are still told", async () => {
    const household = await setUpHousehold();
    const gone = await subscribed(household);
    const kept = await subscribed(household);
    service.forget(gone.endpoint);

    await morningOf(household, SATURDAY);

    expect(await household.callTool("get_push_device", { endpoint: gone.endpoint })).toEqual({ ok: true, value: null });
    expect(service.received(kept.endpoint)).toHaveLength(1);
  });

  test("a push service that refuses one device leaves it subscribed, and the others are still told", async () => {
    const household = await setUpHousehold();
    const refused = await subscribed(household);
    const told = await subscribed(household);
    service.refuse(refused.endpoint);

    await morningOf(household, SATURDAY);

    expect(
      value<PushDevice | null>(await household.callTool("get_push_device", { endpoint: refused.endpoint })),
    ).not.toBeNull();
    expect(service.received(told.endpoint)).toHaveLength(1);
    expect((await schedules(household)).map((schedule) => schedule.callback)).toContain("morningPushes");
  });

  test("the morning runs at 08:00 Household time", async () => {
    const household = await setUpHousehold();

    const morning = (await schedules(household)).find((schedule) => schedule.callback === "morningPushes");

    const next = new Date(morning ? morning.time * 1000 : 0);
    expect(
      new Intl.DateTimeFormat("en-CA", { timeZone: "America/Vancouver", timeStyle: "short", hourCycle: "h23" }).format(
        next,
      ),
    ).toBe("08:00");
  });
});

describe("devices in the export", () => {
  const HOUSEHOLD_URL = "https://mise.example.com/agents/household/household";

  test("a restored Household keeps its devices, and still tells them", async () => {
    const original = await setUpHousehold();
    const device = await subscribed(original, ["weekly_proposal"]);
    const exported = await (await original.fetch(`${HOUSEHOLD_URL}/export`)).text();
    expect(JSON.parse(exported).tables.push_subscription).toEqual([
      expect.objectContaining({ endpoint: device.endpoint, kinds: '["weekly_proposal"]' }),
    ]);

    const restored = env.Household.getByName(crypto.randomUUID());
    const response = await restored.fetch(`${HOUSEHOLD_URL}/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: exported,
    });
    expect(response.status).toBe(200);

    await morningOf(restored, SATURDAY);
    expect(service.received(device.endpoint).map((message) => message.kind)).toEqual(["weekly_proposal"]);
  });

  test("a restore refuses a device with a kind Mise does not know", async () => {
    const original = await setUpHousehold();
    await subscribed(original);
    const exported = JSON.parse(await (await original.fetch(`${HOUSEHOLD_URL}/export`)).text());
    exported.tables.push_subscription[0].kinds = '["horoscope"]';

    const response = await env.Household.getByName(crypto.randomUUID()).fetch(`${HOUSEHOLD_URL}/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(exported),
    });

    expect(response.status).toBe(400);
  });
});
