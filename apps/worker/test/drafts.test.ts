import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  type Draft,
  FakeLlm,
  type GroceryList,
  type ImportFlag,
  type Recipe,
  type RecipeReading,
  type RecipeSummary,
  type ToolOutput,
  type ToolResult,
} from "@mise/domain";
import { describe, expect, test, vi } from "vitest";
import { useLlm } from "../src/llm";

const householdUrl = "http://mise.example.com/agents/household/household";

type HouseholdStub = ReturnType<typeof env.Household.getByName>;

// Monday 26 October 2026, and the day after.
const MONDAY = "2026-10-26";
const TUESDAY = "2026-10-27";
const dinner = (date: string) => ({ date, meal: "dinner" }) as const;

const CAPTION = "Grandma's dal 🍲 serves 4, ready in 40 min\n1 cup red lentils\n2 tbsp ghee\n1 tsp mystery masala";

const dal: RecipeReading = {
  isRecipe: true,
  title: "Grandma's dal",
  ingredients: ["1 cup red lentils", "2 tbsp ghee", "1 tsp mystery masala"],
  steps: ["Simmer the lentils.", "Temper with ghee."],
  servings: 4,
  minutes: 40,
  course: "main",
};

/** The test's households read every text as `reading`; test/setup.ts puts the next test back on a fake. */
function withReading(reading: RecipeReading): FakeLlm {
  const llm = new FakeLlm();
  llm.reading = reading;
  useLlm(() => llm);
  return llm;
}

async function newHousehold(): Promise<HouseholdStub> {
  const household = env.Household.getByName(crypto.randomUUID());
  await household.callTool("setup_household", { name: "The Example Family", weekStartsOn: "monday" });
  return household;
}

function succeeded<T>(result: ToolResult<unknown>): T {
  if (!result.ok) throw new Error(`Expected the tool call to succeed: ${result.error.message}`);
  return result.value as T;
}

/** Pastes `text` and returns the Draft it made. */
async function importDraft(household: HouseholdStub, text = CAPTION): Promise<Recipe> {
  const imported = succeeded<ToolOutput<"import_text">>(await household.callTool("import_text", { text }));
  if (!imported.recipe) throw new Error("Expected the text to make a Draft");
  return succeeded<Recipe>(await household.callTool("get_recipe", { id: imported.recipe.id }));
}

describe("importing pasted text", () => {
  test("makes a Draft of what the model read, its lines parsed by Mise and its Course the model's guess", async () => {
    const llm = withReading(dal);
    const household = await newHousehold();

    const imported = await household.callTool("import_text", { text: `  ${CAPTION}  ` });

    expect(imported).toMatchObject({
      ok: true,
      value: {
        run: { source: "text", created: 1, updated: 0, skipped: 0, flagged: 0, errors: [] },
        recipe: { title: "Grandma's dal" },
      },
    });
    expect(llm.readings).toEqual([{ text: CAPTION }]);
    const id = succeeded<ToolOutput<"import_text">>(imported).recipe?.id;
    expect(await household.callTool("get_recipe", { id })).toMatchObject({
      ok: true,
      value: {
        draft: true,
        title: "Grandma's dal",
        baseServings: 4,
        effortMinutes: 40,
        course: "main",
        steps: ["Simmer the lentils.", "Temper with ghee."],
        notes: CAPTION,
        source: { kind: "text" },
        ingredients: [
          { raw: "1 cup red lentils", amount: { min: 1, max: 1 }, unit: "cup", item: "dried_lentils" },
          { raw: "2 tbsp ghee", amount: { min: 2, max: 2 }, unit: "tbsp", item: "ghee" },
          { raw: "1 tsp mystery masala", item: null },
        ],
      },
    });
    expect(await household.callTool("list_import_runs", {})).toMatchObject({ ok: true, value: [{ source: "text" }] });
  });

  test("skips text pasted before, keeping the one Draft", async () => {
    withReading(dal);
    const household = await newHousehold();
    const first = await importDraft(household);

    const again = await household.callTool("import_text", { text: CAPTION });

    expect(again).toMatchObject({
      ok: true,
      value: { run: { created: 0, skipped: 1 }, recipe: { id: first.id, title: "Grandma's dal" } },
    });
    expect(succeeded<Draft[]>(await household.callTool("list_drafts", {}))).toHaveLength(1);
  });

  test("makes nothing of text that holds no recipe, and logs why", async () => {
    withReading({ isRecipe: false });
    const household = await newHousehold();

    const imported = await household.callTool("import_text", { text: "Recipe in bio! 🔗" });

    expect(imported).toMatchObject({
      ok: true,
      value: { run: { created: 0, errors: [{ entry: null, message: "The text holds no recipe" }] }, recipe: null },
    });
    expect(await household.callTool("list_drafts", {})).toEqual({ ok: true, value: [] });
  });

  test("is refused with model_failed when the model fails, and logs nothing", async () => {
    withReading(dal).failing = true;
    const household = await newHousehold();

    expect(await household.callTool("import_text", { text: CAPTION })).toMatchObject({
      ok: false,
      error: { code: "model_failed" },
    });
    expect(await household.callTool("list_import_runs", {})).toEqual({ ok: true, value: [] });
  });

  test("asks for Suggestions for the Unresolved Ingredients the Draft brought", async () => {
    const llm = withReading(dal);
    const household = await newHousehold();

    await importDraft(household);

    await vi.waitFor(() => expect(llm.requests.map((request) => request.names)).toEqual([["mystery masala"]]));
  });
});

describe("Drafts", () => {
  test("are listed newest first, and left out of the Recipes search", async () => {
    withReading(dal);
    const household = await newHousehold();
    await household.callTool("create_recipe", { title: "Toast", baseServings: 1, ingredients: ["1 slice bread"] });
    await importDraft(household);
    withReading({ ...dal, title: "Chana masala" });
    await importDraft(household, "Chana masala, serves 4");

    const drafts = succeeded<Draft[]>(await household.callTool("list_drafts", {}));

    expect(drafts.map((draft) => draft.recipe.title)).toEqual(["Chana masala", "Grandma's dal"]);
    const search = succeeded<RecipeSummary[]>(await household.callTool("search_recipes", {}));
    expect(search.map((recipe) => recipe.title)).toEqual(["Toast"]);
  });

  test("that look like a Recipe already kept show it, and are flagged as an import's duplicates are", async () => {
    withReading(dal);
    const household = await newHousehold();
    const kept = succeeded<Recipe>(
      await household.callTool("create_recipe", {
        title: "Grandma's Dal",
        baseServings: 4,
        ingredients: ["1 cup red lentils", "1 tbsp ghee"],
      }),
    );

    const draft = await importDraft(household);

    expect(succeeded<Draft[]>(await household.callTool("list_drafts", {}))).toMatchObject([
      { recipe: { id: draft.id }, duplicateOf: [{ id: kept.id, title: "Grandma's Dal" }] },
    ]);
    expect(succeeded<ImportFlag[]>(await household.callTool("list_import_flags", {}))).toMatchObject([
      { kind: "duplicate", recipe: { id: draft.id }, duplicateOf: { id: kept.id } },
    ]);
  });

  test("are not flagged as duplicates of another Draft, which is not kept until accepted", async () => {
    withReading(dal);
    const household = await newHousehold();
    await importDraft(household);

    await importDraft(household, `${CAPTION}\nFrom Aunt Meera.`);

    expect(succeeded<Draft[]>(await household.callTool("list_drafts", {})).map((draft) => draft.duplicateOf)).toEqual([
      [],
      [],
    ]);
  });

  test("stay Drafts when edited, and once accepted can be planned and searched", async () => {
    withReading(dal);
    const household = await newHousehold();
    const draft = await importDraft(household);
    const edited = await household.callTool("update_recipe", { id: draft.id, course: "side", baseServings: 6 });
    expect(edited).toMatchObject({ ok: true, value: { draft: true, course: "side", baseServings: 6 } });

    const accepted = await household.callTool("accept_draft", { id: draft.id });

    expect(accepted).toMatchObject({ ok: true, value: { id: draft.id, draft: false, course: "side" } });
    expect(await household.callTool("list_drafts", {})).toEqual({ ok: true, value: [] });
    expect(
      await household.callTool("set_slot", { ...dinner(MONDAY), kind: "recipe", recipeId: draft.id }),
    ).toMatchObject({ ok: true });
    expect(succeeded<RecipeSummary[]>(await household.callTool("search_recipes", {}))).toMatchObject([
      { id: draft.id },
    ]);
    expect(await household.callTool("accept_draft", { id: draft.id })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });

  test("are discarded as any Recipe is deleted", async () => {
    withReading(dal);
    const household = await newHousehold();
    const draft = await importDraft(household);

    expect(await household.callTool("delete_recipe", { id: draft.id, confirm: true })).toMatchObject({
      ok: true,
      value: { id: draft.id, title: "Grandma's dal" },
    });
    expect(await household.callTool("get_recipe", { id: draft.id })).toMatchObject({ ok: false });
  });

  test("are not planned", async () => {
    withReading(dal);
    const household = await newHousehold();
    const draft = await importDraft(household);

    expect(
      await household.callTool("set_slot", { ...dinner(MONDAY), kind: "recipe", recipeId: draft.id }),
    ).toMatchObject({ ok: false, error: { code: "draft_recipe" } });
    const week = succeeded<ToolOutput<"propose_week">>(await household.callTool("propose_week", { date: MONDAY }));
    expect(week.slots.some((slot) => slot.recipe?.id === draft.id)).toBe(false);
  });

  test("planned before they were Drafts get no Leftovers linked and nothing on the Grocery List", async () => {
    const household = await newHousehold();
    const stew = succeeded<Recipe>(
      await household.callTool("create_recipe", { title: "Stew", baseServings: 4, ingredients: ["400 g rice"] }),
    );
    succeeded(await household.callTool("set_slot", { ...dinner(MONDAY), kind: "recipe", recipeId: stew.id }));
    // As a later import of its source may make a Recipe a Draft again, to be looked at.
    await runInDurableObject(household, async (_household, state) => {
      state.storage.sql.exec("UPDATE recipe SET draft = 1 WHERE id = ?", stew.id);
    });

    expect(await household.callTool("link_leftovers", { ...dinner(TUESDAY), of: dinner(MONDAY) })).toMatchObject({
      ok: false,
      error: { code: "draft_recipe" },
    });
    const list = succeeded<GroceryList>(await household.callTool("build_grocery_list", { date: MONDAY }));
    expect(list.sections).toEqual([]);
  });

  test("are exported and restored", async () => {
    withReading(dal);
    const household = await newHousehold();
    const draft = await importDraft(household);
    const exported = await (await household.fetch(`${householdUrl}/export`)).text();

    const restored = env.Household.getByName(crypto.randomUUID());
    const response = await restored.fetch(`${householdUrl}/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: exported,
    });

    expect(response.status).toBe(200);
    expect(await restored.callTool("list_drafts", {})).toMatchObject({
      ok: true,
      value: [{ recipe: { id: draft.id, draft: true, title: "Grandma's dal" } }],
    });
  });
});
