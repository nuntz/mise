import { env } from "cloudflare:workers";
import { exportKey, localDate, nextOccurrence } from "@mise/domain";
import { describe, expect, onTestFinished, test } from "vitest";
import sampleHousehold from "../../../fixtures/sample-household.json";

const householdUrl = "http://mise.example.com/agents/household/household";

function freshHousehold() {
  return env.Household.getByName(crypto.randomUUID());
}

type HouseholdStub = ReturnType<typeof freshHousehold>;

async function exportOf(household: HouseholdStub): Promise<string> {
  const response = await household.fetch(`${householdUrl}/export`);
  expect(response.status).toBe(200);
  return response.text();
}

function restore(household: HouseholdStub, body: string): Promise<Response> {
  return household.fetch(`${householdUrl}/restore`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

describe("export and restore", () => {
  test("export → restore into a fresh deployment → export gives an identical file", async () => {
    const original = freshHousehold();
    await original.callTool("setup_household", sampleHousehold);
    const exported = await exportOf(original);

    const fresh = freshHousehold();
    const restored = await restore(fresh, exported);

    expect(restored.status).toBe(200);
    expect(await exportOf(fresh)).toBe(exported);
    expect(await fresh.callTool("get_household", {})).toMatchObject({
      ok: true,
      value: { name: sampleHousehold.name, members: [{ name: "Robin" }, { name: "Alex" }, { name: "Sam" }] },
    });
  });

  test("a removed Member's id is not handed out again after a restore", async () => {
    const original = freshHousehold();
    await original.callTool("setup_household", sampleHousehold);
    const sam = 3;
    await original.callTool("remove_member", { id: sam });
    const exported = await exportOf(original);
    const fresh = freshHousehold();
    await restore(fresh, exported);
    expect(await exportOf(fresh)).toBe(exported);

    const added = await fresh.callTool("add_member", { name: "Jordan" });

    expect(added).toMatchObject({ ok: true, value: { id: 4, name: "Jordan" } });
  });

  test("restore refuses a household that already holds data", async () => {
    const source = freshHousehold();
    await source.callTool("setup_household", sampleHousehold);
    const exported = await exportOf(source);
    const target = freshHousehold();
    await target.callTool("setup_household", { name: "Someone Else" });

    const response = await restore(target, exported);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "not_empty" });
    expect(await target.callTool("get_household", {})).toMatchObject({ ok: true, value: { name: "Someone Else" } });
  });

  test("an export covers the Household's tables and nothing of the SDK's", async () => {
    const household = freshHousehold();
    await household.callTool("setup_household", sampleHousehold);

    const exported = JSON.parse(await exportOf(household));

    expect(exported).toEqual({
      format: "mise.household-export",
      version: 2,
      schemaVersion: 2,
      tables: {
        household: [
          {
            id: 1,
            name: "The Example Family",
            timezone: "America/Vancouver",
            dinner_time: "18:00",
            week_starts_on: "monday",
            units: "metric",
            locale: "en-CA",
          },
        ],
        member: [
          { id: 1, name: "Robin", email: "cook@example.com" },
          { id: 2, name: "Alex", email: "alex@example.com" },
          { id: 3, name: "Sam", email: null },
        ],
        member_constraint: [
          { member_id: 1, position: 0, kind: "dislike", allergen: null, term: "olives" },
          { member_id: 2, position: 0, kind: "intolerance", allergen: "milk", term: "lactose" },
          { member_id: 3, position: 0, kind: "allergy", allergen: "peanut", term: null },
        ],
      },
      sequences: { member: 3 },
      photoKeys: [],
    });
  });

  test("an export lists the photos stored in R2", async () => {
    const household = freshHousehold();
    await env.BUCKET.put("photos/recipe-1.jpg", "jpeg");
    await env.BUCKET.put("exports/2026-10-20.json", "{}");
    onTestFinished(() => env.BUCKET.delete(["photos/recipe-1.jpg", "exports/2026-10-20.json"]));

    const exported = JSON.parse(await exportOf(household));

    expect(exported.photoKeys).toEqual(["photos/recipe-1.jpg"]);
  });

  test.each([
    ["not JSON", "{"],
    ["not an export", JSON.stringify({ hello: "world" })],
    ["a future export format", JSON.stringify({ format: "mise.household-export", version: 3 })],
  ])("restore rejects a body that is %s", async (_, body) => {
    const household = freshHousehold();

    const response = await restore(household, body);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_export" });
  });

  test("restore only accepts a JSON body, so a cross-site form cannot post one", async () => {
    const source = freshHousehold();
    await source.callTool("setup_household", sampleHousehold);
    const exported = await exportOf(source);
    const target = freshHousehold();

    const response = await target.fetch(`${householdUrl}/restore`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: exported,
    });

    expect(response.status).toBe(415);
    expect(await target.callTool("get_household", {})).toEqual({ ok: true, value: null });
  });

  test("restore rejects an export with a column the schema does not have, loading nothing", async () => {
    const source = freshHousehold();
    await source.callTool("setup_household", sampleHousehold);
    const exported = JSON.parse(await exportOf(source));
    exported.tables.household[0].favourite_colour = "green";
    const target = freshHousehold();

    const response = await restore(target, JSON.stringify(exported));

    expect(response.status).toBe(400);
    expect(await target.callTool("get_household", {})).toEqual({ ok: true, value: null });
  });

  test("restore rejects rows the Household cannot read, leaving it empty for a corrected export", async () => {
    const source = freshHousehold();
    await source.callTool("setup_household", sampleHousehold);
    const exported = JSON.parse(await exportOf(source));
    const valid = JSON.stringify(exported);
    exported.tables.household[0].timezone = "Mars/Olympus_Mons";
    const target = freshHousehold();

    const response = await restore(target, JSON.stringify(exported));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_export" });
    expect(await target.callTool("get_household", {})).toEqual({ ok: true, value: null });
    expect((await restore(target, valid)).status).toBe(200);
    expect(await exportOf(target)).toBe(await exportOf(source));
  });

  test("restore rejects a malformed Constraint even when the export has no Household settings", async () => {
    const source = freshHousehold();
    await source.callTool("setup_household", sampleHousehold);
    const exported = JSON.parse(await exportOf(source));
    exported.tables.household = [];
    exported.tables.member_constraint[2].allergen = "unicorn";
    const target = freshHousehold();

    const response = await restore(target, JSON.stringify(exported));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_export" });
  });

  test("restore rejects an export from another schema version", async () => {
    const source = freshHousehold();
    await source.callTool("setup_household", sampleHousehold);
    const exported = JSON.parse(await exportOf(source));
    exported.schemaVersion = 99;

    const response = await restore(freshHousehold(), JSON.stringify(exported));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "schema_mismatch" });
  });
});

describe("nightly export", () => {
  test("setting up the Household schedules the export for 03:00 Household time", async () => {
    const household = freshHousehold();
    await household.callTool("setup_household", { name: "The Example Family", timezone: "Asia/Tokyo" });

    const schedules = await household.listSchedules();

    const expected = nextOccurrence(new Date(), "03:00", "Asia/Tokyo");
    expect(schedules).toEqual([
      expect.objectContaining({ callback: "nightlyExport", time: expected.getTime() / 1000 }),
    ]);
  });

  test("the nightly export writes the export to R2 under the Household's date and schedules the next", async () => {
    const household = freshHousehold();
    await household.callTool("setup_household", sampleHousehold);
    const key = exportKey(localDate(new Date(), sampleHousehold.timezone));
    onTestFinished(() => env.BUCKET.delete(key));

    await household.nightlyExport();

    const stored = await env.BUCKET.get(key);
    expect(await stored?.text()).toBe(await exportOf(household));
    expect(await household.listSchedules()).toEqual([expect.objectContaining({ callback: "nightlyExport" })]);
  });

  test("nothing is scheduled before the Household is set up", async () => {
    expect(await freshHousehold().listSchedules()).toEqual([]);
  });
});
