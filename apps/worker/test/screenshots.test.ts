import { env } from "cloudflare:workers";
import { FakeLlm, type ImportRun, type Recipe, type RecipeReading, type ToolResult } from "@mise/domain";
import { describe, expect, test } from "vitest";
import { SAMPLE_JPEG } from "../../../fixtures/paprika";
import { useFetch } from "../src/links";
import { useLlm } from "../src/llm";

const uploadUrl = "http://mise.example.com/agents/household/household/imports/screenshots";

type HouseholdStub = ReturnType<typeof env.Household.getByName>;

/** The first bytes of a PNG, as a screenshot's; enough for Mise to know it as one. */
const SAMPLE_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

const salad: RecipeReading = {
  isRecipe: true,
  title: "Crunchy Cabbage Salad",
  ingredients: ["½ red cabbage, shredded", "2 carrots, grated", "3 tbsp sesame dressing"],
  steps: ["Toss everything together."],
  servings: 4,
  minutes: 15,
  course: "side",
};

/** The test's households read every source as `reading`; test/setup.ts puts the next test back on a fake. */
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

function put(household: HouseholdStub, bytes: Uint8Array, type: string): Promise<Response> {
  return household.fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": type }, body: bytes });
}

/** Uploads each screenshot as the PWA does; returns their ids, in order. */
async function upload(household: HouseholdStub, ...screenshots: [Uint8Array, string][]): Promise<string[]> {
  const uploads: string[] = [];
  for (const [bytes, type] of screenshots) {
    const response = await put(household, bytes, type);
    if (!response.ok) throw new Error(`Upload refused: ${response.status}`);
    uploads.push(((await response.json()) as { upload: string }).upload);
  }
  return uploads;
}

async function recipe(household: HouseholdStub, id: number): Promise<Recipe> {
  return succeeded<Recipe>(await household.callTool("get_recipe", { id }));
}

describe("importing screenshots", () => {
  test("has the model read them together, in order, into a Draft, and deletes the uploads", async () => {
    const llm = withReading(salad);
    const household = await newHousehold();
    const uploads = await upload(household, [SAMPLE_PNG, "image/png"], [SAMPLE_JPEG, "image/jpeg"]);

    const imported = await household.callTool("import_screenshots", { uploads });

    expect(imported).toMatchObject({
      ok: true,
      value: {
        run: { source: "screenshot", created: 1, errors: [] },
        recipe: { title: "Crunchy Cabbage Salad" },
      },
    });
    expect(llm.readings).toEqual([
      {
        images: [
          { bytes: SAMPLE_PNG, type: "image/png" },
          { bytes: SAMPLE_JPEG, type: "image/jpeg" },
        ],
      },
    ]);
    const { recipe: made } = succeeded<{ recipe: { id: number } }>(imported);
    expect(await recipe(household, made.id)).toMatchObject({
      draft: true,
      course: "side",
      photoKey: null,
      source: { kind: "screenshot" },
      ingredients: [
        { raw: "½ red cabbage, shredded" },
        { raw: "2 carrots, grated" },
        { raw: "3 tbsp sesame dressing" },
      ],
    });
    for (const id of uploads) expect(await env.BUCKET.head(`imports/${id}.screenshot`)).toBeNull();
  });

  test("skips the same screenshots read again", async () => {
    withReading(salad);
    const household = await newHousehold();
    const first = succeeded<{ recipe: { id: number } }>(
      await household.callTool("import_screenshots", { uploads: await upload(household, [SAMPLE_PNG, "image/png"]) }),
    );

    const again = await household.callTool("import_screenshots", {
      uploads: await upload(household, [SAMPLE_PNG, "image/png"]),
    });

    expect(again).toMatchObject({
      ok: true,
      value: { run: { created: 0, skipped: 1 }, recipe: { id: first.recipe.id } },
    });
  });

  test("logs screenshots that hold no recipe, creating nothing", async () => {
    withReading({ isRecipe: false });
    const household = await newHousehold();

    const imported = await household.callTool("import_screenshots", {
      uploads: await upload(household, [SAMPLE_PNG, "image/png"]),
    });

    expect(imported).toMatchObject({
      ok: true,
      value: {
        run: { source: "screenshot", created: 0, errors: [{ entry: null, message: "The screenshots hold no recipe" }] },
        recipe: null,
      },
    });
  });

  test("fills a link-only Draft, which keeps its link", async () => {
    useFetch(async () => new Response("Not found", { status: 404 }));
    withReading(salad);
    const household = await newHousehold();
    const reel = "https://www.instagram.com/reel/Cabc123_-x/";
    const { recipe: linkOnly } = succeeded<{ recipe: { id: number } }>(
      await household.callTool("import_url", { url: reel }),
    );

    const filled = await household.callTool("import_screenshots", {
      uploads: await upload(household, [SAMPLE_PNG, "image/png"]),
      draft: linkOnly.id,
    });

    expect(filled).toMatchObject({
      ok: true,
      value: {
        run: { source: "screenshot", created: 0, updated: 1 },
        recipe: { id: linkOnly.id, title: "Crunchy Cabbage Salad" },
      },
    });
    expect(await recipe(household, linkOnly.id)).toMatchObject({
      draft: true,
      source: { kind: "instagram", url: reel },
      ingredients: [
        { raw: "½ red cabbage, shredded" },
        { raw: "2 carrots, grated" },
        { raw: "3 tbsp sesame dressing" },
      ],
    });
  });

  test("refuses a Recipe that is no link-only Draft, or an upload that isn't there, without asking the model", async () => {
    const llm = withReading(salad);
    const household = await newHousehold();
    const kept = succeeded<Recipe>(
      await household.callTool("create_recipe", { title: "Slaw", baseServings: 4, ingredients: ["1 cabbage"] }),
    );

    expect(
      await household.callTool("import_screenshots", {
        uploads: await upload(household, [SAMPLE_PNG, "image/png"]),
        draft: kept.id,
      }),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await household.callTool("import_screenshots", { uploads: [crypto.randomUUID()] })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect(llm.readings).toEqual([]);
  });

  test("refuses with model_failed when the model fails, logging nothing", async () => {
    const llm = withReading(salad);
    llm.failing = true;
    const household = await newHousehold();

    expect(
      await household.callTool("import_screenshots", { uploads: await upload(household, [SAMPLE_PNG, "image/png"]) }),
    ).toMatchObject({ ok: false, error: { code: "model_failed" } });
    expect(succeeded<ImportRun[]>(await household.callTool("list_import_runs", {}))).toEqual([]);
  });

  test("refuses an upload that is not an image the model reads", async () => {
    withReading(salad);
    const household = await newHousehold();

    expect((await put(household, SAMPLE_PNG, "image/avif")).status).toBe(415);
    expect((await put(household, SAMPLE_PNG, "text/plain")).status).toBe(415);
    expect((await put(household, new Uint8Array(5 * 1024 * 1024 + 1), "image/png")).status).toBe(413);
    expect((await household.fetch(uploadUrl)).status).toBe(405);
    // Sent as a PNG, but not one: refused when read, before the model sees it.
    const [notAnImage] = await upload(household, [new Uint8Array([1, 2, 3]), "image/png"]);
    expect(await household.callTool("import_screenshots", { uploads: [notAnImage] })).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
  });
});
