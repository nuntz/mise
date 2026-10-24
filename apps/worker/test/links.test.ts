import { env } from "cloudflare:workers";
import {
  type Draft,
  FakeLlm,
  type ImportFlag,
  type Recipe,
  type RecipeReading,
  type ToolOutput,
  type ToolResult,
} from "@mise/domain";
import { beforeEach, describe, expect, test } from "vitest";
import noJsonLd from "../../../fixtures/pages/no-json-ld.html?raw";
import yoastGraph from "../../../fixtures/pages/yoast-graph.html?raw";
import { SAMPLE_JPEG } from "../../../fixtures/paprika";
import { useFetch } from "../src/links";
import { useLlm } from "../src/llm";

type HouseholdStub = ReturnType<typeof env.Household.getByName>;

const DAL_URL = "https://kitchen.example.com/recipes/red-lentil-dal/";
const SHARED_DAL_URL = `${DAL_URL}?utm_source=share`;
const DAL_PHOTO = "https://kitchen.example.com/wp-content/uploads/dal-1x1.jpg";

/**
 * A pretend web for the test's households: each URL answers with its response, made afresh per
 * request; any other URL is not found. Returns the URLs requested, in order.
 */
function serve(web: Record<string, () => Response>): string[] {
  const requested: string[] = [];
  useFetch(async (input, init) => {
    const request = new Request(input, init);
    requested.push(request.url);
    return web[request.url]?.() ?? new Response("Not found", { status: 404 });
  });
  return requested;
}

const PIE_URL = "https://blog.example.org/2026/04/shepherds-pie";
const PIE_PHOTO = "https://blog.example.org/photos/shepherds-pie.jpg";

const pie: RecipeReading = {
  isRecipe: true,
  title: "My Nan's Shepherd's Pie",
  ingredients: ["500 g lamb mince", "1 onion, diced", "1 kg potatoes"],
  steps: ["Brown the mince.", "Top with mash and bake."],
  servings: 6,
  minutes: null,
  course: "main",
};

/** The test's households read every page as `reading`; test/setup.ts puts the next test back on a fake. */
function withReading(reading: RecipeReading): FakeLlm {
  const llm = new FakeLlm();
  llm.reading = reading;
  useLlm(() => llm);
  return llm;
}

const html = (body: string) => () => new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8" } });
const jpeg = () => new Response(SAMPLE_JPEG, { headers: { "Content-Type": "image/jpeg" } });

async function newHousehold(): Promise<HouseholdStub> {
  const household = env.Household.getByName(crypto.randomUUID());
  await household.callTool("setup_household", { name: "The Example Family", weekStartsOn: "monday" });
  return household;
}

function succeeded<T>(result: ToolResult<unknown>): T {
  if (!result.ok) throw new Error(`Expected the tool call to succeed: ${result.error.message}`);
  return result.value as T;
}

async function importUrl(household: HouseholdStub, url: string): Promise<ToolOutput<"import_url">> {
  return succeeded<ToolOutput<"import_url">>(await household.callTool("import_url", { url }));
}

async function recipe(household: HouseholdStub, id: number): Promise<Recipe> {
  return succeeded<Recipe>(await household.callTool("get_recipe", { id }));
}

beforeEach(async () => {
  const listed = await env.BUCKET.list({ prefix: "photos/" });
  if (listed.objects.length > 0) await env.BUCKET.delete(listed.objects.map((object) => object.key));
});

describe("importing a link", () => {
  test("makes a Recipe of a page's schema.org Recipe, with its photo, at the page's canonical URL", async () => {
    serve({ [SHARED_DAL_URL]: html(yoastGraph), [DAL_PHOTO]: jpeg });
    const household = await newHousehold();

    const imported = await importUrl(household, SHARED_DAL_URL);

    expect(imported).toMatchObject({
      run: { source: "url", created: 1, updated: 0, skipped: 0, flagged: 0, errors: [] },
      recipe: { title: "Weeknight Red Lentil Dal & Rice", draft: false, linkOnly: false },
    });
    const dal = await recipe(household, imported.recipe.id);
    expect(dal).toMatchObject({
      draft: false,
      baseServings: 4,
      effortMinutes: 45,
      course: "main",
      source: { kind: "url", url: DAL_URL, author: "Alex Example" },
    });
    expect(dal.ingredients.slice(0, 2)).toMatchObject([
      { raw: "1 cup red lentils, rinsed", item: "dried_lentils" },
      { raw: "2 tbsp ghee", item: "ghee" },
    ]);
    const photo = (await env.BUCKET.get(dal.photoKey as string)) as R2ObjectBody;
    expect(new Uint8Array(await photo.arrayBuffer())).toEqual(SAMPLE_JPEG);
  });

  test("has the model read a page without a schema.org Recipe into a Draft, with the page's photo", async () => {
    serve({ [PIE_URL]: html(noJsonLd), [PIE_PHOTO]: jpeg });
    const llm = withReading(pie);
    const household = await newHousehold();

    const imported = await importUrl(household, PIE_URL);

    expect(imported).toMatchObject({
      run: { source: "url", created: 1, errors: [] },
      recipe: { title: "My Nan's Shepherd's Pie", draft: true, linkOnly: false },
    });
    expect(llm.readings).toHaveLength(1);
    expect(llm.readings[0]?.text).toMatch(/^My Nan's Shepherd's Pie\nEvery Sunday/);
    const draft = await recipe(household, imported.recipe.id);
    expect(draft).toMatchObject({
      draft: true,
      baseServings: 6,
      course: "main",
      source: { kind: "url", url: PIE_URL },
      ingredients: [{ raw: "500 g lamb mince" }, { raw: "1 onion, diced" }, { raw: "1 kg potatoes" }],
    });
    expect(draft.photoKey).not.toBeNull();
    expect(succeeded<Draft[]>(await household.callTool("list_drafts", {}))).toHaveLength(1);
  });

  test("keeps a link the site refuses as a link-only Draft, titled from the link, without asking the model", async () => {
    const blocked = "https://recipes.example.com/12345-sticky-toffee-pudding";
    serve({ [blocked]: () => new Response("Access denied", { status: 403 }) });
    const llm = withReading(pie);
    const household = await newHousehold();

    const imported = await importUrl(household, blocked);

    expect(imported).toMatchObject({
      run: { created: 1, errors: [{ entry: blocked, message: "The page was refused by its site (HTTP 403)" }] },
      recipe: { title: "Sticky toffee pudding", draft: true, linkOnly: true },
    });
    expect(await recipe(household, imported.recipe.id)).toMatchObject({
      ingredients: [],
      steps: [],
      photoKey: null,
      source: { kind: "url", url: blocked },
    });
    expect(llm.readings).toEqual([]);
  });

  test("keeps a page that holds no recipe as a link-only Draft with its title and thumbnail", async () => {
    serve({ [PIE_URL]: html(noJsonLd), [PIE_PHOTO]: jpeg });
    withReading({ isRecipe: false });
    const household = await newHousehold();

    const imported = await importUrl(household, PIE_URL);

    expect(imported).toMatchObject({
      run: { created: 1, errors: [{ entry: PIE_URL, message: "The page holds no recipe" }] },
      recipe: { title: "My Nan's Shepherd’s Pie", draft: true, linkOnly: true },
    });
    expect((await recipe(household, imported.recipe.id)).photoKey).not.toBeNull();
  });

  test("keeps a page the model fails to read as a link-only Draft, and reads it again next time", async () => {
    serve({ [PIE_URL]: html(noJsonLd), [PIE_PHOTO]: jpeg });
    const llm = withReading(pie);
    llm.failing = true;
    const household = await newHousehold();

    const first = await importUrl(household, PIE_URL);
    llm.failing = false;
    const again = await importUrl(household, PIE_URL);

    expect(first).toMatchObject({ run: { created: 1, errors: [{ entry: PIE_URL }] }, recipe: { linkOnly: true } });
    expect(again).toMatchObject({
      run: { created: 0, updated: 1 },
      recipe: { id: first.recipe.id, title: "My Nan's Shepherd's Pie", linkOnly: false },
    });
  });

  test("skips an unchanged page imported again, without fetching its photo or asking the model again", async () => {
    const requested = serve({ [DAL_URL]: html(yoastGraph), [DAL_PHOTO]: jpeg, [PIE_URL]: html(noJsonLd) });
    const llm = withReading(pie);
    const household = await newHousehold();
    const dal = await importUrl(household, DAL_URL);
    const draft = await importUrl(household, PIE_URL);
    requested.length = 0;

    const dalAgain = await importUrl(household, `${DAL_URL}#comments`);
    const draftAgain = await importUrl(household, PIE_URL);

    expect(dalAgain).toMatchObject({ run: { created: 0, updated: 0, skipped: 1 }, recipe: { id: dal.recipe.id } });
    expect(draftAgain).toMatchObject({ run: { created: 0, updated: 0, skipped: 1 }, recipe: { id: draft.recipe.id } });
    expect(requested).toEqual([`${DAL_URL}#comments`, PIE_URL]);
    expect(llm.readings).toHaveLength(1);
  });

  test("updates a Recipe whose page changed, and flags it instead once it was edited in Mise", async () => {
    let page = yoastGraph;
    serve({ [DAL_URL]: () => html(page)(), [DAL_PHOTO]: jpeg });
    const household = await newHousehold();
    const { recipe: dal } = await importUrl(household, DAL_URL);

    page = yoastGraph.replace("2 tbsp ghee", "3 tbsp ghee");
    const updated = await importUrl(household, DAL_URL);
    await household.callTool("update_recipe", { id: dal.id, course: "side" });
    page = yoastGraph.replace("2 tbsp ghee", "4 tbsp ghee");
    const flagged = await importUrl(household, DAL_URL);

    expect(updated).toMatchObject({ run: { updated: 1 } });
    expect(flagged).toMatchObject({ run: { updated: 0, flagged: 1 } });
    expect((await recipe(household, dal.id)).ingredients[1]?.raw).toBe("3 tbsp ghee");
    expect(succeeded<ImportFlag[]>(await household.callTool("list_import_flags", {}))).toMatchObject([
      { kind: "merge", recipe: { id: dal.id } },
    ]);
  });

  test("never lets what the model read replace a Draft a person accepted, flagging it instead", async () => {
    let page = noJsonLd;
    serve({ [PIE_URL]: () => html(page)() });
    withReading(pie);
    const household = await newHousehold();
    const { recipe: draft } = await importUrl(household, PIE_URL);
    await household.callTool("accept_draft", { id: draft.id });

    page = noJsonLd.replace("It serves 6.", "It serves 8.");
    const again = await importUrl(household, PIE_URL);

    expect(again).toMatchObject({ run: { updated: 0, flagged: 1 }, recipe: { id: draft.id, draft: false } });
  });

  test("fills a link-only Draft once its page can be read, on the link it was shared as", async () => {
    let blocked = true;
    serve({
      [SHARED_DAL_URL]: () => (blocked ? new Response("Busy", { status: 503 }) : html(yoastGraph)()),
      [DAL_PHOTO]: jpeg,
    });
    const household = await newHousehold();
    const { recipe: linkOnly } = await importUrl(household, SHARED_DAL_URL);

    blocked = false;
    const read = await importUrl(household, SHARED_DAL_URL);

    expect(linkOnly).toMatchObject({ linkOnly: true });
    expect(read).toMatchObject({
      run: { created: 0, updated: 1 },
      recipe: { id: linkOnly.id, title: "Weeknight Red Lentil Dal & Rice", draft: false, linkOnly: false },
    });
  });

  test("keeps what it read of a page that can no longer be fetched", async () => {
    let blocked = false;
    serve({
      [DAL_URL]: () => (blocked ? new Response("Busy", { status: 503 }) : html(yoastGraph)()),
      [DAL_PHOTO]: jpeg,
    });
    const household = await newHousehold();
    const { recipe: dal } = await importUrl(household, DAL_URL);

    blocked = true;
    const again = await importUrl(household, DAL_URL);

    expect(again).toMatchObject({
      run: { created: 0, updated: 0, skipped: 1, errors: [{ entry: DAL_URL }] },
      recipe: { id: dal.id, title: "Weeknight Red Lentil Dal & Rice", linkOnly: false },
    });
    expect((await recipe(household, dal.id)).ingredients).toHaveLength(7);
  });

  test("follows a redirect to the page", async () => {
    const short = "https://short.example.com/dal";
    serve({
      [short]: () => new Response(null, { status: 301, headers: { Location: DAL_URL } }),
      [DAL_URL]: html(yoastGraph),
      [DAL_PHOTO]: jpeg,
    });
    const household = await newHousehold();

    const imported = await importUrl(household, short);

    expect(imported).toMatchObject({ recipe: { draft: false } });
    expect(await recipe(household, imported.recipe.id)).toMatchObject({ source: { url: DAL_URL } });
  });

  test("keeps a link as a link-only Draft however its fetch fails", async () => {
    const broken = (body: ReadableStream) => () => new Response(body, { headers: { "Content-Type": "text/html" } });
    const failing: Record<string, () => Response> = {
      "https://cut.example.com/dal": broken(
        new ReadableStream({
          pull: (controller) => controller.error(new Error("The connection was reset")),
        }),
      ),
      "https://loop.example.com/dal": () => new Response(null, { status: 302, headers: { Location: "http://[bad" } }),
      "https://huge.example.com/dal": () =>
        new Response("<html></html>", { headers: { "Content-Type": "text/html", "Content-Length": "999999999" } }),
    };
    const requested = serve(failing);
    // Real fetch rejects when a site can't be reached, as for an unknown host.
    useFetch(async (input, init) => {
      const url = new Request(input, init).url;
      if (url.startsWith("https://nowhere.example.com/")) throw new TypeError("Network connection lost");
      requested.push(url);
      return failing[url]?.() ?? new Response("Not found", { status: 404 });
    });
    const household = await newHousehold();

    for (const link of [...Object.keys(failing), "https://nowhere.example.com/dal"]) {
      expect(await importUrl(household, link)).toMatchObject({
        run: { created: 1, errors: [{ entry: link }] },
        recipe: { linkOnly: true },
      });
    }
  });

  test("refuses anything but a web link", async () => {
    const household = await newHousehold();

    expect(await household.callTool("import_url", { url: "file:///etc/passwd" })).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
  });
});

describe("filling a link-only Draft with pasted text", () => {
  test("reads the text into the Draft, which keeps its link, and a later read of the page flags it", async () => {
    let blocked = true;
    serve({
      [DAL_URL]: () => (blocked ? new Response("Busy", { status: 503 }) : html(yoastGraph)()),
      [DAL_PHOTO]: jpeg,
    });
    const llm = withReading(pie);
    const household = await newHousehold();
    const { recipe: linkOnly } = await importUrl(household, DAL_URL);

    const filled = await household.callTool("import_text", {
      text: "Shepherd's pie: 500 g lamb mince…",
      draft: linkOnly.id,
    });

    expect(filled).toMatchObject({
      ok: true,
      value: {
        run: { source: "text", created: 0, updated: 1 },
        recipe: { id: linkOnly.id, title: "My Nan's Shepherd's Pie" },
      },
    });
    expect(llm.readings).toEqual([{ text: "Shepherd's pie: 500 g lamb mince…" }]);
    expect(await recipe(household, linkOnly.id)).toMatchObject({
      draft: true,
      baseServings: 6,
      source: { kind: "url", url: DAL_URL },
      ingredients: [{ raw: "500 g lamb mince" }, { raw: "1 onion, diced" }, { raw: "1 kg potatoes" }],
      notes: "Shepherd's pie: 500 g lamb mince…",
    });
    blocked = false;
    expect(await importUrl(household, DAL_URL)).toMatchObject({
      run: { updated: 0, flagged: 1 },
      recipe: { id: linkOnly.id, linkOnly: false },
    });
  });

  test("flags a filled Draft that looks like a Recipe already kept, as a new Draft is flagged", async () => {
    serve({ [DAL_URL]: () => new Response("Busy", { status: 503 }) });
    withReading(pie);
    const household = await newHousehold();
    const kept = succeeded<Recipe>(
      await household.callTool("create_recipe", {
        title: "My nan's shepherd's pie",
        baseServings: 6,
        ingredients: ["500 g lamb mince", "1 onion, diced", "1 kg potatoes"],
      }),
    );
    const { recipe: linkOnly } = await importUrl(household, DAL_URL);

    const filled = await household.callTool("import_text", { text: "Shepherd's pie…", draft: linkOnly.id });

    expect(filled).toMatchObject({ ok: true, value: { run: { updated: 1, flagged: 1 } } });
    expect(succeeded<Draft[]>(await household.callTool("list_drafts", {}))).toMatchObject([
      { recipe: { id: linkOnly.id }, duplicateOf: [{ id: kept.id, title: "My nan's shepherd's pie" }] },
    ]);
  });

  test("refuses a Recipe that is no link-only Draft, without asking the model", async () => {
    serve({ [DAL_URL]: html(yoastGraph), [DAL_PHOTO]: jpeg });
    const llm = withReading(pie);
    const household = await newHousehold();
    const { recipe: dal } = await importUrl(household, DAL_URL);

    expect(await household.callTool("import_text", { text: "1 cup lentils", draft: dal.id })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect(llm.readings).toEqual([]);
  });
});
