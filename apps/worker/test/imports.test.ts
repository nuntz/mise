import { env } from "cloudflare:workers";
import type { ImportRun, Recipe, ToolResult, Week } from "@mise/domain";
import { describe, expect, onTestFinished, test } from "vitest";
import { paprikaExport, SAMPLE_JPEG, SAMPLE_PAPRIKA_RECIPES, utf8 } from "../../../fixtures/paprika";
import sampleExport from "../../../fixtures/sample.paprikarecipes";

const uploadUrl = "http://mise.example.com/agents/household/household/imports/paprika";

type HouseholdStub = ReturnType<typeof env.Household.getByName>;

async function setUpHousehold(): Promise<HouseholdStub> {
  const household = env.Household.getByName(crypto.randomUUID());
  await household.callTool("setup_household", { name: "The Example Family" });
  onTestFinished(() => deletePhotos());
  return household;
}

/** Content-addressed photos outlive a test's household, so each test clears the bucket's photos. */
async function deletePhotos() {
  const listed = await env.BUCKET.list({ prefix: "photos/" });
  if (listed.objects.length > 0) await env.BUCKET.delete(listed.objects.map((object) => object.key));
}

/** Uploads `file` as the PWA does, then runs the import on it. */
async function importFile(household: HouseholdStub, file: Uint8Array<ArrayBuffer>): Promise<ToolResult<unknown>> {
  const response = await household.fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: file,
  });
  if (!response.ok) throw new Error(`Upload refused: ${response.status}`);
  const { upload } = (await response.json()) as { upload: string };
  return household.callTool("run_paprika_import", { upload });
}

function succeeded<T>(result: ToolResult<unknown>): T {
  if (!result.ok) throw new Error(`Expected the tool call to succeed: ${result.error.message}`);
  return result.value as T;
}

async function recipes(household: HouseholdStub): Promise<Recipe[]> {
  const summaries = succeeded<{ id: number }[]>(await household.callTool("search_recipes", {}));
  return Promise.all(
    summaries.map(async ({ id }) => succeeded<Recipe>(await household.callTool("get_recipe", { id }))),
  );
}

const [dal, chicken, toast] = SAMPLE_PAPRIKA_RECIPES as [
  Record<string, unknown>,
  Record<string, unknown>,
  Record<string, unknown>,
];

describe("importing a Paprika export", () => {
  test("creates its Recipes, with their photos in R2, and logs the run", async () => {
    const household = await setUpHousehold();

    const run = succeeded<ImportRun>(await importFile(household, sampleExport));

    expect(run).toEqual({
      id: 1,
      source: "paprika",
      startedAt: expect.any(String),
      created: 4,
      updated: 0,
      skipped: 1,
      flagged: 0,
      errors: [],
    });
    const imported = await recipes(household);
    expect(imported.map((recipe) => recipe.title)).toEqual([
      "Fizzy Lemonade",
      "Sheet-pan Chicken",
      "Soggy Toast",
      "Weeknight Dal",
    ]);
    expect(imported.map((recipe) => recipe.course)).toEqual(["drink", null, null, "main"]);
    const weeknightDal = imported[3] as Recipe;
    expect(weeknightDal).toMatchObject({
      title: "Weeknight Dal",
      baseServings: 4,
      ingredients: [
        { raw: "1 cup red lentils" },
        { raw: "2 cloves garlic, minced", item: "garlic" },
        { raw: "1 tbsp ghee" },
      ],
      steps: ["Rinse the lentils.", "Simmer everything for 25 minutes."],
      tags: ["indian", "vegetarian", "weeknight"],
      effortMinutes: 35,
      cuisine: "indian",
      notes: "A pot of comfort.\n\nDouble the garlic.",
      importedPreference: "positive",
      editedInAppAt: null,
      source: {
        kind: "paprika",
        externalId: "6F1B2A44-0C3D-4E5F-8A9B-1C2D3E4F5A6B",
        url: "https://recipes.example.com/dal",
        author: "The Example Kitchen",
        importedAt: run.startedAt,
      },
    });
    expect(weeknightDal.photoKey).toMatch(/^photos\/sha256-[0-9a-f]{64}$/);
    const photo = (await env.BUCKET.get(weeknightDal.photoKey as string)) as R2ObjectBody;
    expect(photo.httpMetadata?.contentType).toBe("image/jpeg");
    expect(new Uint8Array(await photo.arrayBuffer())).toEqual(SAMPLE_JPEG);
    expect(await household.callTool("list_import_runs", {})).toEqual({ ok: true, value: [run] });
  });
});

describe("proposing from an import", () => {
  test("never fills a dinner with the drink it filed under Drinks, while a main is proposed", async () => {
    const household = env.Household.getByName(crypto.randomUUID());
    await household.callTool("setup_household", { name: "The Example Family", members: [{ name: "Robin" }] });
    onTestFinished(() => deletePhotos());
    await importFile(household, sampleExport);
    const byTitle = new Map((await recipes(household)).map((recipe) => [recipe.title, recipe.id]));

    const week = succeeded<Week>(await household.callTool("propose_week", { date: "2026-10-26" }));

    const dinners = week.slots.filter((slot) => slot.meal === "dinner");
    expect(dinners.map((dinner) => dinner.recipe?.id)).toContain(byTitle.get("Weeknight Dal"));
    expect(dinners.map((dinner) => dinner.recipe?.id)).not.toContain(byTitle.get("Fizzy Lemonade"));
    const unplanned = dinners.filter((dinner) => dinner.kind === "unplanned");
    expect(unplanned).not.toHaveLength(0);
    for (const dinner of unplanned) {
      expect(dinner.reason).toMatchObject({ kind: "no_candidate", excluded: { course: 1 } });
    }
  });
});

describe("importing again", () => {
  test("the same file is a visible no-op", async () => {
    const household = await setUpHousehold();
    await importFile(household, sampleExport);
    const before = await recipes(household);

    const again = succeeded<ImportRun>(await importFile(household, sampleExport));

    expect(again).toMatchObject({ id: 2, created: 0, updated: 0, skipped: 5, flagged: 0, errors: [] });
    expect(await recipes(household)).toEqual(before);
    expect(succeeded<ImportRun[]>(await household.callTool("list_import_runs", {})).map((run) => run.id)).toEqual([
      2, 1,
    ]);
  });

  test("a Recipe whose hash changed in Paprika is updated in place", async () => {
    const household = await setUpHousehold();
    await importFile(household, await paprikaExport([toast]));
    const [before] = await recipes(household);

    const run = succeeded<ImportRun>(
      await importFile(
        household,
        await paprikaExport([
          { ...toast, hash: "changed", name: "Crispy Toast", ingredients: "2 slices bread", rating: 5 },
        ]),
      ),
    );

    expect(run).toMatchObject({ created: 0, updated: 1, skipped: 0, flagged: 0 });
    const [after] = await recipes(household);
    expect(after).toMatchObject({
      id: before?.id,
      title: "Crispy Toast",
      ingredients: [{ raw: "2 slices bread" }],
      importedPreference: "positive",
      createdAt: before?.createdAt,
      source: { importedAt: run.startedAt },
    });
  });

  test("a Recipe edited in Mise since its import is flagged for a merge, not overwritten, and only once", async () => {
    const household = await setUpHousehold();
    await importFile(household, await paprikaExport([toast]));
    await household.callTool("update_recipe", { id: 1, title: "Our Toast", yieldsLeftovers: true });
    const changed = await paprikaExport([{ ...toast, hash: "changed", name: "Crispy Toast" }]);

    const run = succeeded<ImportRun>(await importFile(household, changed));
    const again = succeeded<ImportRun>(await importFile(household, changed));

    expect(run).toMatchObject({ created: 0, updated: 0, flagged: 1 });
    expect(again).toMatchObject({ created: 0, updated: 0, skipped: 1, flagged: 0 });
    expect(await recipes(household)).toMatchObject([{ id: 1, title: "Our Toast", yieldsLeftovers: true }]);
    expect(await household.callTool("list_import_flags", {})).toEqual({
      ok: true,
      value: [
        {
          id: 1,
          runId: run.id,
          kind: "merge",
          recipe: { id: 1, title: "Our Toast" },
          duplicateOf: null,
          flaggedAt: run.startedAt,
        },
      ],
    });
  });

  test("a Course corrected in Mise is kept when Paprika's copy changes", async () => {
    const household = await setUpHousehold();
    await importFile(household, await paprikaExport([{ ...toast, categories: ["Snacks"] }]));
    await household.callTool("update_recipe", { id: 1, course: "breakfast" });

    const run = succeeded<ImportRun>(
      await importFile(household, await paprikaExport([{ ...toast, hash: "changed", categories: ["Desserts"] }])),
    );

    expect(run).toMatchObject({ updated: 0, flagged: 1 });
    expect(await recipes(household)).toMatchObject([{ course: "breakfast" }]);
  });

  test("a Recipe not edited in Mise takes the Course of Paprika's changed categories", async () => {
    const household = await setUpHousehold();
    await importFile(household, await paprikaExport([{ ...toast, categories: ["Snacks"] }]));

    await importFile(household, await paprikaExport([{ ...toast, hash: "changed", categories: ["Desserts"] }]));

    expect(await recipes(household)).toMatchObject([{ course: "dessert" }]);
  });

  test("a Recipe Mise changed only by resolving its Ingredients still takes Paprika's changes", async () => {
    const household = await setUpHousehold();
    await importFile(household, await paprikaExport([{ ...toast, ingredients: "1 tbsp beurre" }]));
    await household.callTool("resolve_ingredient", { text: "beurre", item: "butter" });

    const run = succeeded<ImportRun>(
      await importFile(household, await paprikaExport([{ ...toast, hash: "changed", ingredients: "2 tbsp beurre" }])),
    );

    expect(run).toMatchObject({ updated: 1, flagged: 0 });
    expect(await recipes(household)).toMatchObject([{ ingredients: [{ raw: "2 tbsp beurre", item: "butter" }] }]);
  });
});

describe("possible duplicates", () => {
  test("a new Recipe like one from another source is created and flagged, never merged", async () => {
    const household = await setUpHousehold();
    await household.callTool("create_recipe", {
      title: "Weeknight dal!",
      baseServings: 2,
      ingredients: ["200 g red lentils", "3 garlic cloves", "1 onion"],
    });

    const run = succeeded<ImportRun>(await importFile(household, await paprikaExport([dal, chicken])));

    expect(run).toMatchObject({ created: 2, flagged: 1 });
    expect((await recipes(household)).map((recipe) => recipe.title)).toEqual([
      "Sheet-pan Chicken",
      "Weeknight Dal",
      "Weeknight dal!",
    ]);
    expect(await household.callTool("list_import_flags", {})).toMatchObject({
      ok: true,
      value: [
        {
          kind: "duplicate",
          recipe: { id: 2, title: "Weeknight Dal" },
          duplicateOf: { id: 1, title: "Weeknight dal!" },
        },
      ],
    });
  });

  test("the same title with different Ingredients is not a duplicate", async () => {
    const household = await setUpHousehold();
    await household.callTool("create_recipe", {
      title: "Weeknight Dal",
      baseServings: 2,
      ingredients: ["2 cups yellow split peas", "1 tsp turmeric", "1 onion"],
    });

    expect(await importFile(household, await paprikaExport([dal]))).toMatchObject({
      ok: true,
      value: { created: 1, flagged: 0 },
    });
  });

  test("a deleted Recipe takes its flags with it", async () => {
    const household = await setUpHousehold();
    await household.callTool("create_recipe", { title: "Weeknight Dal", baseServings: 2, ingredients: [] });
    await importFile(household, await paprikaExport([dal]));

    await household.callTool("delete_recipe", { id: 1, confirm: true });

    expect(await household.callTool("list_import_flags", {})).toEqual({ ok: true, value: [] });
  });
});

describe("an import never deletes", () => {
  test("a Recipe missing from a later export stays", async () => {
    const household = await setUpHousehold();
    await importFile(household, await paprikaExport([dal, toast]));

    const run = succeeded<ImportRun>(await importFile(household, await paprikaExport([toast])));

    expect(run).toMatchObject({ created: 0, updated: 0, skipped: 1 });
    expect((await recipes(household)).map((recipe) => recipe.title)).toEqual(["Soggy Toast", "Weeknight Dal"]);
  });

  test("a Recipe moved to Paprika's trash stays, unchanged", async () => {
    const household = await setUpHousehold();
    await importFile(household, await paprikaExport([toast]));

    const run = succeeded<ImportRun>(
      await importFile(household, await paprikaExport([{ ...toast, hash: "trashed", in_trash: true }])),
    );

    expect(run).toMatchObject({ updated: 0, skipped: 1 });
    expect(await recipes(household)).toMatchObject([{ title: "Soggy Toast" }]);
  });
});

describe("imported photos", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

  test("are stored once for every Recipe that has them, and kept while any Recipe shows them", async () => {
    const household = await setUpHousehold();
    await importFile(household, await paprikaExport([dal, { ...toast, photo_data: dal.photo_data }]));
    const [toastRecipe, dalRecipe] = await recipes(household);

    await household.callTool("delete_recipe", { id: dalRecipe?.id as number, confirm: true });

    expect(toastRecipe?.photoKey).toBe(dalRecipe?.photoKey);
    expect(await env.BUCKET.head(toastRecipe?.photoKey as string)).not.toBeNull();
  });

  test("a photo changed in Paprika replaces the old one, which is deleted", async () => {
    const household = await setUpHousehold();
    await importFile(household, await paprikaExport([dal]));
    const [before] = await recipes(household);

    await importFile(household, await paprikaExport([{ ...dal, hash: "new photo", photo_data: base64(png) }]));

    const [after] = await recipes(household);
    expect(after?.photoKey).not.toBe(before?.photoKey);
    expect(await env.BUCKET.head(before?.photoKey as string)).toBeNull();
    const served = await household.fetch(`http://mise.example.com/agents/household/household/recipes/1/photo`);
    expect(served.headers.get("Content-Type")).toBe("image/png");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(png);
  });

  test("a photo Paprika now has unusable leaves the Recipe's photo as it was", async () => {
    const household = await setUpHousehold();
    await importFile(household, await paprikaExport([dal]));
    const [before] = await recipes(household);

    const run = succeeded<ImportRun>(
      await importFile(household, await paprikaExport([{ ...dal, hash: "bad photo", photo_data: btoa("hi") }])),
    );

    expect(run).toMatchObject({ updated: 1, errors: [{ message: expect.stringMatching(/not a JPEG/) }] });
    const [after] = await recipes(household);
    expect(after?.photoKey).toBe(before?.photoKey);
    expect(await env.BUCKET.head(before?.photoKey as string)).not.toBeNull();
  });

  test("a Recipe like several from other sources counts as flagged once", async () => {
    const household = await setUpHousehold();
    await household.callTool("create_recipe", { title: "Weeknight Dal", baseServings: 2, ingredients: [] });
    await household.callTool("create_recipe", { title: "Weeknight dal", baseServings: 4, ingredients: [] });

    const run = succeeded<ImportRun>(await importFile(household, await paprikaExport([dal])));

    expect(run).toMatchObject({ created: 1, flagged: 1 });
    expect(succeeded<unknown[]>(await household.callTool("list_import_flags", {}))).toHaveLength(2);
  });

  test("a photo a merge flag left aside is not kept in R2", async () => {
    const household = await setUpHousehold();
    await importFile(household, await paprikaExport([dal]));
    await household.callTool("update_recipe", { id: 1, title: "Our Dal" });

    await importFile(household, await paprikaExport([{ ...dal, hash: "new photo", photo_data: base64(png) }]));

    const listed = await env.BUCKET.list({ prefix: "photos/" });
    expect(listed.objects.map((object) => object.key)).toEqual([(await recipes(household))[0]?.photoKey]);
  });

  test("a photo that is not an image is logged, and its Recipe imported without it", async () => {
    const household = await setUpHousehold();

    const run = succeeded<ImportRun>(
      await importFile(household, await paprikaExport([{ ...toast, photo_data: btoa("hi") }])),
    );

    expect(run).toMatchObject({
      created: 1,
      errors: [
        { entry: "Soggy Toast.paprikarecipe", message: "The photo is not a JPEG, PNG, WebP, GIF or AVIF image" },
      ],
    });
    expect(await recipes(household)).toMatchObject([{ photoKey: null }]);
  });
});

describe("what an import refuses or reports", () => {
  test("entries it cannot read are logged and the rest imported", async () => {
    const household = await setUpHousehold();

    const run = succeeded<ImportRun>(
      await importFile(
        household,
        await paprikaExport([{ entry: "Broken.paprikarecipe", bytes: new Uint8Array([1, 2, 3]) }, toast]),
      ),
    );

    expect(run).toMatchObject({
      created: 1,
      errors: [{ entry: "Broken.paprikarecipe", message: "The file is not JSON" }],
    });
  });

  test("a file that is not an export is logged as such", async () => {
    const household = await setUpHousehold();

    const run = succeeded<ImportRun>(await importFile(household, utf8("hello")));

    expect(run).toMatchObject({
      created: 0,
      errors: [{ entry: null, message: "The file is not a Paprika export (.paprikarecipes)" }],
    });
  });

  test("an upload is imported once, then deleted", async () => {
    const household = await setUpHousehold();
    const response = await household.fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: sampleExport,
    });
    const { upload } = (await response.json()) as { upload: string };

    await household.callTool("run_paprika_import", { upload });

    expect(await household.callTool("run_paprika_import", { upload })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect(await env.BUCKET.list({ prefix: "imports/" })).toMatchObject({ objects: [] });
  });

  test("an upload must be sent as binary, which a form on another site cannot do", async () => {
    const household = await setUpHousehold();

    const response = await household.fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: "hello",
    });

    expect(response.status).toBe(415);
  });

  test("a connected client is told when an import changes Recipes", async () => {
    const household = await setUpHousehold();
    const socket = (
      await household.fetch("http://mise.example.com/agents/household/household", { headers: { Upgrade: "websocket" } })
    ).webSocket as WebSocket;
    socket.accept();
    const notice = new Promise((resolve) => {
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data));
        if (message.type === "mise:change") resolve(message);
      });
    });

    await importFile(household, await paprikaExport([toast]));

    expect(await notice).toEqual({ type: "mise:change", topic: "recipes", revision: 2 });
  });
});
