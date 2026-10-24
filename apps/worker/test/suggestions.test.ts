import { env } from "cloudflare:workers";
import { FakeLlm, SUGGESTION_BATCH_SIZE, type SuggestedItem, type ToolResult } from "@mise/domain";
import { describe, expect, test, vi } from "vitest";
import { paprikaExport } from "../../../fixtures/paprika";
import { useLlm } from "../src/llm";

const householdUrl = "http://mise.example.com/agents/household/household";

type HouseholdStub = ReturnType<typeof env.Household.getByName>;

const gochujang: Extract<SuggestedItem, { kind: "new" }> = {
  kind: "new",
  name: "gochujang",
  section: "international",
  unitFamily: "volume",
  allergens: ["wheat", "soy"],
};

/** The test's households ask `llm`; test/setup.ts puts the next test back on a fake with no answers. */
function withLlm(llm: FakeLlm): FakeLlm {
  useLlm(() => llm);
  return llm;
}

/** A Household with two Recipes that share Unresolved "beurre", plus "gochujang" and "mystery spread". */
async function householdWithUnresolved(): Promise<HouseholdStub> {
  const household = env.Household.getByName(crypto.randomUUID());
  await household.callTool("setup_household", { name: "The Example Family" });
  await household.callTool("create_recipe", {
    title: "Bibimbap",
    baseServings: 2,
    ingredients: ["2 tbsp gochujang", "1 tbsp beurre", "1 cup rice"],
  });
  await household.callTool("create_recipe", {
    title: "Toast",
    baseServings: 2,
    ingredients: ["1 tbsp Beurre, softened", "1 tbsp mystery spread"],
  });
  return household;
}

function succeeded<T>(result: ToolResult<unknown>): T {
  if (!result.ok) throw new Error(`Expected the tool call to succeed: ${result.error.message}`);
  return result.value as T;
}

async function suggestionIdFor(household: HouseholdStub, text: string): Promise<number> {
  const listed = succeeded<{ id: number; text: string }[]>(await household.callTool("list_suggestions", {}));
  const found = listed.find((suggestion) => suggestion.text === text);
  if (!found) throw new Error(`No Suggestion for ${text}`);
  return found.id;
}

describe("requesting Suggestions", () => {
  test("asks the model about each Unresolved text with the catalogue, and lists what it suggests", async () => {
    const llm = withLlm(new FakeLlm({ beurre: { kind: "existing", item: "butter" }, gochujang }));
    const household = await householdWithUnresolved();

    const requested = await household.callTool("request_suggestions", {});

    expect(requested).toMatchObject({
      ok: true,
      value: {
        suggestions: [
          { text: "beurre", suggested: { kind: "existing", item: "butter" } },
          { text: "gochujang", suggested: gochujang },
        ],
        remaining: 0,
      },
    });
    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]?.names).toEqual(["beurre", "gochujang", "mystery spread"]);
    expect(llm.requests[0]?.catalogue).toContainEqual(expect.objectContaining({ id: "butter" }));
    expect(await household.callTool("list_suggestions", {})).toMatchObject({
      ok: true,
      value: [
        { text: "beurre", suggested: { kind: "existing", item: "butter" } },
        { text: "gochujang", suggested: gochujang },
      ],
    });
  });

  test("a Suggestion changes nothing: its Ingredients stay Unresolved and their Recipes fail closed", async () => {
    withLlm(new FakeLlm({ beurre: { kind: "existing", item: "butter" }, gochujang }));
    const household = await householdWithUnresolved();

    await household.callTool("request_suggestions", {});

    expect(await household.callTool("get_recipe", { id: 1 })).toMatchObject({
      ok: true,
      value: {
        ingredients: [{ item: null }, { item: null }, { item: "rice" }],
        allergens: { kind: "unknown", unresolved: 2 },
      },
    });
    expect(await household.callTool("list_unresolved_ingredients", {})).toMatchObject({
      ok: true,
      value: [{ text: "beurre" }, { text: "gochujang" }, { text: "mystery spread" }],
    });
  });

  test("asks one batch per call, and says how many texts have still had no Suggestion", async () => {
    const llm = withLlm(new FakeLlm({}));
    const household = env.Household.getByName(crypto.randomUUID());
    await household.callTool("setup_household", { name: "The Example Family" });
    const lines = Array.from({ length: SUGGESTION_BATCH_SIZE + 2 }, (_, i) => `1 tbsp mystery ${i}`);
    await household.callTool("create_recipe", { title: "Everything", baseServings: 2, ingredients: lines });

    const first = await household.callTool("request_suggestions", {});

    expect(first).toMatchObject({ ok: true, value: { suggestions: [], remaining: 2 } });
    expect(llm.requests.map((request) => request.names.length)).toEqual([SUGGESTION_BATCH_SIZE]);
    expect(await household.callTool("request_suggestions", {})).toMatchObject({ ok: true, value: { remaining: 0 } });
    expect(llm.requests.map((request) => request.names.length)).toEqual([SUGGESTION_BATCH_SIZE, 2]);
  });

  test("a model that fails is refused with model_failed, and nothing is stored", async () => {
    const llm = withLlm(new FakeLlm({ gochujang }));
    llm.failing = true;
    const household = await householdWithUnresolved();

    const requested = await household.callTool("request_suggestions", {});

    expect(requested).toMatchObject({ ok: false, error: { code: "model_failed" } });
    expect(await household.callTool("list_suggestions", {})).toEqual({ ok: true, value: [] });
  });

  test("asking about given texts asks again, replacing their Suggestions", async () => {
    const llm = withLlm(new FakeLlm({ gochujang }));
    const household = await householdWithUnresolved();
    await household.callTool("request_suggestions", {});

    const again = await household.callTool("request_suggestions", { texts: ["Gochujang"] });

    expect(llm.requests.at(-1)?.names).toEqual(["gochujang"]);
    expect(again).toMatchObject({ ok: true, value: { suggestions: [{ text: "gochujang" }] } });
    expect(succeeded<unknown[]>(await household.callTool("list_suggestions", {}))).toHaveLength(1);
  });
});

describe("accepting a Suggestion", () => {
  test("of an existing Item resolves every matching Ingredient in every Recipe", async () => {
    withLlm(new FakeLlm({ beurre: { kind: "existing", item: "butter" } }));
    const household = await householdWithUnresolved();
    await household.callTool("request_suggestions", {});

    const accepted = await household.callTool("accept_suggestion", {
      id: await suggestionIdFor(household, "beurre"),
    });

    expect(accepted).toMatchObject({ ok: true, value: { item: { id: "butter" }, resolved: 2 } });
    expect(await household.callTool("get_recipe", { id: 2 })).toMatchObject({
      ok: true,
      value: { ingredients: [{ item: "butter" }, { item: null }] },
    });
    expect(await household.callTool("list_suggestions", {})).toEqual({ ok: true, value: [] });
  });

  test("of a new Item, as a person edited it, creates the Item with their Allergens and resolves its lines", async () => {
    withLlm(new FakeLlm({ gochujang }));
    const household = await householdWithUnresolved();
    await household.callTool("request_suggestions", {});

    const accepted = await household.callTool("accept_suggestion", {
      id: await suggestionIdFor(household, "gochujang"),
      suggested: { ...gochujang, name: "Korean chili paste", allergens: ["wheat", "soy", "sesame"] },
    });

    expect(accepted).toMatchObject({
      ok: true,
      value: {
        item: {
          id: "household:1",
          name: "Korean chili paste",
          aliases: ["gochujang"],
          allergens: ["wheat", "soy", "sesame"],
        },
        resolved: 1,
      },
    });
    expect(await household.callTool("get_recipe", { id: 1 })).toMatchObject({
      ok: true,
      value: { ingredients: [{ item: "household:1" }, { item: null }, { item: "rice" }] },
    });
  });

  test("of a new Item with no Allergens needs a person to state them, as creating one by hand does", async () => {
    withLlm(new FakeLlm({ "mystery spread": { ...gochujang, name: "mystery spread", allergens: [] } }));
    const household = await householdWithUnresolved();
    await household.callTool("request_suggestions", {});
    const id = await suggestionIdFor(household, "mystery spread");

    expect(await household.callTool("accept_suggestion", { id })).toMatchObject({
      ok: false,
      error: { code: "invalid_input", issues: [{ path: "suggested" }] },
    });
    expect(await household.callTool("get_recipe", { id: 2 })).toMatchObject({
      ok: true,
      value: { ingredients: [{ item: null }, { item: null }] },
    });
    expect(
      await household.callTool("accept_suggestion", {
        id,
        suggested: { ...gochujang, name: "mystery spread", allergens: [] },
      }),
    ).toMatchObject({ ok: true, value: { item: { allergens: [] }, resolved: 1 } });
  });

  test("refuses a Suggestion already accepted", async () => {
    withLlm(new FakeLlm({ gochujang }));
    const household = await householdWithUnresolved();
    await household.callTool("request_suggestions", {});
    const id = await suggestionIdFor(household, "gochujang");
    await household.callTool("accept_suggestion", { id });

    expect(await household.callTool("accept_suggestion", { id })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });

  test("a Suggestion whose text was resolved by hand is no longer listed", async () => {
    withLlm(new FakeLlm({ gochujang }));
    const household = await householdWithUnresolved();
    await household.callTool("request_suggestions", {});

    await household.callTool("create_item", {
      name: "gochujang",
      section: "international",
      allergens: ["soy"],
      unitFamily: "volume",
    });

    expect(await household.callTool("list_suggestions", {})).toEqual({ ok: true, value: [] });
  });
});

describe("dismissing a Suggestion", () => {
  test("drops it from the list and keeps it from being asked about again, unless asked by name", async () => {
    const llm = withLlm(new FakeLlm({ gochujang }));
    const household = await householdWithUnresolved();
    await household.callTool("request_suggestions", {});

    const dismissed = await household.callTool("dismiss_suggestion", {
      id: await suggestionIdFor(household, "gochujang"),
    });

    expect(dismissed).toMatchObject({ ok: true, value: { text: "gochujang" } });
    expect(await household.callTool("list_suggestions", {})).toEqual({ ok: true, value: [] });
    expect(await household.callTool("list_unresolved_ingredients", {})).toMatchObject({
      ok: true,
      value: [{ text: "beurre" }, { text: "gochujang" }, { text: "mystery spread" }],
    });
    // Every text has been asked about once: dismissed, or with no answer.
    expect(await household.callTool("request_suggestions", {})).toMatchObject({ ok: true, value: { remaining: 0 } });
    expect(llm.requests).toHaveLength(1);
    await household.callTool("request_suggestions", { texts: ["gochujang"] });
    expect(succeeded<unknown[]>(await household.callTool("list_suggestions", {}))).toHaveLength(1);
  });
});

describe("Suggestions after an import", () => {
  test("are requested for the new Unresolved Ingredients the import brought", async () => {
    const llm = withLlm(new FakeLlm({ "mystery masala": gochujang }));
    const household = await householdWithUnresolved();
    const response = await household.fetch(`${householdUrl}/imports/paprika`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: await paprikaExport([
        { uid: "dal", name: "Dal", ingredients: "1 cup red lentils\n1 tsp mystery masala\n1 tbsp beurre", hash: "1" },
      ]),
    });
    const { upload } = (await response.json()) as { upload: string };

    succeeded(await household.callTool("run_paprika_import", { upload }));

    await vi.waitFor(async () => {
      expect(await household.callTool("list_suggestions", {})).toMatchObject({
        ok: true,
        value: [{ text: "mystery masala", suggested: gochujang }],
      });
    });
    // Only the import's own Unresolved texts, and only those never asked about.
    expect(llm.requests.map((request) => request.names)).toEqual([["mystery masala", "beurre"]]);
  });
});

describe("export and restore", () => {
  test("carry Suggestions, and refuse one naming an Item the Household does not have", async () => {
    withLlm(new FakeLlm({ beurre: { kind: "existing", item: "butter" }, gochujang }));
    const household = await householdWithUnresolved();
    await household.callTool("request_suggestions", {});
    const exported = await (await household.fetch(`${householdUrl}/export`)).text();

    const restore = (body: string) =>
      env.Household.getByName(crypto.randomUUID()).fetch(`${householdUrl}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });

    expect((await restore(exported)).status).toBe(200);
    const unknownItem = JSON.parse(exported);
    for (const row of unknownItem.tables.suggestion) {
      row.suggested = row.suggested?.replace('"butter"', '"household:99"');
    }
    const refused = await restore(JSON.stringify(unknownItem));
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ code: "invalid_export" });
  });
});
